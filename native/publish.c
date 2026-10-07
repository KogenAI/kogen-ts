#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include "publish.h"

#include "host.h"

#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define TEMP_NAME_BYTES 96u
#define TEMP_CREATE_ATTEMPTS 128u

static atomic_ulong temporary_sequence = 0;

#ifdef KOGEN_FS_PUBLISH_TESTING
static kogen_fs_publish_test_hook publish_test_hook;
static void *publish_test_hook_context;

void kogen_fs_publish_set_test_hook(kogen_fs_publish_test_hook hook,
	void *context) {
	publish_test_hook = hook;
	publish_test_hook_context = context;
}

static void publish_phase(enum kogen_fs_publish_phase phase) {
	if (publish_test_hook != NULL)
		publish_test_hook(phase, publish_test_hook_context);
}
#else
static void publish_phase(enum kogen_fs_publish_phase phase) {
	(void)phase;
}
#endif

static enum kogen_fs_status status_for_errno(int error) {
	switch (error) {
	case ENOENT:
	case ENOTDIR:
		return KOGEN_FS_NOT_FOUND;
	case EACCES:
	case EPERM:
		return KOGEN_FS_PERMISSION;
	case ENAMETOOLONG:
		return KOGEN_FS_LIMIT;
	case ELOOP:
	case EINVAL:
	case EILSEQ:
		return KOGEN_FS_INVALID_PATH;
	default:
		return KOGEN_FS_IO;
	}
}

static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static uint16_t read_u16be(const uint8_t *bytes) {
	return (uint16_t)(((uint16_t)bytes[0] << 8) | (uint16_t)bytes[1]);
}

static int valid_bytes(const uint8_t *bytes, size_t length) {
	return (bytes != NULL || length == 0) &&
		(length == 0 || memchr(bytes, '\0', length) == NULL);
}

static int write_all(int fd, const uint8_t *bytes, size_t length) {
	size_t offset = 0;
	while (offset < length) {
		ssize_t count = write(fd, bytes + offset, length - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count < 0 && errno == EINTR) continue;
		if (count == 0) errno = EIO;
		return -1;
	}
	return 0;
}

