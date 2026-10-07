#define _POSIX_C_SOURCE 200809L

#include "keychain.h"

#include <errno.h>
#include <string.h>

static uint16_t read_u16be(const uint8_t *bytes) {
	return (uint16_t)(((uint16_t)bytes[0] << 8) | (uint16_t)bytes[1]);
}

static uint32_t read_u32be(const uint8_t *bytes) {
	return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
		((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static void write_u32be(uint8_t *bytes, uint32_t value) {
	bytes[0] = (uint8_t)(value >> 24);
	bytes[1] = (uint8_t)(value >> 16);
	bytes[2] = (uint8_t)(value >> 8);
	bytes[3] = (uint8_t)value;
}

static int label_character(uint8_t value) {
	return (value >= (uint8_t)'A' && value <= (uint8_t)'Z') ||
		(value >= (uint8_t)'a' && value <= (uint8_t)'z') ||
		(value >= (uint8_t)'0' && value <= (uint8_t)'9') ||
		value == (uint8_t)'.' || value == (uint8_t)'_' ||
		value == (uint8_t)'-';
}

static int valid_account(const uint8_t *account, size_t length) {
	static const uint8_t chatgpt[] = "chatgpt:";
	static const uint8_t grok[] = "grok:";
	const uint8_t *label = NULL;
	size_t prefix_length = 0;
	if (account == NULL || length == 0 ||
		memchr(account, '\0', length) != NULL)
		return 0;
	if (length > sizeof(chatgpt) - 1u &&
		memcmp(account, chatgpt, sizeof(chatgpt) - 1u) == 0) {
		label = account + sizeof(chatgpt) - 1u;
		prefix_length = sizeof(chatgpt) - 1u;
	} else if (length > sizeof(grok) - 1u &&
		memcmp(account, grok, sizeof(grok) - 1u) == 0) {
		label = account + sizeof(grok) - 1u;
		prefix_length = sizeof(grok) - 1u;
	} else {
		return 0;
	}

	size_t separator = prefix_length;
	while (separator < length && account[separator] != (uint8_t)':')
		separator++;
	size_t label_length = separator - prefix_length;
	if (label_length == 0 || label_length > 64u ||
		!((label[0] >= (uint8_t)'A' && label[0] <= (uint8_t)'Z') ||
			(label[0] >= (uint8_t)'a' && label[0] <= (uint8_t)'z') ||
			(label[0] >= (uint8_t)'0' && label[0] <= (uint8_t)'9')))
		return 0;
	for (size_t index = 1; index < label_length; index++) {
		if (!label_character(label[index])) return 0;
	}
	if (separator == length) return 0;
	static const uint8_t key_suffix[] = ":key";
	return length - separator == sizeof(key_suffix) - 1u &&
		memcmp(account + separator, key_suffix, sizeof(key_suffix) - 1u) == 0;
}

static int encode_response(uint8_t *response, size_t capacity,
	size_t *response_length, enum kogen_keychain_status status,
	const uint8_t *data, size_t data_length) {
	if (response == NULL || response_length == NULL ||
		capacity < KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES ||
		data_length > capacity - KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES ||
		(data_length > 0 && data == NULL)) {
		errno = EMSGSIZE;
		return -1;
	}
	response[0] = (uint8_t)status;
	write_u32be(response + 1, (uint32_t)data_length);
	if (data_length > 0)
		memcpy(response + KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES, data,
			data_length);
	*response_length = KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES + data_length;
	return 0;
}

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

static CFStringRef account_string(const uint8_t *bytes, size_t length) {
	return CFStringCreateWithBytes(kCFAllocatorDefault, bytes,
		(CFIndex)length, kCFStringEncodingUTF8, false);
}

static CFMutableDictionaryRef base_query(CFStringRef account) {
	CFMutableDictionaryRef query = CFDictionaryCreateMutable(kCFAllocatorDefault,
		0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	if (query == NULL) return NULL;
	CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
	CFDictionarySetValue(query, kSecAttrService,
		CFSTR(KOGEN_KEYCHAIN_SERVICE));
	CFDictionarySetValue(query, kSecAttrAccount, account);
	CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanFalse);
	return query;
}

static enum kogen_keychain_status status_for_security(OSStatus status) {
	if (status == errSecItemNotFound) return KOGEN_KEYCHAIN_NOT_FOUND;
	if (status == errSecDuplicateItem) return KOGEN_KEYCHAIN_CONFLICT;
	if (status == errSecAuthFailed || status == errSecInteractionNotAllowed ||
		status == errSecUserCanceled || status == errSecNoAccessForItem)
		return KOGEN_KEYCHAIN_PERMISSION;
	return KOGEN_KEYCHAIN_IO;
}

static enum kogen_keychain_status get_key(CFStringRef account,
	uint8_t *response, size_t response_capacity, size_t *response_length) {
	CFMutableDictionaryRef query = base_query(account);
	if (query == NULL) return KOGEN_KEYCHAIN_IO;
	CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
	CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
	CFTypeRef item = NULL;
	OSStatus result = SecItemCopyMatching(query, &item);
	CFRelease(query);
	if (result != errSecSuccess)
		return status_for_security(result);
	if (item == NULL || CFGetTypeID(item) != CFDataGetTypeID()) {
		if (item != NULL) CFRelease(item);
		return KOGEN_KEYCHAIN_IO;
	}
	CFDataRef data = (CFDataRef)item;
	CFIndex length = CFDataGetLength(data);
	if (length != (CFIndex)KOGEN_KEYCHAIN_KEY_BYTES) {
		CFRelease(data);
		return KOGEN_KEYCHAIN_IO;
	}
	const UInt8 *bytes = CFDataGetBytePtr(data);
	int encoded = encode_response(response, response_capacity, response_length,
		KOGEN_KEYCHAIN_OK, bytes, KOGEN_KEYCHAIN_KEY_BYTES);
	CFRelease(data);
	return encoded == 0 ? KOGEN_KEYCHAIN_OK : KOGEN_KEYCHAIN_IO;
}

static enum kogen_keychain_status add_key(CFStringRef account,
	const uint8_t *bytes) {
	CFMutableDictionaryRef query = base_query(account);
	if (query == NULL) return KOGEN_KEYCHAIN_IO;
	CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault,
		(CFIndex)KOGEN_KEYCHAIN_KEY_BYTES);
	if (data == NULL) {
		CFRelease(query);
		return KOGEN_KEYCHAIN_IO;
	}
	CFDataAppendBytes(data, bytes, (CFIndex)KOGEN_KEYCHAIN_KEY_BYTES);
	CFDictionarySetValue(query, kSecValueData, data);
	CFDictionarySetValue(query, kSecAttrAccessible,
		kSecAttrAccessibleWhenUnlocked);
	OSStatus result = SecItemAdd(query, NULL);
	volatile UInt8 *stored = CFDataGetMutableBytePtr(data);
	if (stored != NULL) {
		for (size_t index = 0; index < KOGEN_KEYCHAIN_KEY_BYTES; index++)
			stored[index] = 0;
	}
	CFRelease(data);
	CFRelease(query);
	return result == errSecSuccess ? KOGEN_KEYCHAIN_OK :
		status_for_security(result);
}

static enum kogen_keychain_status delete_key(CFStringRef account) {
	CFMutableDictionaryRef query = base_query(account);
	if (query == NULL) return KOGEN_KEYCHAIN_IO;
	OSStatus result = SecItemDelete(query);
	CFRelease(query);
	return result == errSecSuccess ? KOGEN_KEYCHAIN_OK :
		status_for_security(result);
}
#endif

int kogen_keychain_handle_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length) {
	if (response_length != NULL) *response_length = 0;
	if (request == NULL || response == NULL || response_length == NULL ||
		request_length < KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES ||
		response_capacity < KOGEN_KEYCHAIN_RESPONSE_HEADER_BYTES) {
		errno = EINVAL;
		return -1;
	}
	uint8_t action = request[0];
	size_t account_length = (size_t)read_u16be(request + 1);
	size_t data_length = (size_t)read_u32be(request + 3);
	if (account_length == 0 ||
		account_length > KOGEN_KEYCHAIN_MAX_ACCOUNT_BYTES ||
		request_length != KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES +
			account_length + data_length ||
		!valid_account(request + KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES,
			account_length)) {
		return encode_response(response, response_capacity, response_length,
			KOGEN_KEYCHAIN_INVALID, NULL, 0);
	}
	if ((action == KOGEN_KEYCHAIN_ADD &&
			data_length != KOGEN_KEYCHAIN_KEY_BYTES) ||
		((action == KOGEN_KEYCHAIN_GET || action == KOGEN_KEYCHAIN_DELETE) &&
			data_length != 0) ||
		(action != KOGEN_KEYCHAIN_ADD && action != KOGEN_KEYCHAIN_GET &&
			action != KOGEN_KEYCHAIN_DELETE)) {
		return encode_response(response, response_capacity, response_length,
			KOGEN_KEYCHAIN_INVALID, NULL, 0);
	}

#ifdef __APPLE__
	const uint8_t *account_bytes = request +
		KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES;
	CFStringRef account = account_string(account_bytes, account_length);
	if (account == NULL)
		return encode_response(response, response_capacity, response_length,
			KOGEN_KEYCHAIN_INVALID, NULL, 0);
	enum kogen_keychain_status status;
	if (action == KOGEN_KEYCHAIN_GET) {
		status = get_key(account, response, response_capacity, response_length);
		CFRelease(account);
		if (*response_length != 0) return 0;
	} else if (action == KOGEN_KEYCHAIN_ADD) {
		status = add_key(account, request + KOGEN_KEYCHAIN_REQUEST_HEADER_BYTES +
			account_length);
		CFRelease(account);
	} else {
		status = delete_key(account);
		CFRelease(account);
	}
	return encode_response(response, response_capacity, response_length,
		status, NULL, 0);
#else
	(void)action;
	return encode_response(response, response_capacity, response_length,
		KOGEN_KEYCHAIN_UNAVAILABLE, NULL, 0);
#endif
}
