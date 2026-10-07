#define _POSIX_C_SOURCE 200809L

#include "host.h"
#include "supervisor.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
}

static int respond_error(uint32_t request_id, int error_number) {
	uint8_t payload[4];
	write_u32be(payload, (uint32_t)error_number);
	return kogen_host_write_frame(STDOUT_FILENO, KOGEN_HOST_OP_ERROR,
		request_id, payload, sizeof(payload));
}

int main(void) {
	int control_fd = KOGEN_HOST_CONTROL_FD;
	int flags = fcntl(control_fd, F_GETFD);
	int type = 0;
	socklen_t type_length = (socklen_t)sizeof(type);
	if (flags < 0 ||
		fcntl(control_fd, F_SETFD, flags | FD_CLOEXEC) < 0 ||
		getsockopt(control_fd, SOL_SOCKET, SO_TYPE, &type, &type_length) < 0 ||
		type != SOCK_STREAM) {
		(void)fprintf(stderr, "supervisor-host: missing control socket\n");
		return 78;
	}
	(void)signal(SIGPIPE, SIG_IGN);
	uint8_t input[KOGEN_HOST_MAX_FRAME_BYTES];
	uint8_t output[KOGEN_HOST_MAX_PAYLOAD_BYTES];
	for (;;) {
		struct kogen_host_frame frame;
		int read_result = kogen_host_read_frame(STDIN_FILENO, input,
			sizeof(input), &frame);
		if (read_result == 0) return 0;
		if (read_result < 0) return 65;
		if (frame.operation == KOGEN_HOST_OP_PING && frame.payload_length == 0) {
			const uint8_t ping[6] = {
				0,
				(uint8_t)KOGEN_HOST_PROTOCOL_VERSION,
				0,
				0x10,
				0,
				0,
		};
			if (kogen_host_write_frame(STDOUT_FILENO,
				(uint16_t)(frame.operation | KOGEN_HOST_RESPONSE_BIT),
				frame.request_id, ping, sizeof(ping)) < 0)
				return 74;
			continue;
		}
		if (frame.operation != KOGEN_HOST_OP_PROCESS_SUPERVISE) {
			if (respond_error(frame.request_id, ENOSYS) < 0) return 74;
			continue;
		}
		size_t output_length = 0;
		if (kogen_supervisor_handle_request(frame.payload, frame.payload_length,
			control_fd, output, sizeof(output), &output_length) < 0) {
			int error_number = errno == 0 ? EIO : errno;
			if (respond_error(frame.request_id, error_number) < 0) return 74;
			continue;
		}
		if (kogen_host_write_frame(STDOUT_FILENO,
			(uint16_t)(frame.operation | KOGEN_HOST_RESPONSE_BIT),
			frame.request_id, output, output_length) < 0)
			return 74;
	}
}
