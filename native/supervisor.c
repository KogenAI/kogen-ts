#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include "supervisor.h"

#include "host.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <libproc.h>
#endif

#ifdef __linux__
#include <sys/prctl.h>
#endif

#define KOGEN_SUPERVISOR_GRACE_NS 200000000ULL
#define KOGEN_SUPERVISOR_DRAIN_NS 500000000ULL
#define KOGEN_SUPERVISOR_POLL_MAX_MS 100
#define KOGEN_SUPERVISOR_MAX_ENV_ENTRY_BYTES (64u * 1024u)

struct cursor {
	const uint8_t *bytes;
	size_t length;
	size_t offset;
};

struct owned_request {
	char **argv;
	char **envp;
	char *cwd;
	uint8_t *stdin_bytes;
	size_t stdin_length;
	uint64_t timeout_ms;
	size_t stdout_limit;
	size_t stderr_limit;
};

struct byte_tail {
	uint8_t *bytes;
	size_t capacity;
	size_t used;
	size_t next;
	uint64_t total;
};

struct process_identity {
	pid_t pid;
#ifdef __APPLE__
	uint64_t start_seconds;
	uint64_t start_microseconds;
#endif
};

static uint16_t read_u16be(const uint8_t *bytes) {
	return (uint16_t)(((uint16_t)bytes[0] << 8) | (uint16_t)bytes[1]);
}

static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static uint64_t read_u64be(const uint8_t *bytes) {
	return ((uint64_t)read_u32be(bytes) << 32) | read_u32be(bytes + 4);
}

static void write_u16be(uint8_t *bytes, uint16_t value) {
	bytes[0] = (uint8_t)(value >> 8);
	bytes[1] = (uint8_t)value;
}

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
}

static void write_u64be(uint8_t *bytes, uint64_t value) {
	write_u32be(bytes, (uint32_t)(value >> 32));
	write_u32be(bytes + 4, (uint32_t)value);
}

static int cursor_take(struct cursor *cursor, size_t length,
	const uint8_t **bytes_out) {
	if (length > cursor->length - cursor->offset) {
		errno = EINVAL;
		return -1;
	}
	*bytes_out = cursor->bytes + cursor->offset;
	cursor->offset += length;
	return 0;
}

static int cursor_u32(struct cursor *cursor, uint32_t *value_out) {
	const uint8_t *bytes = NULL;
	if (cursor_take(cursor, 4, &bytes) < 0) return -1;
	*value_out = read_u32be(bytes);
	return 0;
}

static int string_from_bytes(const uint8_t *bytes, size_t length,
	char **string_out) {
	if (length == 0 || length > SIZE_MAX - 1 ||
		memchr(bytes, '\0', length) != NULL) {
		errno = EINVAL;
		return -1;
	}
	char *string = malloc(length + 1u);
	if (string == NULL) return -1;
	memcpy(string, bytes, length);
	string[length] = '\0';
	*string_out = string;
	return 0;
}

static void free_request(struct owned_request *request) {
	if (request->argv != NULL) {
		for (size_t index = 0; request->argv[index] != NULL; index++)
			free(request->argv[index]);
		free(request->argv);
	}
	if (request->envp != NULL) {
		for (size_t index = 0; request->envp[index] != NULL; index++)
			free(request->envp[index]);
		free(request->envp);
	}
	free(request->cwd);
	free(request->stdin_bytes);
	memset(request, 0, sizeof(*request));
}

