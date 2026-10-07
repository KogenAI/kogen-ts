import type { Result } from "../contracts/errors";
import {
	FILESYSTEM_PUBLISH_ACTION,
	FILESYSTEM_RESTORE_KIND,
	sendFilesystemPublishCommand,
} from "./publish";
import type { FileSystemHostRequest } from "./read";

export type RestoredPath =
	| {
			readonly kind: "regular";
			readonly bytes: Uint8Array;
			readonly executable: boolean;
	  }
	| { readonly kind: "symlink"; readonly target: Uint8Array }
	| { readonly kind: "directory" }
	| { readonly kind: "absent" };

export interface RestorePathRequest {
	readonly root: Uint8Array;
	readonly path: Uint8Array;
	readonly entry: RestoredPath;
}

export function restorePathNoFollow(
	host: FileSystemHostRequest,
	request: RestorePathRequest,
): Promise<Result<void>> {
	const { entry } = request;
	let restoreKind: number;
	let mode = 0;
	let bytes: Uint8Array = new Uint8Array();
	switch (entry.kind) {
		case "regular":
			restoreKind = FILESYSTEM_RESTORE_KIND.regular;
			mode = entry.executable ? 0o700 : 0o600;
			bytes = entry.bytes;
			break;
		case "symlink":
			restoreKind = FILESYSTEM_RESTORE_KIND.symlink;
			bytes = entry.target;
			break;
		case "directory":
			restoreKind = FILESYSTEM_RESTORE_KIND.directory;
			break;
		case "absent":
			restoreKind = FILESYSTEM_RESTORE_KIND.absent;
			break;
	}
	return sendFilesystemPublishCommand(host, {
		action: FILESYSTEM_PUBLISH_ACTION.restore,
		root: request.root,
		path: request.path,
		bytes,
		mode,
		restoreKind,
	});
}
