#ifndef KOGEN_SUPERVISOR_H
#define KOGEN_SUPERVISOR_H

#include <stddef.h>
#include <stdint.h>

#define KOGEN_HOST_OP_PROCESS_SUPERVISE 0x0303u
#define KOGEN_SUPERVISOR_REQUEST_VERSION 1u
#define KOGEN_SUPERVISOR_REQUEST_HEADER_BYTES 32u
#define KOGEN_SUPERVISOR_RESPONSE_HEADER_BYTES 44u
#define KOGEN_SUPERVISOR_MAX_ARG_BYTES 4096u
#define KOGEN_SUPERVISOR_MAX_ARGS 256u
#define KOGEN_SUPERVISOR_MAX_ENV 512u
#define KOGEN_SUPERVISOR_MAX_TIMEOUT_MS 86400000u

enum kogen_supervisor_termination {
	KOGEN_SUPERVISOR_EXITED = 0,
	KOGEN_SUPERVISOR_TIMED_OUT = 1,
	KOGEN_SUPERVISOR_PARENT_DIED = 2,
};

/*
 * Request payload (all integers big-endian):
 * version:u16, flags:u16, timeout_ms:u64, stdout_tail:u32, stderr_tail:u32,
 * cwd_length:u32, argc:u16, envc:u16, stdin_length:u32, then cwd bytes,
 * argc (length:u32, bytes) arguments, envc (length:u32, bytes) KEY=VALUE
 * entries, then stdin bytes. argv elements are limited to 4096 bytes.
 *
 * Response payload: version:u16, termination:u8, reserved:u8,
 * exit_code:i32 (-1 unless normally exited), signal:u32 (0 unless signalled),
 * duration_ms:u64, stdout_total:u64, stderr_total:u64,
 * stdout_tail_length:u32, stderr_tail_length:u32, then both byte tails.
 */
int kogen_supervisor_handle_request(const uint8_t *request,
	size_t request_length, int control_fd, uint8_t *response,
	size_t response_capacity, size_t *response_length);

#endif
