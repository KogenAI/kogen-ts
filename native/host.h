#ifndef KOGEN_HOST_H
#define KOGEN_HOST_H

#include <stddef.h>
#include <stdint.h>

#define KOGEN_HOST_PROTOCOL_VERSION 1u
#define KOGEN_HOST_FRAME_HEADER_BYTES 8u
#define KOGEN_HOST_FRAME_PREFIX_BYTES 4u
#define KOGEN_HOST_MAX_FRAME_BYTES (2u * 1024u * 1024u)
#define KOGEN_HOST_MAX_PAYLOAD_BYTES \
	(KOGEN_HOST_MAX_FRAME_BYTES - KOGEN_HOST_FRAME_HEADER_BYTES)
#define KOGEN_HOST_CONTROL_FD 3
#define KOGEN_HOST_RESPONSE_BIT 0x8000u

/*
 * Wire bytes are a 4-byte big-endian body length, then an 8-byte header:
 * version:u16, operation:u16, request_id:u32, all big-endian. The body limit
 * includes that header, excludes the length prefix, and bounds every payload.
 */

enum kogen_host_operation {
	KOGEN_HOST_OP_PING = 1,
	KOGEN_HOST_OP_ECHO = 2,
#ifdef KOGEN_HOST_TESTING
	KOGEN_HOST_OP_TEST_GROUP = 0x7f01,
#endif
	KOGEN_HOST_OP_ERROR = 0xffff,
};

struct kogen_host_frame {
	uint16_t version;
	uint16_t operation;
	uint32_t request_id;
	const uint8_t *payload;
	size_t payload_length;
};

/* Returns 1 for a frame, 0 for clean EOF before a frame, and -1 on error. */
int kogen_host_read_frame(int fd, uint8_t *buffer, size_t capacity,
	struct kogen_host_frame *frame);

/* Writes one complete frame. Payload bytes may contain any binary value. */
int kogen_host_write_frame(int fd, uint16_t operation, uint32_t request_id,
	const uint8_t *payload, size_t payload_length);

#endif
