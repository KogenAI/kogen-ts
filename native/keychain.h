#ifndef KOGEN_KEYCHAIN_H
#define KOGEN_KEYCHAIN_H

#include <stddef.h>
#include <stdint.h>

/* Registration in native/main.c belongs to the integration coordinator. */
#define KOGEN_HOST_OP_KEYCHAIN 0x0304u
#define KOGEN_KEYCHAIN_SERVICE "kogen"
#define KOGEN_KEYCHAIN_KEY_BYTES 32u
#define KOGEN_KEYCHAIN_MAX_ACCOUNT_BYTES 80u
#define KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES 7u
#define KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES 5u

enum kogen_keychain_action {
	KOGEN_KEYCHAIN_GET = 1,
	KOGEN_KEYCHAIN_ADD = 2,
	KOGEN_KEYCHAIN_DELETE = 3,
};

enum kogen_keychain_status {
	KOGEN_KEYCHAIN_OK = 0,
	KOGEN_KEYCHAIN_INVALID = 1,
	KOGEN_KEYCHAIN_NOT_FOUND = 2,
	KOGEN_KEYCHAIN_CONFLICT = 3,
	KOGEN_KEYCHAIN_PERMISSION = 4,
	KOGEN_KEYCHAIN_UNAVAILABLE = 5,
	KOGEN_KEYCHAIN_IO = 6,
};

/*
 * Request payload: action:u8, account_length:u16be, data_length:u32be,
 * account bytes, data bytes. The service is fixed to "kogen". Account names
 * are provider-scoped, for example "grok:work:key". ADD accepts one 32-byte
 * key; GET and DELETE accept no data.
 *
 * Response payload: status:u8, data_length:u32be, data bytes. GET returns the
 * key bytes. The only secret inputs and outputs cross the native boundary in
 * the helper's framed pipes; none are carried in argv or diagnostics.
 */
int kogen_keychain_handle_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length);

#endif
