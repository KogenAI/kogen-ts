#define _POSIX_C_SOURCE 200809L

#include "protocol.h"
#include "paths.h"
#include "publish.h"
#include "supervisor.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
}

#ifdef KOGEN_HOST_TESTING
static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}
#endif

static int set_close_on_exec(int fd) {
	int flags = fcntl(fd, F_GETFD);
	if (flags < 0) return -1;
	return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int validate_control_fd(void) {
	int type = 0;
	socklen_t type_length = (socklen_t)sizeof(type);
	if (getsockopt(KOGEN_HOST_CONTROL_FD, SOL_SOCKET, SO_TYPE, &type,
		&type_length) < 0 || type != SOCK_STREAM) {
		errno = EBADF;
		return -1;
	}
	return set_close_on_exec(KOGEN_HOST_CONTROL_FD);
}

static int respond_error(uint32_t request_id, int error_code) {
	uint8_t payload[4];
	write_u32be(payload, (uint32_t)error_code);
	return kogen_host_write_frame(STDOUT_FILENO, KOGEN_HOST_OP_ERROR,
		request_id, payload, sizeof(payload));
}

static int respond_frame(const struct kogen_host_frame *frame,
	const uint8_t *payload, size_t payload_length) {
	return kogen_host_write_frame(STDOUT_FILENO,
		(uint16_t)(frame->operation | KOGEN_HOST_RESPONSE_BIT),
		frame->request_id, payload, payload_length);
}

#ifdef KOGEN_HOST_TESTING
static int read_report(int fd, uint8_t report[9]) {
	size_t offset = 0;
	while (offset < 9) {
		ssize_t count = read(fd, report + offset, 9 - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count < 0 && errno == EINTR) continue;
		if (count == 0) errno = EPROTO;
		return -1;
	}
	return 0;
}

static int wait_for_control_eof(void) {
	struct pollfd descriptor = {
		.fd = KOGEN_HOST_CONTROL_FD,
		.events = POLLIN | POLLHUP | POLLERR,
	};
	for (;;) {
		int result = poll(&descriptor, 1, -1);
		if (result < 0 && errno == EINTR) continue;
		if (result < 0) return -1;
		if ((descriptor.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0) {
			uint8_t unexpected = 0;
			ssize_t count = recv(KOGEN_HOST_CONTROL_FD, &unexpected, 1, MSG_PEEK);
			if (count <= 0) return 0;
			/* The control channel carries EOF only; any byte also means stop. */
			return 0;
		}
	}
}

static int stop_group(pid_t process_group, pid_t leader) {
	(void)kill(-process_group, SIGTERM);
	struct timespec grace = {.tv_sec = 0, .tv_nsec = 200000000L};
	while (nanosleep(&grace, &grace) < 0 && errno == EINTR) {
	}
	(void)kill(-process_group, SIGKILL);
	int status = 0;
	while (waitpid(leader, &status, 0) < 0) {
		if (errno != EINTR && errno != ECHILD) return -1;
		if (errno == ECHILD) break;
	}
	return 0;
}

static int start_group_probe(const struct kogen_host_frame *frame,
	uint8_t response[9]) {
	if (frame->payload_length == 0 || frame->payload_length > 4096 ||
		memchr(frame->payload, '\0', frame->payload_length) != NULL) {
		errno = EINVAL;
		return -1;
	}
	char worker_path[4097];
	memcpy(worker_path, frame->payload, frame->payload_length);
	worker_path[frame->payload_length] = '\0';

	int report_pipe[2];
	if (pipe(report_pipe) < 0) return -1;
	if (set_close_on_exec(report_pipe[0]) < 0) {
		close(report_pipe[0]);
		close(report_pipe[1]);
		return -1;
	}

	pid_t leader = fork();
	if (leader < 0) {
		close(report_pipe[0]);
		close(report_pipe[1]);
		return -1;
	}
	if (leader == 0) {
		(void)close(report_pipe[0]);
		if (setpgid(0, 0) < 0) _exit(126);
		char report_fd[16];
		(void)snprintf(report_fd, sizeof(report_fd), "%d", report_pipe[1]);
		char *const arguments[] = {worker_path, report_fd, NULL};
		(void)close(STDIN_FILENO);
		(void)close(STDOUT_FILENO);
		(void)close(STDERR_FILENO);
		execv(worker_path, arguments);
		_exit(127);
	}

	(void)setpgid(leader, leader);
	(void)close(report_pipe[1]);
	int result = read_report(report_pipe[0], response);
	int read_error = errno;
	(void)close(report_pipe[0]);
	if (result < 0) {
		(void)kill(-leader, SIGKILL);
		(void)waitpid(leader, NULL, 0);
		errno = read_error;
		return -1;
	}
	return 0;
}

static int run_group_probe(const struct kogen_host_frame *frame) {
	uint8_t response[9];
	if (start_group_probe(frame, response) < 0) {
		(void)respond_error(frame->request_id, (errno == 0) ? EIO : errno);
		return 65;
	}
	if (respond_frame(frame, response, sizeof(response)) < 0) {
		(void)stop_group((pid_t)read_u32be(response),
			(pid_t)read_u32be(response));
		return 74;
	}
	pid_t leader = (pid_t)read_u32be(response);
	if (wait_for_control_eof() < 0) {
		(void)stop_group(leader, leader);
		return 74;
	}
	return stop_group(leader, leader) < 0 ? 74 : 0;
}
#endif

static int dispatch_frame(const struct kogen_host_frame *frame) {
	if ((frame->operation & KOGEN_HOST_RESPONSE_BIT) != 0 ||
		frame->operation == KOGEN_HOST_OP_ERROR) {
		return respond_error(frame->request_id, EPROTO) < 0 ? 74 : 0;
	}
	if (frame->operation == KOGEN_HOST_OP_ECHO) {
		return respond_frame(frame, frame->payload, frame->payload_length) < 0
			? 74
			: 0;
	}
	if (frame->operation == KOGEN_HOST_OP_PING) {
		if (frame->payload_length != 0)
			return respond_error(frame->request_id, EINVAL) < 0 ? 74 : 0;
		uint8_t payload[6];
		payload[0] = 0;
		payload[1] = (uint8_t)KOGEN_HOST_PROTOCOL_VERSION;
		write_u32be(payload + 2, KOGEN_HOST_MAX_FRAME_BYTES);
		return respond_frame(frame, payload, sizeof(payload)) < 0 ? 74 : 0;
	}
	/* Registrations belong to the coordinator; these are the production drivers. */
	if (frame->operation == KOGEN_HOST_OP_FS_READ ||
		frame->operation == KOGEN_HOST_OP_FS_PUBLISH ||
		frame->operation == KOGEN_HOST_OP_PROCESS_SUPERVISE) {
		uint8_t response[KOGEN_HOST_MAX_PAYLOAD_BYTES];
		size_t length = 0;
		if (frame->operation == KOGEN_HOST_OP_FS_READ) {
			(void)kogen_fs_handle_read_request(frame->payload, frame->payload_length,
				response, sizeof(response), &length);
		} else if (frame->operation == KOGEN_HOST_OP_FS_PUBLISH) {
			(void)kogen_fs_handle_publish_request(frame->payload, frame->payload_length,
				response, sizeof(response), &length);
		} else if (kogen_supervisor_handle_request(frame->payload,
			frame->payload_length, KOGEN_HOST_CONTROL_FD, response,
			sizeof(response), &length) < 0) {
			return respond_error(frame->request_id, errno == 0 ? EIO : errno) < 0 ? 74 : 0;
		}
		return respond_frame(frame, response, length) < 0 ? 74 : 0;
	}
#ifdef KOGEN_HOST_TESTING
	if (frame->operation == KOGEN_HOST_OP_TEST_GROUP)
		return run_group_probe(frame);
#endif
	return respond_error(frame->request_id, ENOSYS) < 0 ? 74 : 0;
}

int main(void) {
	if (validate_control_fd() < 0) {
		(void)fprintf(stderr, "kogen-host: missing private control socket\n");
		return 78;
	}
	(void)signal(SIGPIPE, SIG_IGN);
	uint8_t buffer[KOGEN_HOST_MAX_FRAME_BYTES];
	for (;;) {
		struct kogen_host_frame frame;
		int result = kogen_host_read_frame(STDIN_FILENO, buffer,
			sizeof(buffer), &frame);
		if (result == 0) return 0;
		if (result < 0) {
			(void)fprintf(stderr, "kogen-host: invalid frame (%d)\n", errno);
			return 65;
		}
		int dispatched = dispatch_frame(&frame);
		if (dispatched != 0) return dispatched;
	}
}
