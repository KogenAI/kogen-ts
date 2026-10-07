#define _POSIX_C_SOURCE 200809L

#include "host.h"
#include "publish.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int crash_phase = -1;

static void crash_at_phase(enum kogen_fs_publish_phase phase, void *context) {
	(void)context;
	if ((int)phase == crash_phase) _exit(80 + (int)phase);
}

int main(int argc, char **argv) {
	if (argc == 3 && strcmp(argv[1], "--crash-after") == 0) {
		char *end = NULL;
		long parsed = strtol(argv[2], &end, 10);
		if (end == argv[2] || *end != '\0' || parsed < 1 || parsed > 5)
			return 64;
		crash_phase = (int)parsed;
		kogen_fs_publish_set_test_hook(crash_at_phase, NULL);
	} else if (argc != 1) {
		return 64;
	}

	uint8_t *request = malloc(KOGEN_HOST_MAX_PAYLOAD_BYTES);
	if (request == NULL) return 70;
	size_t request_length = fread(request, 1, KOGEN_HOST_MAX_PAYLOAD_BYTES,
		stdin);
	if (ferror(stdin) ||
		(!feof(stdin) && request_length == KOGEN_HOST_MAX_PAYLOAD_BYTES)) {
		free(request);
		return 65;
	}
	uint8_t response[1];
	size_t response_length = 0;
	(void)kogen_fs_handle_publish_request(request, request_length, response,
		sizeof(response), &response_length);
	free(request);
	if (response_length != 1 || fwrite(response, 1, response_length, stdout) != 1 ||
		fflush(stdout) != 0)
		return 74;
	return 0;
}
