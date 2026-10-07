#ifndef KOGEN_PATHS_H
#define KOGEN_PATHS_H

#include <stddef.h>
#include <stdint.h>

#define KOGEN_HOST_OP_FS_READ 0x0301u
#define KOGEN_FS_MAX_PATH_BYTES (64u * 1024u)
#define KOGEN_FS_MAX_ENTRIES 4096u
#define KOGEN_FS_MAX_RESPONSE_BYTES (2u * 1024u * 1024u - 8u)

enum kogen_fs_status {
	KOGEN_FS_OK = 0,
	KOGEN_FS_INVALID_PATH = 1,
	KOGEN_FS_NOT_FOUND = 2,
	KOGEN_FS_PERMISSION = 3,
	KOGEN_FS_OUTSIDE_ROOT = 4,
	KOGEN_FS_NOT_REGULAR = 5,
	KOGEN_FS_TOO_LARGE = 6,
	KOGEN_FS_IO = 7,
	KOGEN_FS_LIMIT = 8,
};

enum kogen_fs_entry_kind {
	KOGEN_FS_ENTRY_REGULAR = 1,
	KOGEN_FS_ENTRY_DIRECTORY = 2,
	KOGEN_FS_ENTRY_SYMLINK = 3,
	KOGEN_FS_ENTRY_OTHER = 4,
};

struct kogen_fs_root {
	int fd;
	char *canonical_path;
	size_t canonical_path_length;
	char *path_alias;
	size_t path_alias_length;
};

struct kogen_fs_entry {
	uint8_t *name;
	size_t name_length;
	enum kogen_fs_entry_kind kind;
};

struct kogen_fs_listing {
	struct kogen_fs_entry *entries;
	size_t count;
	size_t name_bytes;
};

/* Paths are POSIX byte strings; neither path argument needs to be UTF-8. */
enum kogen_fs_status kogen_fs_root_open(const uint8_t *path, size_t path_length,
	struct kogen_fs_root *root);
void kogen_fs_root_close(struct kogen_fs_root *root);

/* Opens only a regular file or directory, with all traversal anchored at root. */
enum kogen_fs_status kogen_fs_open_path(const struct kogen_fs_root *root,
	const uint8_t *path, size_t path_length, int follow_in_root_links,
	int want_directory, int *fd_out);

/* Entries preserve raw name bytes and classify symlinks without following them. */
enum kogen_fs_status kogen_fs_list_directory(
	const struct kogen_fs_root *root, const uint8_t *path, size_t path_length,
	int follow_in_root_links, size_t max_entries, size_t max_name_bytes,
	struct kogen_fs_listing *listing);
void kogen_fs_listing_free(struct kogen_fs_listing *listing);

/* Dispatches the version-1 filesystem request payload used by read.ts. */
enum kogen_fs_status kogen_fs_handle_read_request(const uint8_t *request,
	size_t request_length, uint8_t *response, size_t response_capacity,
	size_t *response_length);

#endif