static int parse_request(const uint8_t *bytes, size_t length,
	struct owned_request *request) {
	memset(request, 0, sizeof(*request));
	if (bytes == NULL || length < KOGEN_SUPERVISOR_REQUEST_HEADER_BYTES) {
		errno = EINVAL;
		return -1;
	}
	if (read_u16be(bytes) != KOGEN_SUPERVISOR_REQUEST_VERSION ||
		read_u16be(bytes + 2) != 0) {
		errno = EPROTONOSUPPORT;
		return -1;
	}
	request->timeout_ms = read_u64be(bytes + 4);
	request->stdout_limit = read_u32be(bytes + 12);
	request->stderr_limit = read_u32be(bytes + 16);
	uint32_t cwd_length = read_u32be(bytes + 20);
	uint16_t argc = read_u16be(bytes + 24);
	uint16_t envc = read_u16be(bytes + 26);
	uint32_t stdin_length = read_u32be(bytes + 28);
	if (request->timeout_ms == 0 ||
		request->timeout_ms > KOGEN_SUPERVISOR_MAX_TIMEOUT_MS || argc == 0 ||
		argc > KOGEN_SUPERVISOR_MAX_ARGS || envc > KOGEN_SUPERVISOR_MAX_ENV ||
		stdin_length > KOGEN_HOST_MAX_PAYLOAD_BYTES ||
		cwd_length > KOGEN_SUPERVISOR_MAX_ENV_ENTRY_BYTES) {
		errno = EINVAL;
		return -1;
	}
	struct cursor cursor = {
		.bytes = bytes,
		.length = length,
		.offset = KOGEN_SUPERVISOR_REQUEST_HEADER_BYTES,
	};
	const uint8_t *part = NULL;
	if (cwd_length > 0) {
		if (cursor_take(&cursor, cwd_length, &part) < 0 ||
			string_from_bytes(part, cwd_length, &request->cwd) < 0)
			goto fail;
	}
	request->argv = calloc((size_t)argc + 1u, sizeof(*request->argv));
	request->envp = calloc((size_t)envc + 1u, sizeof(*request->envp));
	if (request->argv == NULL || request->envp == NULL) goto fail;
	for (uint16_t index = 0; index < argc; index++) {
		uint32_t item_length = 0;
		if (cursor_u32(&cursor, &item_length) < 0 ||
			item_length > KOGEN_SUPERVISOR_MAX_ARG_BYTES ||
			cursor_take(&cursor, item_length, &part) < 0 ||
			string_from_bytes(part, item_length, &request->argv[index]) < 0)
			goto fail;
	}
	if (request->argv[0][0] == '\0') {
		errno = EINVAL;
		goto fail;
	}
	for (uint16_t index = 0; index < envc; index++) {
		uint32_t item_length = 0;
		if (cursor_u32(&cursor, &item_length) < 0 || item_length == 0 ||
			item_length > KOGEN_SUPERVISOR_MAX_ENV_ENTRY_BYTES ||
			cursor_take(&cursor, item_length, &part) < 0 ||
			string_from_bytes(part, item_length, &request->envp[index]) < 0)
			goto fail;
		char *equals = strchr(request->envp[index], '=');
		if (equals == NULL || equals == request->envp[index]) {
			errno = EINVAL;
			goto fail;
		}
		for (uint16_t earlier = 0; earlier < index; earlier++) {
			const char *prior_equals = strchr(request->envp[earlier], '=');
			if (prior_equals != NULL &&
				(size_t)(prior_equals - request->envp[earlier]) ==
				(size_t)(equals - request->envp[index]) &&
				memcmp(request->envp[earlier], request->envp[index],
					(size_t)(equals - request->envp[index])) == 0) {
				errno = EINVAL;
				goto fail;
			}
		}
	}
	if (cursor_take(&cursor, stdin_length, &part) < 0 ||
		cursor.offset != cursor.length) {
		errno = EINVAL;
		goto fail;
	}
	if (stdin_length > 0) {
		request->stdin_bytes = malloc(stdin_length);
		if (request->stdin_bytes == NULL) goto fail;
		memcpy(request->stdin_bytes, part, stdin_length);
	}
	request->stdin_length = stdin_length;
	return 0;

fail: {
		int saved_error = errno;
		free_request(request);
		errno = saved_error;
		return -1;
	}
}

