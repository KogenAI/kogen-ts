#define _POSIX_C_SOURCE 200809L

#include "paths.h"
#include "host.h"
#include "publish.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

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
	if (argc != 2) return 64;
	const int read_action = strcmp(argv[1], "read") == 0;
	const int publish_action = strcmp(argv[1], "publish") == 0;
	if (!read_action && !publish_action) return 64;
	const size_t capacity = KOGEN_HOST_MAX_PAYLOAD_BYTES;
	uint8_t *request = malloc(capacity);
	uint8_t *response = malloc(capacity);
	if (request == NULL || response == NULL) {
		free(request);
		free(response);
		return 70;
	}
	const size_t request_length = fread(request, 1, capacity, stdin);
	if (ferror(stdin) || (!feof(stdin) && request_length == capacity)) {
		free(request);
		free(response);
		return 65;
	}
	size_t response_length = 0;
	if (read_action) {
		(void)kogen_fs_handle_read_request(
			request, request_length, response, capacity, &response_length);
	} else {
		(void)kogen_fs_handle_publish_request(
			request, request_length, response, capacity, &response_length);
	}
	const int status = write_all(response, response_length) == 0 ? 0 : 74;
	free(request);
	free(response);
	return status;
}
