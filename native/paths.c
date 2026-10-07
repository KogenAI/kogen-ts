#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _XOPEN_SOURCE 700
#define _POSIX_C_SOURCE 200809L

#include "paths.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define KOGEN_FS_MAX_DEPTH 256u
#define KOGEN_FS_MAX_SYMLINKS 40u

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

static int valid_bytes(const uint8_t *bytes, size_t length) {
	return (bytes != NULL || length == 0) &&
		(length == 0 || memchr(bytes, '\0', length) == NULL);
}

static char *copy_path(const uint8_t *bytes, size_t length) {
	if (!valid_bytes(bytes, length) || length > KOGEN_FS_MAX_PATH_BYTES) {
		errno = length > KOGEN_FS_MAX_PATH_BYTES ? ENAMETOOLONG : EINVAL;
		return NULL;
	}
	char *copy = malloc(length + 1);
	if (copy == NULL) return NULL;
	if (length != 0) memcpy(copy, bytes, length);
	copy[length] = '\0';
	return copy;
}

static int open_canonical_directory(const char *path) {
	if (path[0] != '/') {
		errno = EINVAL;
		return -1;
	}
	int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
	if (current < 0) return -1;
	size_t length = strlen(path);
	size_t position = 1;
	while (position < length) {
		while (position < length && path[position] == '/') position++;
		if (position == length) break;
		size_t end = position;
		while (end < length && path[end] != '/') end++;
		size_t component_length = end - position;
		if (component_length == 0 || component_length > KOGEN_FS_MAX_PATH_BYTES) {
			close(current);
			errno = ENAMETOOLONG;
			return -1;
		}
		char *component = malloc(component_length + 1);
		if (component == NULL) {
			close(current);
			return -1;
		}
		memcpy(component, path + position, component_length);
		component[component_length] = '\0';
		int next = openat(current, component,
			O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
		int saved_error = errno;
		free(component);
		if (next < 0) {
			close(current);
			errno = saved_error;
			return -1;
		}
		close(current);
		current = next;
		position = end;
	}
	return current;
}

enum kogen_fs_status kogen_fs_root_open(const uint8_t *path,
	size_t path_length, struct kogen_fs_root *root) {
	if (root == NULL) return KOGEN_FS_INVALID_PATH;
	root->fd = -1;
	root->canonical_path = NULL;
	root->canonical_path_length = 0;
	root->path_alias = NULL;
	root->path_alias_length = 0;
	char *input = copy_path(path, path_length);
	if (input == NULL) return status_for_errno(errno);
	if (input[0] == '\0') {
		free(input);
		return KOGEN_FS_INVALID_PATH;
	}
	char *canonical = realpath(input, NULL);
	int saved_error = errno;
	if (canonical == NULL) {
		free(input);
		return status_for_errno(saved_error);
	}
	int fd = open_canonical_directory(canonical);
	if (fd < 0) {
		saved_error = errno;
		free(input);
		free(canonical);
		return status_for_errno(saved_error);
	}
	struct stat opened;
	struct stat named;
	if (fstat(fd, &opened) < 0 || stat(canonical, &named) < 0) {
		saved_error = errno;
		close(fd);
		free(input);
		free(canonical);
		return status_for_errno(saved_error);
	}
	if (!S_ISDIR(opened.st_mode) || opened.st_dev != named.st_dev ||
		opened.st_ino != named.st_ino) {
		close(fd);
		free(input);
		free(canonical);
		return KOGEN_FS_INVALID_PATH;
	}
	root->fd = fd;
	root->canonical_path = canonical;
	root->canonical_path_length = strlen(canonical);
	if (input[0] == '/') {
		size_t alias_length = strlen(input);
		while (alias_length > 1 && input[alias_length - 1] == '/') alias_length--;
		input[alias_length] = '\0';
		root->path_alias = input;
		root->path_alias_length = alias_length;
	} else {
		free(input);
	}
	return KOGEN_FS_OK;
}

void kogen_fs_root_close(struct kogen_fs_root *root) {
	if (root == NULL) return;
	if (root->fd >= 0) close(root->fd);
	free(root->canonical_path);
	free(root->path_alias);
	root->fd = -1;
	root->canonical_path = NULL;
	root->canonical_path_length = 0;
	root->path_alias = NULL;
	root->path_alias_length = 0;
}

static enum kogen_fs_status strip_root_prefix(const char *root_path,
	size_t root_length, const char *target, size_t target_length,
	const char **relative, size_t *relative_length) {
	if (root_length == 1 && root_path[0] == '/') {
		*relative = target + 1;
		*relative_length = target_length - 1;
		return KOGEN_FS_OK;
	}
	if (target_length < root_length ||
		memcmp(target, root_path, root_length) != 0 ||
		(target_length > root_length && target[root_length] != '/')) {
		return KOGEN_FS_OUTSIDE_ROOT;
	}
	if (target_length == root_length) {
		*relative = target + target_length;
		*relative_length = 0;
	} else {
		*relative = target + root_length + 1;
		*relative_length = target_length - root_length - 1;
	}
	return KOGEN_FS_OK;
}

static enum kogen_fs_status absolute_target_relative(
	const struct kogen_fs_root *root, const char *target, size_t target_length,
	const char **relative, size_t *relative_length) {
	enum kogen_fs_status status = strip_root_prefix(root->canonical_path,
		root->canonical_path_length, target, target_length, relative,
		relative_length);
	if (status == KOGEN_FS_OK || root->path_alias == NULL)
		return status;
	return strip_root_prefix(root->path_alias, root->path_alias_length,
		target, target_length, relative, relative_length);
}

static enum kogen_fs_status replace_pending(char **pending, size_t *pending_length,
	const char *target, size_t target_length, const char *remainder,
	size_t remainder_length) {
	while (remainder_length > 0 && *remainder == '/') {
		remainder++;
		remainder_length--;
	}
	if (target_length > KOGEN_FS_MAX_PATH_BYTES ||
		remainder_length > KOGEN_FS_MAX_PATH_BYTES ||
		target_length + remainder_length + (remainder_length > 0 ? 1u : 0u) >
			KOGEN_FS_MAX_PATH_BYTES) {
		return KOGEN_FS_LIMIT;
	}
	size_t next_length = target_length + remainder_length +
		(remainder_length > 0 ? 1u : 0u);
	char *next = malloc(next_length + 1);
	if (next == NULL) return KOGEN_FS_IO;
	if (target_length > 0) memcpy(next, target, target_length);
	size_t offset = target_length;
	if (remainder_length > 0) {
		next[offset++] = '/';
		memcpy(next + offset, remainder, remainder_length);
		offset += remainder_length;
	}
	next[offset] = '\0';
	free(*pending);
	*pending = next;
	*pending_length = next_length;
	return KOGEN_FS_OK;
}

enum kogen_fs_status kogen_fs_open_path(const struct kogen_fs_root *root,
	const uint8_t *path, size_t path_length, int follow_in_root_links,
	int want_directory, int *fd_out) {
	if (fd_out == NULL || root == NULL || root->fd < 0 ||
		root->canonical_path == NULL || !valid_bytes(path, path_length) ||
		path_length > KOGEN_FS_MAX_PATH_BYTES ||
		(path_length > 0 && path[0] == '/')) {
		return path_length > KOGEN_FS_MAX_PATH_BYTES ? KOGEN_FS_LIMIT
			: KOGEN_FS_INVALID_PATH;
	}
	if (!want_directory && path_length > 0 && path[path_length - 1] == '/')
		return KOGEN_FS_NOT_REGULAR;
	*fd_out = -1;
	char *pending = copy_path(path, path_length);
	if (pending == NULL) return status_for_errno(errno);
	size_t pending_length = path_length;
	int directories[KOGEN_FS_MAX_DEPTH + 1u];
	size_t depth = 0;
	directories[0] = dup(root->fd);
	if (directories[0] < 0) {
		int saved_error = errno;
		free(pending);
		return status_for_errno(saved_error);
	}
	size_t symlinks = 0;
	size_t position = 0;
	enum kogen_fs_status result = KOGEN_FS_OK;

	for (;;) {
		while (position < pending_length && pending[position] == '/') position++;
		if (position == pending_length) {
			if (want_directory) {
				*fd_out = dup(directories[depth]);
				if (*fd_out < 0) result = status_for_errno(errno);
			} else {
				result = KOGEN_FS_NOT_REGULAR;
			}
			break;
		}

		size_t component_start = position;
		while (position < pending_length && pending[position] != '/') position++;
		size_t component_length = position - component_start;
		size_t remainder_start = position;
		while (remainder_start < pending_length && pending[remainder_start] == '/')
			remainder_start++;
		int final_component = remainder_start == pending_length;
		if (component_length == 1 && pending[component_start] == '.') {
			position = remainder_start;
			continue;
		}
		if (component_length == 2 && pending[component_start] == '.' &&
			pending[component_start + 1] == '.') {
			if (depth == 0) {
				result = KOGEN_FS_OUTSIDE_ROOT;
				break;
			}
			close(directories[depth]);
			depth--;
			position = remainder_start;
			continue;
		}
		if (component_length > KOGEN_FS_MAX_PATH_BYTES) {
			result = KOGEN_FS_LIMIT;
			break;
		}
		char *component = malloc(component_length + 1);
		if (component == NULL) {
			result = KOGEN_FS_IO;
			break;
		}
		memcpy(component, pending + component_start, component_length);
		component[component_length] = '\0';
		struct stat metadata;
		if (fstatat(directories[depth], component, &metadata,
			AT_SYMLINK_NOFOLLOW) < 0) {
			int saved_error = errno;
			free(component);
			result = status_for_errno(saved_error);
			break;
		}
		if (S_ISLNK(metadata.st_mode)) {
			if (!follow_in_root_links) {
				free(component);
				result = KOGEN_FS_INVALID_PATH;
				break;
			}
			if (symlinks >= KOGEN_FS_MAX_SYMLINKS) {
				free(component);
				result = KOGEN_FS_LIMIT;
				break;
			}
			symlinks++;
			char *target = malloc(KOGEN_FS_MAX_PATH_BYTES + 1u);
			if (target == NULL) {
				free(component);
				result = KOGEN_FS_IO;
				break;
			}
			ssize_t target_length = readlinkat(directories[depth], component,
				target, KOGEN_FS_MAX_PATH_BYTES + 1u);
			int saved_error = errno;
			free(component);
			if (target_length < 0) {
				free(target);
				result = status_for_errno(saved_error);
				break;
			}
			if ((size_t)target_length > KOGEN_FS_MAX_PATH_BYTES) {
				free(target);
				result = KOGEN_FS_LIMIT;
				break;
			}
		if (!want_directory && target_length > 0 && target[target_length - 1] == '/' &&
			remainder_start == pending_length) {
			free(target);
			result = KOGEN_FS_NOT_REGULAR;
			break;
		}
		target[target_length] = '\0';
			const char *target_path = target;
			size_t target_path_length = (size_t)target_length;
			int absolute_target = target_path_length > 0 && target_path[0] == '/';
			if (absolute_target) {
				result = absolute_target_relative(root, target_path,
					target_path_length, &target_path, &target_path_length);
				if (result != KOGEN_FS_OK) {
					free(target);
					break;
				}
				while (depth > 0) close(directories[depth--]);
			}
			result = replace_pending(&pending, &pending_length, target_path,
				target_path_length, pending + remainder_start,
				pending_length - remainder_start);
			free(target);
			if (result != KOGEN_FS_OK) break;
			position = 0;
			continue;
		}

		if (!final_component) {
			if (!S_ISDIR(metadata.st_mode)) {
				free(component);
				result = KOGEN_FS_NOT_FOUND;
				break;
			}
			if (depth >= KOGEN_FS_MAX_DEPTH) {
				free(component);
				result = KOGEN_FS_LIMIT;
				break;
			}
			int next = openat(directories[depth], component,
				O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
			int saved_error = errno;
			free(component);
			if (next < 0) {
				result = status_for_errno(saved_error);
				break;
			}
			struct stat opened;
			if (fstat(next, &opened) < 0) {
				saved_error = errno;
				close(next);
				result = status_for_errno(saved_error);
				break;
			}
			if (!S_ISDIR(opened.st_mode)) {
				close(next);
				result = KOGEN_FS_NOT_FOUND;
				break;
			}
			directories[++depth] = next;
			position = remainder_start;
			continue;
		}

		if (want_directory != S_ISDIR(metadata.st_mode)) {
			free(component);
			result = KOGEN_FS_NOT_REGULAR;
			break;
		}
		if (!want_directory && !S_ISREG(metadata.st_mode)) {
			free(component);
			result = KOGEN_FS_NOT_REGULAR;
			break;
		}
		int open_flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
		if (want_directory) open_flags |= O_DIRECTORY;
		int final_fd = openat(directories[depth], component, open_flags);
		int saved_error = errno;
		free(component);
		if (final_fd < 0) {
			result = status_for_errno(saved_error);
			break;
		}
		struct stat opened;
		if (fstat(final_fd, &opened) < 0) {
			saved_error = errno;
			close(final_fd);
			result = status_for_errno(saved_error);
			break;
		}
		if (want_directory ? !S_ISDIR(opened.st_mode) : !S_ISREG(opened.st_mode)) {
			close(final_fd);
			result = KOGEN_FS_NOT_REGULAR;
			break;
		}
		*fd_out = final_fd;
		break;
	}

	for (size_t index = 0; index <= depth; index++) close(directories[index]);
	free(pending);
	if (result != KOGEN_FS_OK && *fd_out >= 0) {
		close(*fd_out);
		*fd_out = -1;
	}
	return result;
}

static enum kogen_fs_entry_kind kind_from_mode(mode_t mode) {
	if (S_ISLNK(mode)) return KOGEN_FS_ENTRY_SYMLINK;
	if (S_ISDIR(mode)) return KOGEN_FS_ENTRY_DIRECTORY;
	if (S_ISREG(mode)) return KOGEN_FS_ENTRY_REGULAR;
	return KOGEN_FS_ENTRY_OTHER;
}

static int compare_entries(const void *left_pointer, const void *right_pointer) {
	const struct kogen_fs_entry *left = left_pointer;
	const struct kogen_fs_entry *right = right_pointer;
	size_t common = left->name_length < right->name_length
		? left->name_length : right->name_length;
	int order = memcmp(left->name, right->name, common);
	if (order != 0) return order;
	if (left->name_length < right->name_length) return -1;
	if (left->name_length > right->name_length) return 1;
	return 0;
}

void kogen_fs_listing_free(struct kogen_fs_listing *listing) {
	if (listing == NULL) return;
	for (size_t index = 0; index < listing->count; index++)
		free(listing->entries[index].name);
	free(listing->entries);
	listing->entries = NULL;
	listing->count = 0;
	listing->name_bytes = 0;
}

enum kogen_fs_status kogen_fs_list_directory(
	const struct kogen_fs_root *root, const uint8_t *path, size_t path_length,
	int follow_in_root_links, size_t max_entries, size_t max_name_bytes,
	struct kogen_fs_listing *listing) {
	if (listing == NULL) return KOGEN_FS_INVALID_PATH;
	listing->entries = NULL;
	listing->count = 0;
	listing->name_bytes = 0;
	if (max_entries > KOGEN_FS_MAX_ENTRIES ||
		max_name_bytes > KOGEN_FS_MAX_RESPONSE_BYTES) return KOGEN_FS_LIMIT;
	int directory_fd = -1;
	enum kogen_fs_status status = kogen_fs_open_path(root, path,
		path_length, follow_in_root_links, 1, &directory_fd);
	if (status != KOGEN_FS_OK) return status;
	int stream_fd = dup(directory_fd);
	close(directory_fd);
	if (stream_fd < 0) return status_for_errno(errno);
	DIR *directory = fdopendir(stream_fd);
	if (directory == NULL) {
		int saved_error = errno;
		close(stream_fd);
		return status_for_errno(saved_error);
	}
	for (;;) {
		errno = 0;
		struct dirent *entry = readdir(directory);
		if (entry == NULL) {
			if (errno != 0) status = status_for_errno(errno);
			break;
		}
		if (strcmp(entry->d_name, ".") == 0 ||
			strcmp(entry->d_name, "..") == 0) continue;
		size_t name_length = strlen(entry->d_name);
		struct stat metadata;
		if (fstatat(dirfd(directory), entry->d_name, &metadata,
			AT_SYMLINK_NOFOLLOW) < 0) {
			if (errno == ENOENT) continue;
			status = status_for_errno(errno);
			break;
		}
		if (listing->count >= max_entries ||
			listing->name_bytes > max_name_bytes ||
			name_length > max_name_bytes - listing->name_bytes) {
			status = KOGEN_FS_LIMIT;
			break;
		}
		struct kogen_fs_entry *grown = realloc(listing->entries,
			(listing->count + 1u) * sizeof(*listing->entries));
		if (grown == NULL) {
			status = KOGEN_FS_IO;
			break;
		}
		listing->entries = grown;
		uint8_t *name = malloc(name_length == 0 ? 1u : name_length);
		if (name == NULL) {
			status = KOGEN_FS_IO;
			break;
		}
		memcpy(name, entry->d_name, name_length);
		listing->entries[listing->count].name = name;
		listing->entries[listing->count].name_length = name_length;
		listing->entries[listing->count].kind = kind_from_mode(metadata.st_mode);
		listing->count++;
		listing->name_bytes += name_length;
	}
	closedir(directory);
	if (status != KOGEN_FS_OK) {
		kogen_fs_listing_free(listing);
		return status;
	}
	if (listing->count > 1)
		qsort(listing->entries, listing->count, sizeof(*listing->entries),
			compare_entries);
	return KOGEN_FS_OK;
}