static int set_cloexec(int fd) {
	int flags = fcntl(fd, F_GETFD);
	if (flags < 0) return -1;
	return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static int set_nonblocking(int fd) {
	int flags = fcntl(fd, F_GETFL);
	if (flags < 0) return -1;
	return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int make_pipe(int descriptors[2]) {
	if (pipe(descriptors) < 0) return -1;
	if (set_cloexec(descriptors[0]) == 0 && set_cloexec(descriptors[1]) == 0)
		return 0;
	int saved_error = errno;
	close(descriptors[0]);
	close(descriptors[1]);
	errno = saved_error;
	return -1;
}

static void close_fd(int *fd) {
	if (*fd >= 0) {
		(void)close(*fd);
		*fd = -1;
	}
}

static uint64_t monotonic_ns(void) {
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
	return (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
}

static uint64_t add_ms(uint64_t start, uint64_t milliseconds) {
	return start + milliseconds * 1000000ULL;
}

static uint64_t elapsed_ms(uint64_t start, uint64_t end) {
	if (end <= start) return 0;
	return (end - start) / 1000000ULL;
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
		if (count == 0) errno = EIO;
		return -1;
	}
	return 0;
}

static const char *environment_value(char *const environment[],
	const char *name) {
	size_t name_length = strlen(name);
	for (size_t index = 0; environment[index] != NULL; index++) {
		const char *entry = environment[index];
		if (strncmp(entry, name, name_length) == 0 && entry[name_length] == '=')
			return entry + name_length + 1u;
	}
	return NULL;
}

static void exec_with_path(char *const arguments[], char *const environment[]) {
	if (strchr(arguments[0], '/') != NULL) {
		execve(arguments[0], arguments, environment);
		return;
	}
	const char *path = environment_value(environment, "PATH");
	if (path == NULL) {
		errno = ENOENT;
		return;
	}
	int denied = 0;
	const char *component = path;
	for (;;) {
		const char *separator = strchr(component, ':');
		size_t directory_length = separator == NULL
			? strlen(component)
			: (size_t)(separator - component);
		const char *directory = component;
		if (directory_length == 0) {
			directory = ".";
			directory_length = 1;
		}
		size_t file_length = strlen(arguments[0]);
		if (directory_length <= SIZE_MAX - file_length - 2u) {
			char *candidate = malloc(directory_length + file_length + 2u);
			if (candidate == NULL) return;
			memcpy(candidate, directory, directory_length);
			candidate[directory_length] = '/';
			memcpy(candidate + directory_length + 1u, arguments[0],
				file_length + 1u);
			execve(candidate, arguments, environment);
			int saved_error = errno;
			free(candidate);
			if (saved_error == EACCES) denied = 1;
			else if (saved_error != ENOENT && saved_error != ENOTDIR) {
				errno = saved_error;
				return;
			}
		}
		if (separator == NULL) break;
		component = separator + 1;
	}
	errno = denied ? EACCES : ENOENT;
}

static void reset_child_signals(void) {
	static const int signals[] = {SIGPIPE, SIGTERM, SIGINT, SIGHUP, SIGQUIT};
	struct sigaction action;
	memset(&action, 0, sizeof(action));
	action.sa_handler = SIG_DFL;
	(void)sigemptyset(&action.sa_mask);
	for (size_t index = 0; index < sizeof(signals) / sizeof(signals[0]); index++)
		(void)sigaction(signals[index], &action, NULL);
}

static int capture_identity(pid_t pid, struct process_identity *identity) {
	identity->pid = pid;
#ifdef __APPLE__
	struct proc_bsdinfo information;
	int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information,
		(int)sizeof(information));
	if (count != (int)sizeof(information) ||
		information.pbi_pid != (uint32_t)pid ||
		information.pbi_pgid != (uint32_t)pid) {
		errno = ESRCH;
		return -1;
	}
	identity->start_seconds = (uint64_t)information.pbi_start_tvsec;
	identity->start_microseconds = (uint64_t)information.pbi_start_tvusec;
#else
	if (getpgid(pid) != pid) {
		errno = ESRCH;
		return -1;
	}
#endif
	return 0;
}

static int identity_is_current(const struct process_identity *identity) {
#ifdef __APPLE__
	struct proc_bsdinfo information;
	int count = proc_pidinfo(identity->pid, PROC_PIDTBSDINFO, 0, &information,
		(int)sizeof(information));
	return count == (int)sizeof(information) &&
		information.pbi_pid == (uint32_t)identity->pid &&
		information.pbi_pgid == (uint32_t)identity->pid &&
		(uint64_t)information.pbi_start_tvsec == identity->start_seconds &&
		(uint64_t)information.pbi_start_tvusec == identity->start_microseconds;
#else
	return getpgid(identity->pid) == identity->pid;
#endif
}

static int signal_group(const struct process_identity *identity, int signal_number) {
	if (!identity_is_current(identity)) {
		errno = ESRCH;
		return -1;
	}
	return kill(-identity->pid, signal_number);
}

static void guardian_main(const struct owned_request *request,
	int control_fd, const int input_pipe[2], const int output_pipe[2],
	const int error_pipe[2], const int status_pipe[2]) {
	(void)close(control_fd);
	if (setsid() < 0) _exit(126);
	(void)close(STDIN_FILENO);
	(void)close(STDOUT_FILENO);
	(void)close(STDERR_FILENO);
	struct sigaction ignore_term;
	memset(&ignore_term, 0, sizeof(ignore_term));
	ignore_term.sa_handler = SIG_IGN;
	(void)sigemptyset(&ignore_term.sa_mask);
	if (sigaction(SIGTERM, &ignore_term, NULL) < 0) _exit(126);
	pid_t command = fork();
	if (command < 0) _exit(126);
	if (command == 0) {
		close(input_pipe[1]);
		close(output_pipe[0]);
		close(error_pipe[0]);
		close(status_pipe[0]);
		if (dup2(input_pipe[0], STDIN_FILENO) < 0 ||
			dup2(output_pipe[1], STDOUT_FILENO) < 0 ||
			dup2(error_pipe[1], STDERR_FILENO) < 0)
			_exit(126);
		close(input_pipe[0]);
		close(output_pipe[1]);
		close(error_pipe[1]);
		close(status_pipe[1]);
		if (request->cwd != NULL && chdir(request->cwd) < 0) _exit(126);
		reset_child_signals();
		exec_with_path(request->argv, request->envp);
		_exit(errno == EACCES ? 126 : 127);
	}
	close(input_pipe[0]);
	close(input_pipe[1]);
	close(output_pipe[0]);
	close(output_pipe[1]);
	close(error_pipe[0]);
	close(error_pipe[1]);
	close(status_pipe[0]);
	int child_status = 0;
	while (waitpid(command, &child_status, 0) < 0) {
		if (errno == EINTR) continue;
		child_status = -1;
		break;
	}
	int32_t wire_status = (int32_t)child_status;
	(void)write_all(status_pipe[1], (const uint8_t *)&wire_status,
		sizeof(wire_status));
	close(status_pipe[1]);
	for (;;) (void)pause();
}

static void tail_append(struct byte_tail *tail, const uint8_t *bytes,
	size_t length) {
	if (UINT64_MAX - tail->total < (uint64_t)length)
		tail->total = UINT64_MAX;
	else
		tail->total += (uint64_t)length;
	if (tail->capacity == 0 || length == 0) return;
	if (length >= tail->capacity) {
		memcpy(tail->bytes, bytes + length - tail->capacity, tail->capacity);
		tail->used = tail->capacity;
		tail->next = 0;
		return;
	}
	size_t first = tail->capacity - tail->next;
	if (first > length) first = length;
	memcpy(tail->bytes + tail->next, bytes, first);
	if (first < length) memcpy(tail->bytes, bytes + first, length - first);
	tail->next = (tail->next + length) % tail->capacity;
	if (tail->used < tail->capacity) {
		tail->used += length;
		if (tail->used > tail->capacity) tail->used = tail->capacity;
	}
}

static int drain_output(int *fd, struct byte_tail *tail) {
	uint8_t buffer[32768];
	size_t drained = 0;
	while (drained < sizeof(buffer) * 2u) {
		size_t capacity = sizeof(buffer) * 2u - drained;
		if (capacity > sizeof(buffer)) capacity = sizeof(buffer);
		ssize_t count = read(*fd, buffer, capacity);
		if (count > 0) {
			tail_append(tail, buffer, (size_t)count);
			drained += (size_t)count;
			continue;
		}
		if (count == 0) {
			close_fd(fd);
			return 0;
		}
		if (errno == EINTR) continue;
		if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
		close_fd(fd);
		return -1;
	}
	return 0;
}

static int write_input(int *fd, const uint8_t *bytes, size_t length,
	size_t *offset) {
	while (*offset < length) {
		ssize_t count = write(*fd, bytes + *offset, length - *offset);
		if (count > 0) {
			*offset += (size_t)count;
			return 0;
		}
		if (count < 0 && errno == EINTR) continue;
		if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
		close_fd(fd);
		return 0;
	}
	close_fd(fd);
	return 0;
}

static int control_channel_closed(int fd) {
	struct pollfd descriptor = {
		.fd = fd,
		.events = POLLIN | POLLHUP | POLLERR,
	};
	int ready = poll(&descriptor, 1, 0);
	if (ready == 0) return 0;
	if (ready < 0) return errno == EINTR ? 0 : 1;
	if ((descriptor.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) == 0)
		return 0;
	uint8_t byte = 0;
	ssize_t count = recv(fd, &byte, 1, MSG_PEEK);
	if (count == 0) return 1;
	if (count > 0) return 1;
	if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
	return 1;
}

static int read_child_status(int *fd, int32_t *status_out, int *have_status) {
	uint8_t bytes[sizeof(int32_t)];
	size_t offset = 0;
	while (offset < sizeof(bytes)) {
		ssize_t count = read(*fd, bytes + offset, sizeof(bytes) - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count == 0) {
			close_fd(fd);
			if (offset > 0) {
				errno = EPROTO;
				return -1;
			}
			return 0;
		}
		if (errno == EINTR) continue;
		if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
		close_fd(fd);
		return -1;
	}
	memcpy(status_out, bytes, sizeof(*status_out));
	*have_status = 1;
	close_fd(fd);
	return 0;
}

static int socket_is_stream(int fd) {
	int type = 0;
	socklen_t length = (socklen_t)sizeof(type);
	if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) < 0 ||
		type != SOCK_STREAM) {
		errno = EBADF;
		return -1;
	}
	return 0;
}