/* Open every parent component from the anchored root, rejecting links. */
static enum kogen_fs_status open_parent(const struct kogen_fs_root *root,
	const uint8_t *path, size_t path_length, int *parent_fd_out,
	char **name_out) {
	*parent_fd_out = -1;
	*name_out = NULL;
	if (path == NULL || path_length == 0 ||
		path_length > KOGEN_FS_MAX_PATH_BYTES || path[0] == '/' ||
		!valid_bytes(path, path_length))
		return KOGEN_FS_INVALID_PATH;

	int current = dup(root->fd);
	if (current < 0) return status_for_errno(errno);
	size_t start = 0;
	for (size_t index = 0; index <= path_length; index++) {
		if (index != path_length && path[index] != '/') continue;
		size_t component_length = index - start;
		if (component_length == 0 || component_length > KOGEN_FS_MAX_PATH_BYTES) {
			close(current);
			return KOGEN_FS_INVALID_PATH;
		}
		if ((component_length == 1 && path[start] == '.') ||
			(component_length == 2 && path[start] == '.' &&
				path[start + 1] == '.')) {
			close(current);
			return KOGEN_FS_OUTSIDE_ROOT;
		}
		if (index == path_length) {
			char *name = malloc(component_length + 1u);
			if (name == NULL) {
				close(current);
				return KOGEN_FS_IO;
			}
			memcpy(name, path + start, component_length);
			name[component_length] = '\0';
			*parent_fd_out = current;
			*name_out = name;
			return KOGEN_FS_OK;
		}

		char *component = malloc(component_length + 1u);
		if (component == NULL) {
			close(current);
			return KOGEN_FS_IO;
		}
		memcpy(component, path + start, component_length);
		component[component_length] = '\0';
		struct stat metadata;
		if (fstatat(current, component, &metadata, AT_SYMLINK_NOFOLLOW) < 0) {
			int saved_error = errno;
			free(component);
			close(current);
			return status_for_errno(saved_error);
		}
		if (S_ISLNK(metadata.st_mode)) {
			free(component);
			close(current);
			return KOGEN_FS_INVALID_PATH;
		}
		if (!S_ISDIR(metadata.st_mode)) {
			free(component);
			close(current);
			return KOGEN_FS_NOT_REGULAR;
		}
		int next = openat(current, component,
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		int saved_error = errno;
		free(component);
		if (next < 0) {
			close(current);
			return status_for_errno(saved_error);
		}
		struct stat opened;
		if (fstat(next, &opened) < 0) {
			saved_error = errno;
			close(next);
			close(current);
			return status_for_errno(saved_error);
		}
		if (!S_ISDIR(opened.st_mode)) {
			close(next);
			close(current);
			return KOGEN_FS_NOT_REGULAR;
		}
		close(current);
		current = next;
		start = index + 1u;
	}
	close(current);
	return KOGEN_FS_INVALID_PATH;
}

static enum kogen_fs_status inspect_final(int parent_fd, const char *name,
	int *exists_out, struct stat *metadata_out) {
	if (fstatat(parent_fd, name, metadata_out, AT_SYMLINK_NOFOLLOW) == 0) {
		*exists_out = 1;
		return KOGEN_FS_OK;
	}
	if (errno == ENOENT) {
		*exists_out = 0;
		memset(metadata_out, 0, sizeof(*metadata_out));
		return KOGEN_FS_OK;
	}
	return status_for_errno(errno);
}

static int make_temporary_name(char name[TEMP_NAME_BYTES]) {
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return -1;
	unsigned long sequence = atomic_fetch_add_explicit(&temporary_sequence, 1,
		memory_order_relaxed);
	int count = snprintf(name, TEMP_NAME_BYTES, ".kogen-pub-%ld-%llx-%lx",
		(long)getpid(), (unsigned long long)now.tv_nsec, sequence);
	if (count < 0 || (size_t)count >= TEMP_NAME_BYTES) {
		errno = EOVERFLOW;
		return -1;
	}
	return 0;
}

static enum kogen_fs_status create_temporary_file(int parent_fd,
	char name[TEMP_NAME_BYTES], int *fd_out) {
	for (unsigned int attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt++) {
		if (make_temporary_name(name) < 0) return status_for_errno(errno);
		int fd = openat(parent_fd, name,
			O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
		if (fd >= 0) {
			*fd_out = fd;
			return KOGEN_FS_OK;
		}
		if (errno != EEXIST) return status_for_errno(errno);
	}
	return KOGEN_FS_IO;
}

static enum kogen_fs_status create_temporary_symlink(int parent_fd,
	const uint8_t *target, size_t target_length,
	char name[TEMP_NAME_BYTES]) {
	char *target_string = malloc(target_length + 1u);
	if (target_string == NULL) return KOGEN_FS_IO;
	memcpy(target_string, target, target_length);
	target_string[target_length] = '\0';
	enum kogen_fs_status status = KOGEN_FS_IO;
	for (unsigned int attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt++) {
		if (make_temporary_name(name) < 0) {
			status = status_for_errno(errno);
			break;
		}
		if (symlinkat(target_string, parent_fd, name) == 0) {
			status = KOGEN_FS_OK;
			break;
		}
		if (errno != EEXIST) {
			status = status_for_errno(errno);
			break;
		}
	}
	free(target_string);
	return status;
}

static enum kogen_fs_status atomic_regular_replace(int parent_fd,
	const char *name, const uint8_t *data, size_t data_length, mode_t mode,
	int allow_final_symlink) {
	struct stat existing;
	int exists = 0;
	enum kogen_fs_status status = inspect_final(parent_fd, name, &exists,
		&existing);
	if (status != KOGEN_FS_OK) return status;
	if (exists) {
		if (S_ISDIR(existing.st_mode)) return KOGEN_FS_NOT_REGULAR;
		if (S_ISLNK(existing.st_mode) && !allow_final_symlink)
			return KOGEN_FS_INVALID_PATH;
		if (!S_ISREG(existing.st_mode) && !S_ISLNK(existing.st_mode))
			return KOGEN_FS_NOT_REGULAR;
	}

	char temporary[TEMP_NAME_BYTES];
	int fd = -1;
	status = create_temporary_file(parent_fd, temporary, &fd);
	if (status != KOGEN_FS_OK) return status;
	publish_phase(KOGEN_FS_PUBLISH_PHASE_TEMP_CREATED);
	if (write_all(fd, data, data_length) < 0) {
		int saved_error = errno;
		close(fd);
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_DATA_WRITTEN);
	if (fchmod(fd, mode) < 0 || fsync(fd) < 0) {
		int saved_error = errno;
		close(fd);
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_FILE_SYNCED);
	if (close(fd) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	if (renameat(parent_fd, temporary, parent_fd, name) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_RENAMED);
	if (fsync(parent_fd) < 0) return status_for_errno(errno);
	publish_phase(KOGEN_FS_PUBLISH_PHASE_PARENT_SYNCED);
	return KOGEN_FS_OK;
}

static enum kogen_fs_status append_existing(int parent_fd, const char *name,
	const uint8_t *data, size_t data_length) {
	int fd = openat(parent_fd, name,
		O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
	if (fd < 0) return status_for_errno(errno);
	struct stat metadata;
	if (fstat(fd, &metadata) < 0) {
		int saved_error = errno;
		close(fd);
		return status_for_errno(saved_error);
	}
	if (!S_ISREG(metadata.st_mode)) {
		close(fd);
		return KOGEN_FS_NOT_REGULAR;
	}
	if (flock(fd, LOCK_EX) < 0) {
		int saved_error = errno;
		close(fd);
		return status_for_errno(saved_error);
	}
	enum kogen_fs_status status = KOGEN_FS_OK;
	if (fchmod(fd, 0600) < 0 || write_all(fd, data, data_length) < 0 ||
		fsync(fd) < 0)
		status = status_for_errno(errno);
	(void)flock(fd, LOCK_UN);
	if (close(fd) < 0 && status == KOGEN_FS_OK)
		status = status_for_errno(errno);
	if (status == KOGEN_FS_OK && fsync(parent_fd) < 0)
		status = status_for_errno(errno);
	return status;
}

static enum kogen_fs_status append_new(int parent_fd, const char *name,
	const uint8_t *data, size_t data_length) {
	char temporary[TEMP_NAME_BYTES];
	int fd = -1;
	enum kogen_fs_status status = create_temporary_file(parent_fd, temporary,
		&fd);
	if (status != KOGEN_FS_OK) return status;
	publish_phase(KOGEN_FS_PUBLISH_PHASE_TEMP_CREATED);
	if (write_all(fd, data, data_length) < 0 || fchmod(fd, 0600) < 0 ||
		fsync(fd) < 0) {
		int saved_error = errno;
		close(fd);
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_DATA_WRITTEN);
	publish_phase(KOGEN_FS_PUBLISH_PHASE_FILE_SYNCED);
	if (close(fd) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	if (linkat(parent_fd, temporary, parent_fd, name, 0) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		if (saved_error == EEXIST) return KOGEN_FS_NOT_FOUND;
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_RENAMED);
	if (unlinkat(parent_fd, temporary, 0) < 0) return status_for_errno(errno);
	if (fsync(parent_fd) < 0) return status_for_errno(errno);
	publish_phase(KOGEN_FS_PUBLISH_PHASE_PARENT_SYNCED);
	return KOGEN_FS_OK;
}

static enum kogen_fs_status append_bytes(int parent_fd, const char *name,
	const uint8_t *data, size_t data_length) {
	for (unsigned int attempt = 0; attempt < 4u; attempt++) {
		struct stat existing;
		int exists = 0;
		enum kogen_fs_status status = inspect_final(parent_fd, name, &exists,
			&existing);
		if (status != KOGEN_FS_OK) return status;
		if (exists) {
			if (S_ISLNK(existing.st_mode)) return KOGEN_FS_INVALID_PATH;
			if (!S_ISREG(existing.st_mode)) return KOGEN_FS_NOT_REGULAR;
			status = append_existing(parent_fd, name, data, data_length);
			if (status == KOGEN_FS_NOT_FOUND) continue;
			return status;
		}
		status = append_new(parent_fd, name, data, data_length);
		if (status == KOGEN_FS_NOT_FOUND) continue;
		return status;
	}
	return KOGEN_FS_IO;
}

static enum kogen_fs_status remove_entry(int parent_fd, const char *name) {
	struct stat metadata;
	int exists = 0;
	enum kogen_fs_status status = inspect_final(parent_fd, name, &exists,
		&metadata);
	if (status != KOGEN_FS_OK) return status;
	if (!exists) return KOGEN_FS_OK;
	int flags = S_ISDIR(metadata.st_mode) ? AT_REMOVEDIR : 0;
	if (unlinkat(parent_fd, name, flags) < 0) {
		if (errno == ENOTEMPTY || errno == EEXIST || errno == EISDIR)
			return KOGEN_FS_NOT_REGULAR;
		return status_for_errno(errno);
	}
	return fsync(parent_fd) < 0 ? status_for_errno(errno) : KOGEN_FS_OK;
}

static enum kogen_fs_status restore_symlink(int parent_fd, const char *name,
	const uint8_t *target, size_t target_length) {
	struct stat existing;
	int exists = 0;
	enum kogen_fs_status status = inspect_final(parent_fd, name, &exists,
		&existing);
	if (status != KOGEN_FS_OK) return status;
	if (exists && S_ISDIR(existing.st_mode)) return KOGEN_FS_NOT_REGULAR;
	if (exists && !S_ISREG(existing.st_mode) && !S_ISLNK(existing.st_mode))
		return KOGEN_FS_NOT_REGULAR;
	char temporary[TEMP_NAME_BYTES];
	status = create_temporary_symlink(parent_fd, target, target_length,
		temporary);
	if (status != KOGEN_FS_OK) return status;
	publish_phase(KOGEN_FS_PUBLISH_PHASE_TEMP_CREATED);
	if (fsync(parent_fd) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_FILE_SYNCED);
	if (renameat(parent_fd, temporary, parent_fd, name) < 0) {
		int saved_error = errno;
		unlinkat(parent_fd, temporary, 0);
		return status_for_errno(saved_error);
	}
	publish_phase(KOGEN_FS_PUBLISH_PHASE_RENAMED);
	if (fsync(parent_fd) < 0) return status_for_errno(errno);
	publish_phase(KOGEN_FS_PUBLISH_PHASE_PARENT_SYNCED);
	return KOGEN_FS_OK;
}

static enum kogen_fs_status restore_directory(int parent_fd,
	const char *name) {
	struct stat existing;
	int exists = 0;
	enum kogen_fs_status status = inspect_final(parent_fd, name, &exists,
		&existing);
	if (status != KOGEN_FS_OK) return status;
	if (exists && !S_ISDIR(existing.st_mode))
		return S_ISLNK(existing.st_mode) ? KOGEN_FS_INVALID_PATH
			: KOGEN_FS_NOT_REGULAR;
	if (!exists && mkdirat(parent_fd, name, 0700) < 0)
		return status_for_errno(errno);
	int directory = openat(parent_fd, name,
		O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (directory < 0) return status_for_errno(errno);
	if (fchmod(directory, 0700) < 0 || fsync(directory) < 0) {
		int saved_error = errno;
		close(directory);
		return status_for_errno(saved_error);
	}
	close(directory);
	return fsync(parent_fd) < 0 ? status_for_errno(errno) : KOGEN_FS_OK;
}

static enum kogen_fs_status restore_entry(int parent_fd, const char *name,
	uint8_t kind, mode_t mode, const uint8_t *data, size_t data_length) {
	switch (kind) {
	case KOGEN_FS_RESTORE_REGULAR:
		if (mode != 0600 && mode != 0700) return KOGEN_FS_INVALID_PATH;
		return atomic_regular_replace(parent_fd, name, data, data_length,
			mode, 1);
	case KOGEN_FS_RESTORE_SYMLINK:
		if (data_length == 0 || data_length > KOGEN_FS_MAX_PATH_BYTES ||
			!valid_bytes(data, data_length))
			return KOGEN_FS_INVALID_PATH;
		if (mode != 0) return KOGEN_FS_INVALID_PATH;
		return restore_symlink(parent_fd, name, data, data_length);
	case KOGEN_FS_RESTORE_DIRECTORY:
		if (mode != 0 || data_length != 0) return KOGEN_FS_INVALID_PATH;
		return restore_directory(parent_fd, name);
	case KOGEN_FS_RESTORE_ABSENT:
		if (mode != 0 || data_length != 0) return KOGEN_FS_INVALID_PATH;
		return remove_entry(parent_fd, name);
	default:
		return KOGEN_FS_INVALID_PATH;
	}
}

/* See publish.h for the bounded binary request layout. */
enum kogen_fs_status kogen_fs_handle_publish_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length) {
	if (response_length == NULL) return KOGEN_FS_INVALID_PATH;
	*response_length = 0;
	if (response == NULL || response_capacity < 1u) return KOGEN_FS_INVALID_PATH;
	response[0] = KOGEN_FS_INVALID_PATH;
	*response_length = 1;
	if (request == NULL || request_length < KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES ||
		request_length > KOGEN_HOST_MAX_PAYLOAD_BYTES)
		return KOGEN_FS_INVALID_PATH;

	uint8_t action = request[0];
	uint8_t restore_kind = request[1];
	mode_t mode = (mode_t)read_u16be(request + 2);
	size_t root_length = read_u32be(request + 4);
	size_t path_length = read_u32be(request + 8);
	size_t data_length = read_u32be(request + 12);
	if (root_length == 0 || root_length > KOGEN_FS_MAX_PATH_BYTES ||
		path_length == 0 || path_length > KOGEN_FS_MAX_PATH_BYTES ||
		root_length > request_length - KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES ||
		path_length > request_length - KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES -
			root_length ||
		data_length != request_length - KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES -
			root_length - path_length)
		return KOGEN_FS_INVALID_PATH;

	const uint8_t *root_bytes = request + KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES;
	const uint8_t *path_bytes = root_bytes + root_length;
	const uint8_t *data = path_bytes + path_length;
	if (!valid_bytes(root_bytes, root_length) ||
		!valid_bytes(path_bytes, path_length) || !valid_bytes(data, data_length))
		return KOGEN_FS_INVALID_PATH;

	struct kogen_fs_root root;
	enum kogen_fs_status status = kogen_fs_root_open(root_bytes, root_length,
		&root);
	if (status != KOGEN_FS_OK) {
		response[0] = (uint8_t)status;
		return status;
	}
	int parent_fd = -1;
	char *name = NULL;
	status = open_parent(&root, path_bytes, path_length, &parent_fd, &name);
	if (status == KOGEN_FS_OK) {
		switch (action) {
		case KOGEN_FS_PUBLISH_ATOMIC_WRITE:
			if (restore_kind != 0 || (mode != 0600 && mode != 0700)) {
				status = KOGEN_FS_INVALID_PATH;
			} else {
				status = atomic_regular_replace(parent_fd, name, data,
					data_length, mode, 0);
			}
			break;
		case KOGEN_FS_PUBLISH_APPEND:
			if (restore_kind != 0 || mode != 0) {
				status = KOGEN_FS_INVALID_PATH;
			} else {
				status = append_bytes(parent_fd, name, data, data_length);
			}
			break;
		case KOGEN_FS_PUBLISH_REMOVE:
			if (restore_kind != 0 || mode != 0 || data_length != 0) {
				status = KOGEN_FS_INVALID_PATH;
			} else {
				status = remove_entry(parent_fd, name);
			}
			break;
		case KOGEN_FS_PUBLISH_RESTORE:
			status = restore_entry(parent_fd, name, restore_kind, mode, data,
				data_length);
			break;
		default:
			status = KOGEN_FS_INVALID_PATH;
			break;
		}
	}
	if (parent_fd >= 0) close(parent_fd);
	free(name);
	kogen_fs_root_close(&root);
	response[0] = (uint8_t)status;
	return status;
}
