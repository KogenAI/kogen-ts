#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc != 2) return 64;
	pid_t child = fork();
	if (child < 0) return 70;
	if (child == 0) {
		if (setsid() < 0) _exit(71);
		int report = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600);
		if (report < 0) _exit(72);
		char pid[32];
		int length = snprintf(pid, sizeof(pid), "%ld\n", (long)getpid());
		if (length < 0 || write(report, pid, (size_t)length) != (ssize_t)length)
			_exit(73);
		close(report);
		execl("/bin/sleep", "sleep", "30", (char *)NULL);
		_exit(errno == ENOENT ? 127 : 74);
	}
	return 0;
}