static int make_subreaper(void) {
#ifdef __linux__
	return prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
#else
	return 0;
#endif
}

static void reap_adopted_children(void) {
#ifdef __linux__
	for (;;) {
		int status = 0;
		pid_t result = waitpid(-1, &status, WNOHANG);
		if (result <= 0) break;
	}
#endif
}

static int milliseconds_until(uint64_t now, uint64_t deadline) {
	if (deadline <= now) return 0;
	uint64_t remaining = deadline - now;
	uint64_t milliseconds = (remaining + 999999ULL) / 1000000ULL;
	if (milliseconds > KOGEN_SUPERVISOR_POLL_MAX_MS)
		milliseconds = KOGEN_SUPERVISOR_POLL_MAX_MS;
	return (int)milliseconds;
}

static int run_process(const struct owned_request *request, int control_fd,
	struct byte_tail *stdout_tail, struct byte_tail *stderr_tail,
	uint64_t *duration_out, int32_t *child_status_out,
	uint8_t *termination_out) {
	if (socket_is_stream(control_fd) < 0 || make_subreaper() < 0) return -1;
	int input_pipe[2] = {-1, -1};
	int output_pipe[2] = {-1, -1};
	int error_pipe[2] = {-1, -1};
	int status_pipe[2] = {-1, -1};
	if (make_pipe(input_pipe) < 0 || make_pipe(output_pipe) < 0 ||
		make_pipe(error_pipe) < 0 || make_pipe(status_pipe) < 0)
		goto fail_pipes;
	(void)signal(SIGPIPE, SIG_IGN);
	uint64_t started = monotonic_ns();
	if (started == 0) {
		errno = EIO;
		goto fail_pipes;
	}
	pid_t owner_pid = getppid();
	pid_t guardian = fork();
	if (guardian < 0) goto fail_pipes;
	if (guardian == 0)
		guardian_main(request, control_fd, input_pipe, output_pipe, error_pipe,
			status_pipe);
	close_fd(&input_pipe[0]);
	close_fd(&output_pipe[1]);
	close_fd(&error_pipe[1]);
	close_fd(&status_pipe[1]);
	struct process_identity identity;
	int identity_ready = 0;
	for (unsigned int attempt = 0; attempt < 100; attempt++) {
		if (capture_identity(guardian, &identity) == 0) {
			identity_ready = 1;
			break;
		}
		struct timespec pause_time = {.tv_sec = 0, .tv_nsec = 1000000L};
		(void)nanosleep(&pause_time, NULL);
	}
	if (!identity_ready || set_nonblocking(input_pipe[1]) < 0 ||
		set_nonblocking(output_pipe[0]) < 0 ||
		set_nonblocking(error_pipe[0]) < 0 ||
		set_nonblocking(status_pipe[0]) < 0) {
		int saved_error = errno == 0 ? EIO : errno;
		(void)kill(guardian, SIGKILL);
		(void)waitpid(guardian, NULL, 0);
		errno = saved_error;
		goto fail_pipes;
	}
	if (request->stdin_length == 0) close_fd(&input_pipe[1]);
	uint64_t deadline = add_ms(started, request->timeout_ms);
	uint64_t grace_deadline = 0;
	uint64_t drain_deadline = 0;
	size_t input_offset = 0;
	int32_t child_status = -1;
	int have_status = 0;
	int guardian_reaped = 0;
	int grace_active = 0;
	int kill_sent = 0;
	int parent_died = 0;
	int timed_out = 0;
	for (;;) {
		if (status_pipe[0] >= 0 &&
			read_child_status(&status_pipe[0], &child_status,
				&have_status) < 0 && errno != EPROTO)
			child_status = -1;
		uint64_t now = monotonic_ns();
		if (now == 0) now = started;
		int control_closed = control_channel_closed(control_fd);
		int owner_disappeared = getppid() != owner_pid;
		if (!parent_died && (control_closed || owner_disappeared)) {
			parent_died = 1;
			*termination_out = KOGEN_SUPERVISOR_PARENT_DIED;
			close_fd(&input_pipe[1]);
			if (!grace_active && !guardian_reaped) {
				int signal_result = signal_group(&identity, SIGTERM);
				(void)signal_result;
				grace_active = 1;
				grace_deadline = add_ms(now, 200);
			}
		}
		if (!have_status && !timed_out && !parent_died && now >= deadline) {
			timed_out = 1;
			*termination_out = KOGEN_SUPERVISOR_TIMED_OUT;
			close_fd(&input_pipe[1]);
			if (!grace_active && !guardian_reaped) {
				(void)signal_group(&identity, SIGTERM);
				grace_active = 1;
				grace_deadline = add_ms(now, 200);
			}
		}
		if (have_status && !grace_active && !guardian_reaped) {
			(void)signal_group(&identity, SIGTERM);
			grace_active = 1;
			grace_deadline = add_ms(now, 200);
		}
		if (grace_active && !kill_sent && now >= grace_deadline &&
			!guardian_reaped) {
			(void)signal_group(&identity, SIGKILL);
			kill_sent = 1;
			drain_deadline = add_ms(now, 500);
		}
		if (input_pipe[1] >= 0)
			(void)write_input(&input_pipe[1], request->stdin_bytes,
				request->stdin_length, &input_offset);
		if (output_pipe[0] >= 0) (void)drain_output(&output_pipe[0], stdout_tail);
		if (error_pipe[0] >= 0) (void)drain_output(&error_pipe[0], stderr_tail);
		if (!guardian_reaped) {
			int wait_status = 0;
			pid_t waited = waitpid(guardian, &wait_status, WNOHANG);
			if (waited == guardian || (waited < 0 && errno == ECHILD)) {
				guardian_reaped = 1;
				if (!have_status) {
					child_status = -1;
					close_fd(&status_pipe[0]);
				}
				reap_adopted_children();
			}
		}
		if (kill_sent && now >= drain_deadline) {
			close_fd(&output_pipe[0]);
			close_fd(&error_pipe[0]);
		}
		if (guardian_reaped && output_pipe[0] < 0 && error_pipe[0] < 0) break;
		struct pollfd descriptors[5];
		nfds_t count = 0;
		int input_index = -1;
		int stdout_index = -1;
		int stderr_index = -1;
		int status_index = -1;
		int control_index = -1;
		if (input_pipe[1] >= 0) {
			input_index = (int)count;
			descriptors[count++] = (struct pollfd){
				.fd = input_pipe[1], .events = POLLOUT,
			};
		}
		if (output_pipe[0] >= 0) {
			stdout_index = (int)count;
			descriptors[count++] = (struct pollfd){
				.fd = output_pipe[0], .events = POLLIN | POLLHUP | POLLERR,
			};
		}
		if (error_pipe[0] >= 0) {
			stderr_index = (int)count;
			descriptors[count++] = (struct pollfd){
				.fd = error_pipe[0], .events = POLLIN | POLLHUP | POLLERR,
			};
		}
		if (status_pipe[0] >= 0) {
			status_index = (int)count;
			descriptors[count++] = (struct pollfd){
				.fd = status_pipe[0], .events = POLLIN | POLLHUP | POLLERR,
			};
		}
		if (!parent_died) {
			control_index = (int)count;
			descriptors[count++] = (struct pollfd){
				.fd = control_fd, .events = POLLIN | POLLHUP | POLLERR,
			};
		}
		uint64_t next_deadline = deadline;
		if (grace_active && !kill_sent && grace_deadline < next_deadline)
			next_deadline = grace_deadline;
		if (kill_sent && drain_deadline < next_deadline)
			next_deadline = drain_deadline;
		int timeout = milliseconds_until(now, next_deadline);
		int polled = poll(descriptors, count, timeout);
		if (polled < 0 && errno != EINTR) {
			int saved_error = errno;
			if (!grace_active && !guardian_reaped) {
				(void)signal_group(&identity, SIGTERM);
				struct timespec grace = {.tv_sec = 0,
					.tv_nsec = (long)KOGEN_SUPERVISOR_GRACE_NS};
				while (nanosleep(&grace, &grace) < 0 && errno == EINTR) {
				}
				(void)signal_group(&identity, SIGKILL);
			}
			(void)waitpid(guardian, NULL, 0);
			close_fd(&input_pipe[1]);
			close_fd(&output_pipe[0]);
			close_fd(&error_pipe[0]);
			close_fd(&status_pipe[0]);
			errno = saved_error;
			return -1;
		}
		if (polled > 0) {
			if (input_index >= 0 && (descriptors[input_index].revents &
				(POLLOUT | POLLHUP | POLLERR | POLLNVAL)) != 0)
				(void)write_input(&input_pipe[1], request->stdin_bytes,
					request->stdin_length, &input_offset);
			if (stdout_index >= 0 && (descriptors[stdout_index].revents &
				(POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0)
				(void)drain_output(&output_pipe[0], stdout_tail);
			if (stderr_index >= 0 && (descriptors[stderr_index].revents &
				(POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0)
				(void)drain_output(&error_pipe[0], stderr_tail);
			if (status_index >= 0 && (descriptors[status_index].revents &
				(POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0)
				(void)read_child_status(&status_pipe[0], &child_status,
					&have_status);
			if (control_index >= 0 && (descriptors[control_index].revents &
				(POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0 &&
				!parent_died && control_channel_closed(control_fd)) {
				parent_died = 1;
				*termination_out = KOGEN_SUPERVISOR_PARENT_DIED;
				close_fd(&input_pipe[1]);
				if (!grace_active && !guardian_reaped) {
					int signal_result = signal_group(&identity, SIGTERM);
					(void)signal_result;
					grace_active = 1;
					grace_deadline = add_ms(monotonic_ns(), 200);
				}
			}
		}
	}
	if (guardian_reaped) reap_adopted_children();
	*duration_out = elapsed_ms(started, monotonic_ns());
	*child_status_out = child_status;
	if (!timed_out && !parent_died)
		*termination_out = KOGEN_SUPERVISOR_EXITED;
	close_fd(&input_pipe[1]);
	close_fd(&output_pipe[0]);
	close_fd(&error_pipe[0]);
	close_fd(&status_pipe[0]);
	return 0;

fail_pipes: {
	int saved_error = errno;
	close_fd(&input_pipe[0]);
	close_fd(&input_pipe[1]);
	close_fd(&output_pipe[0]);
	close_fd(&output_pipe[1]);
	close_fd(&error_pipe[0]);
	close_fd(&error_pipe[1]);
	close_fd(&status_pipe[0]);
	close_fd(&status_pipe[1]);
	errno = saved_error;
	return -1;
}
}

static void encode_tail(const struct byte_tail *tail, uint8_t *output) {
	if (tail->used == 0) return;
	if (tail->used < tail->capacity) {
		memcpy(output, tail->bytes, tail->used);
		return;
	}
	size_t first = tail->capacity - tail->next;
	memcpy(output, tail->bytes + tail->next, first);
	if (tail->next > 0) memcpy(output + first, tail->bytes, tail->next);
}

int kogen_supervisor_handle_request(const uint8_t *request,
	size_t request_length, int control_fd, uint8_t *response,
	size_t response_capacity, size_t *response_length) {
	if (response == NULL || response_length == NULL ||
		response_capacity < KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES) {
		errno = EINVAL;
		return -1;
	}
	*response_length = 0;
	struct owned_request parsed;
	if (parse_request(request, request_length, &parsed) < 0) return -1;
	if (parsed.stdout_limit > response_capacity -
		KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES ||
		parsed.stderr_limit > response_capacity -
		KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES - parsed.stdout_limit) {
		free_request(&parsed);
		errno = EMSGSIZE;
		return -1;
	}
	struct byte_tail stdout_tail = {
		.capacity = parsed.stdout_limit,
		.bytes = parsed.stdout_limit == 0 ? NULL : malloc(parsed.stdout_limit),
	};
	struct byte_tail stderr_tail = {
		.capacity = parsed.stderr_limit,
		.bytes = parsed.stderr_limit == 0 ? NULL : malloc(parsed.stderr_limit),
	};
	if ((stdout_tail.capacity > 0 && stdout_tail.bytes == NULL) ||
		(stderr_tail.capacity > 0 && stderr_tail.bytes == NULL)) {
		free(stdout_tail.bytes);
		free(stderr_tail.bytes);
		free_request(&parsed);
		return -1;
	}
	int32_t child_status = -1;
	uint64_t duration = 0;
	uint8_t termination = KOGEN_SUPERVISOR_EXITED;
	int result = run_process(&parsed, control_fd, &stdout_tail, &stderr_tail,
		&duration, &child_status, &termination);
	int saved_error = errno;
	free_request(&parsed);
	if (result < 0) {
		free(stdout_tail.bytes);
		free(stderr_tail.bytes);
		errno = saved_error;
		return -1;
	}
	write_u16be(response, KOGEN_SUPERVISOR_REQUEST_VERSION);
	response[2] = termination;
	response[3] = 0;
	int32_t exit_code = -1;
	uint32_t signal_number = 0;
	if (child_status >= 0 && WIFEXITED(child_status))
		exit_code = (int32_t)WEXITSTATUS(child_status);
	else if (child_status >= 0 && WIFSIGNALED(child_status))
		signal_number = (uint32_t)WTERMSIG(child_status);
	else if (child_status < 0 &&
		(termination == KOGEN_SUPERVISOR_TIMED_OUT ||
			termination == KOGEN_SUPERVISOR_PARENT_DIED))
		signal_number = (uint32_t)SIGKILL;
	write_u32be(response + 4, (uint32_t)exit_code);
	write_u32be(response + 8, signal_number);
	write_u64be(response + 12, duration);
	write_u64be(response + 20, stdout_tail.total);
	write_u64be(response + 28, stderr_tail.total);
	write_u32be(response + 36, (uint32_t)stdout_tail.used);
	write_u32be(response + 40, (uint32_t)stderr_tail.used);
	encode_tail(&stdout_tail, response + KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES);
	encode_tail(&stderr_tail, response + KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES +
		stdout_tail.used);
	*response_length = KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES +
		stdout_tail.used + stderr_tail.used;
	free(stdout_tail.bytes);
	free(stderr_tail.bytes);
	return 0;
}
