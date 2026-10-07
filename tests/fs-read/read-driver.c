#define _POSIX_C_SOURCE 200809L

#include "paths.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_REQUEST_BYTES KOGEN_FS_MAX_RESPONSE_BYTES
#define REPEAT_COUNT 10000u

static int write_all(const uint8_t *bytes, size_t length) {
	size_t offset = 0;
	while (offset < length) {
		size_t written = fwrite(bytes + offset, 1, length - offset, stdout);
		if (written == 0) return -1;
		offset += written;
	}
	return fflush(stdout) == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
	int repeat = argc == 2 && strcmp(argv[1], "--repeat-parent-swap") == 0;
	if (argc == 3 && strcmp(argv[1], "--create-invalid-name") == 0) {
		static const char name[] = {'n', 'a', 'm', 'e', (char)0xff, '\0'};
		int directory = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (directory < 0) return 69;
		int file = openat(directory, name,
			O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
		close(directory);
		if (file < 0) {
			int saved_error = errno;
			(void)fprintf(stderr, "invalid-byte filename errno=%d\n", saved_error);
			return saved_error == EILSEQ ? 72 : 70;
		}
		static const uint8_t contents[] = "raw-name";
		size_t offset = 0;
		while (offset < sizeof(contents) - 1u) {
			ssize_t written = write(file, contents + offset,
				sizeof(contents) - 1u - offset);
			if (written <= 0) {
				close(file);
				return 71;
			}
			offset += (size_t)written;
		}
		close(file);
		return 0;
	}
	if (argc > 1 && !repeat) return 64;
	uint8_t *request = malloc(MAX_REQUEST_BYTES);
	uint8_t *response = malloc(KOGEN_FS_MAX_RESPONSE_BYTES);
	if (request == NULL || response == NULL) {
		free(request);
		free(response);
		return 70;
	}
	size_t request_length = fread(request, 1, MAX_REQUEST_BYTES, stdin);
	if (ferror(stdin) || (!feof(stdin) && request_length == MAX_REQUEST_BYTES)) {
		free(request);
		free(response);
		return 65;
	}
	if (!repeat) {
		size_t response_length = 0;
		(void)kogen_fs_handle_read_request(request, request_length, response,
			KOGEN_FS_MAX_RESPONSE_BYTES, &response_length);
		int result = write_all(response, response_length) == 0 ? 0 : 74;
		free(request);
		free(response);
		return result;
	}

	size_t inside_reads = 0;
	size_t blocked_reads = 0;
	size_t outside_statuses = 0;
	for (size_t index = 0; index < REPEAT_COUNT; index++) {
		size_t response_length = 0;
		(void)kogen_fs_handle_read_request(request, request_length, response,
			KOGEN_FS_MAX_RESPONSE_BYTES, &response_length);
		if (response_length >= 1 && response[0] == KOGEN_FS_OK) {
			static const uint8_t expected[] = "inside";
			if (response_length != sizeof(expected) ||
				memcmp(response + 1, expected, sizeof(expected) - 1u) != 0) {
				free(request);
				free(response);
				return 66;
			}
			inside_reads++;
		} else if (response_length == 1 &&
			response[0] == KOGEN_FS_OUTSIDE_ROOT) {
			outside_statuses++;
		} else if (response_length == 1 &&
			(response[0] == KOGEN_FS_NOT_FOUND ||
				response[0] == KOGEN_FS_INVALID_PATH)) {
			blocked_reads++;
		} else {
			free(request);
			free(response);
			return 67;
		}
	}
	(void)fprintf(stderr, "inside=%zu blocked=%zu outside=%zu\n",
		inside_reads, blocked_reads, outside_statuses);
	free(request);
	free(response);
	return inside_reads > 0 ? 0 : 68;
}
