#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
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
		return -1;
	}
	return 0;
}

int main(int argc, char **argv) {
	if (argc != 2) return 64;
	int report_fd = atoi(argv[1]);
	errno = 0;
	int control_flags = fcntl(3, F_GETFD);
	uint8_t report[9] = {0};
	pid_t grandchild = fork();
	if (grandchild < 0) return 70;
	if (grandchild == 0) {
		(void)signal(SIGTERM, SIG_IGN);
		for (;;) pause();
	}

	(void)signal(SIGTERM, SIG_IGN);
	write_u32be(report, (uint32_t)getpid());
	write_u32be(report + 4, (uint32_t)grandchild);
	report[8] = (control_flags < 0 && errno == EBADF) ? 1u : 0u;
	if (write_all(report_fd, report, sizeof(report)) < 0) return 74;
	(void)close(report_fd);
	for (;;) pause();
}
