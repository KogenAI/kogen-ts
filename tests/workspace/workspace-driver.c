#define _POSIX_C_SOURCE 200809L

#include "paths.h"

#include <errno.h>
#include <fcntl.h>
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
	if (argc != 1) return 64;
	uint8_t *request = malloc(KOGEN_FS_MAX_RESPONSE_BYTES);
	uint8_t *response = malloc(KOGEN_FS_MAX_RESPONSE_BYTES);
	if (request == NULL || response == NULL) {
		free(request);
		free(response);
		return 70;
	}
	size_t request_length = fread(request, 1, KOGEN_FS_MAX_RESPONSE_BYTES, stdin);
	if (ferror(stdin) ||
		(!feof(stdin) && request_length == KOGEN_FS_MAX_RESPONSE_BYTES)) {
		free(request);
		free(response);
		return 65;
	}
	size_t response_length = 0;
	(void)kogen_fs_handle_read_request(request, request_length, response,
		KOGEN_FS_MAX_RESPONSE_BYTES, &response_length);
	int result = write_all(response, response_length) == 0 ? 0 : 74;
	free(request);
	free(response);
	return result;
}
