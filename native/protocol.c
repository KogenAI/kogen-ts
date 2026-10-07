#define _POSIX_C_SOURCE 200809L

#include "protocol.h"

#include <errno.h>
#include <limits.h>
#include <unistd.h>

static uint16_t read_u16be(const uint8_t *bytes) {
	return (uint16_t)(((uint16_t)bytes[0] << 8) | (uint16_t)bytes[1]);
}

static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
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

/* 1 means complete, 0 means EOF before any byte, and -1 means partial/error. */
static int read_exact(int fd, uint8_t *bytes, size_t length, int allow_empty_eof) {
	size_t offset = 0;
	while (offset < length) {
		ssize_t count = read(fd, bytes + offset, length - offset);
		if (count > 0) {
			offset += (size_t)count;
			continue;
		}
		if (count == 0) {
			if (offset == 0 && allow_empty_eof) return 0;
			errno = EPROTO;
			return -1;
		}
		if (errno == EINTR) continue;
		return -1;
	}
	return 1;
}

static int write_exact(int fd, const uint8_t *bytes, size_t length) {
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

int kogen_host_read_frame(int fd, uint8_t *buffer, size_t capacity,
	struct kogen_host_frame *frame) {
	uint8_t prefix[KOGEN_HOST_FRAME_PREFIX_BYTES];
	int result = read_exact(fd, prefix, sizeof(prefix), 1);
	if (result <= 0) return result;

	uint32_t body_length = read_u32be(prefix);
	if (body_length < KOGEN_HOST_FRAME_HEADER_BYTES ||
		body_length > KOGEN_HOST_MAX_FRAME_BYTES || body_length > capacity) {
		errno = EMSGSIZE;
		return -1;
	}
	if (read_exact(fd, buffer, body_length, 0) < 0) return -1;

	frame->version = read_u16be(buffer);
	frame->operation = read_u16be(buffer + 2);
	frame->request_id = read_u32be(buffer + 4);
	frame->payload = buffer + KOGEN_HOST_FRAME_HEADER_BYTES;
	frame->payload_length =
		(size_t)body_length - KOGEN_HOST_FRAME_HEADER_BYTES;
	if (frame->version != KOGEN_HOST_PROTOCOL_VERSION) {
		errno = EPROTONOSUPPORT;
		return -1;
	}
	return 1;
}

int kogen_host_write_frame(int fd, uint16_t operation, uint32_t request_id,
	const uint8_t *payload, size_t payload_length) {
	if (payload_length > KOGEN_HOST_MAX_PAYLOAD_BYTES ||
		(payload_length > 0 && payload == NULL)) {
		errno = EMSGSIZE;
		return -1;
	}
	uint8_t header[KOGEN_HOST_FRAME_PREFIX_BYTES +
		KOGEN_HOST_FRAME_HEADER_BYTES];
	write_u32be(header, (uint32_t)(KOGEN_HOST_FRAME_HEADER_BYTES + payload_length));
	write_u16be(header + 4, KOGEN_HOST_PROTOCOL_VERSION);
	write_u16be(header + 6, operation);
	write_u32be(header + 8, request_id);
	if (write_exact(fd, header, sizeof(header)) < 0) return -1;
	if (payload_length > 0 && write_exact(fd, payload, payload_length) < 0)
		return -1;
	return 0;
}
