#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include "paths.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define REQUEST_HEADER_BYTES 17u
#define RESPONSE_STATUS_BYTES 1u
#define READ_ACTION_CONTROLLER 1u
#define READ_ACTION_TOOL 2u
#define READ_ACTION_LIST_CONTROLLER 3u
#define READ_ACTION_LIST_TOOL 4u

static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
}

static enum kogen_fs_status read_file(const struct kogen_fs_root *root,
	const uint8_t *path, size_t path_length, int follow_links,
	size_t max_bytes, uint8_t *response, size_t response_capacity,
	size_t *response_length) {
	if (max_bytes > KOGEN_FS_MAX_RESPONSE_BYTES - RESPONSE_STATUS_BYTES ||
		response_capacity < RESPONSE_STATUS_BYTES + max_bytes) {
		return KOGEN_FS_LIMIT;
	}
	int fd = -1;
	enum kogen_fs_status status = kogen_fs_open_path(root, path,
		path_length, follow_links, 0, &fd);
	if (status != KOGEN_FS_OK) return status;
	uint8_t *buffer = malloc(max_bytes + 1u);
	if (buffer == NULL) {
		close(fd);
		return KOGEN_FS_IO;
	}
	size_t total = 0;
	for (;;) {
		ssize_t count = read(fd, buffer + total, max_bytes + 1u - total);
		if (count > 0) {
			total += (size_t)count;
			if (total > max_bytes) {
				status = KOGEN_FS_TOO_LARGE;
				break;
			}
			continue;
		}
		if (count == 0) break;
		if (errno == EINTR) continue;
		status = (errno == EAGAIN || errno == EWOULDBLOCK)
			? KOGEN_FS_NOT_REGULAR : KOGEN_FS_IO;
		break;
	}
	close(fd);
	if (status == KOGEN_FS_OK) {
		response[0] = KOGEN_FS_OK;
		if (total > 0) memcpy(response + RESPONSE_STATUS_BYTES, buffer, total);
		*response_length = RESPONSE_STATUS_BYTES + total;
	}
	free(buffer);
	return status;
}

static enum kogen_fs_status list_directory(const struct kogen_fs_root *root,
	const uint8_t *path, size_t path_length, int follow_links,
	size_t max_entries, size_t max_name_bytes, uint8_t *response,
	size_t response_capacity, size_t *response_length) {
	struct kogen_fs_listing listing;
	enum kogen_fs_status status = kogen_fs_list_directory(root, path,
		path_length, follow_links, max_entries, max_name_bytes, &listing);
	if (status != KOGEN_FS_OK) return status;
	size_t needed = RESPONSE_STATUS_BYTES + 4u;
	for (size_t index = 0; index < listing.count; index++) {
		if (listing.entries[index].name_length > UINT32_MAX ||
			needed > response_capacity || response_capacity - needed < 5u ||
			listing.entries[index].name_length > response_capacity - needed - 5u) {
			status = KOGEN_FS_LIMIT;
			break;
		}
		needed += 5u + listing.entries[index].name_length;
	}
	if (status == KOGEN_FS_OK && needed > response_capacity)
		status = KOGEN_FS_LIMIT;
	if (status == KOGEN_FS_OK) {
		response[0] = KOGEN_FS_OK;
		write_u32be(response + 1, (uint32_t)listing.count);
		size_t offset = RESPONSE_STATUS_BYTES + 4u;
		for (size_t index = 0; index < listing.count; index++) {
			response[offset++] = (uint8_t)listing.entries[index].kind;
			write_u32be(response + offset,
				(uint32_t)listing.entries[index].name_length);
			offset += 4u;
			memcpy(response + offset, listing.entries[index].name,
				listing.entries[index].name_length);
			offset += listing.entries[index].name_length;
		}
		*response_length = needed;
	}
	kogen_fs_listing_free(&listing);
	return status;
}

/*
 * Payload: action:u8, max_bytes:u32be, max_entries:u32be,
 * root_length:u32be, path_length:u32be, root bytes, path bytes.
 * Response: stable status:u8, then raw file bytes or count/entry records.
 */
enum kogen_fs_status kogen_fs_handle_read_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length) {
	if (response_length == NULL) return KOGEN_FS_INVALID_PATH;
	*response_length = 0;
	if (response == NULL || response_capacity < RESPONSE_STATUS_BYTES) {
		return KOGEN_FS_INVALID_PATH;
	}
	response[0] = KOGEN_FS_INVALID_PATH;
	if (request == NULL || request_length < REQUEST_HEADER_BYTES) {
		*response_length = RESPONSE_STATUS_BYTES;
		return KOGEN_FS_INVALID_PATH;
	}
	uint8_t action = request[0];
	size_t max_bytes = read_u32be(request + 1);
	size_t max_entries = read_u32be(request + 5);
	size_t root_length = read_u32be(request + 9);
	size_t path_length = read_u32be(request + 13);
	if (root_length == 0 || root_length > KOGEN_FS_MAX_PATH_BYTES ||
		path_length > KOGEN_FS_MAX_PATH_BYTES ||
		root_length > request_length - REQUEST_HEADER_BYTES ||
		path_length != request_length - REQUEST_HEADER_BYTES - root_length) {
		*response_length = RESPONSE_STATUS_BYTES;
		return KOGEN_FS_INVALID_PATH;
	}
	if (action < READ_ACTION_CONTROLLER || action > READ_ACTION_LIST_TOOL) {
		*response_length = RESPONSE_STATUS_BYTES;
		return KOGEN_FS_INVALID_PATH;
	}
	struct kogen_fs_root root;
	enum kogen_fs_status status = kogen_fs_root_open(
		request + REQUEST_HEADER_BYTES, root_length, &root);
	if (status != KOGEN_FS_OK) {
		response[0] = (uint8_t)status;
		*response_length = RESPONSE_STATUS_BYTES;
		return status;
	}
	const uint8_t *path = request + REQUEST_HEADER_BYTES + root_length;
	if (action == READ_ACTION_CONTROLLER || action == READ_ACTION_TOOL) {
		if (max_bytes > KOGEN_FS_MAX_RESPONSE_BYTES - RESPONSE_STATUS_BYTES) {
			status = KOGEN_FS_LIMIT;
		} else {
			status = read_file(&root, path, path_length,
				action == READ_ACTION_TOOL, max_bytes, response,
				response_capacity, response_length);
		}
	} else {
		if (max_bytes > KOGEN_FS_MAX_RESPONSE_BYTES) {
			status = KOGEN_FS_LIMIT;
		} else {
			status = list_directory(&root, path, path_length,
				action == READ_ACTION_LIST_TOOL, max_entries, max_bytes,
				response, response_capacity, response_length);
		}
	}
	kogen_fs_root_close(&root);
	if (status != KOGEN_FS_OK) {
		response[0] = (uint8_t)status;
		*response_length = 1;
	}
	return status;
}
