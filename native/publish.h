#ifndef KOGEN_PUBLISH_H
#define KOGEN_PUBLISH_H

#include "paths.h"

#define KOGEN_HOST_OP_FS_PUBLISH 0x0302u
#define KOGEN_FS_PUBLISH_REQUEST_HEADER_BYTES 16u

enum kogen_fs_publish_action {
	KOGEN_FS_PUBLISH_ATOMIC_WRITE = 1,
	KOGEN_FS_PUBLISH_APPEND = 2,
	KOGEN_FS_PUBLISH_REMOVE = 3,
	KOGEN_FS_PUBLISH_RESTORE = 4,
};

enum kogen_fs_restore_kind {
	KOGEN_FS_RESTORE_REGULAR = 1,
	KOGEN_FS_RESTORE_SYMLINK = 2,
	KOGEN_FS_RESTORE_DIRECTORY = 3,
	KOGEN_FS_RESTORE_ABSENT = 4,
};

enum kogen_fs_publish_phase {
	KOGEN_FS_PUBLISH_PHASE_TEMP_CREATED = 1,
	KOGEN_FS_PUBLISH_PHASE_DATA_WRITTEN = 2,
	KOGEN_FS_PUBLISH_PHASE_FILE_SYNCED = 3,
	KOGEN_FS_PUBLISH_PHASE_RENAMED = 4,
	KOGEN_FS_PUBLISH_PHASE_PARENT_SYNCED = 5,
};

/*
 * Payload: action:u8, restore_kind:u8, mode:u16be, root_length:u32be,
 * path_length:u32be, data_length:u32be, root bytes, relative path bytes,
 * data bytes. Response is one stable filesystem status byte.
 *
 * Published files are private: mode 0600 for non-executable files and 0700
 * for executable files. Directory restoration uses 0700. Symlink target bytes
 * are retained exactly and are never followed by restore or removal.
 */
enum kogen_fs_status kogen_fs_handle_publish_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length);

#ifdef KOGEN_FS_PUBLISH_TESTING
typedef void (*kogen_fs_publish_test_hook)(enum kogen_fs_publish_phase phase,
	void *context);
void kogen_fs_publish_set_test_hook(kogen_fs_publish_test_hook hook,
	void *context);
#endif

#endif
