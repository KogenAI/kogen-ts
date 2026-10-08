import {
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PortError, Result } from "../../core/src/contracts/errors";
import type {
	ChatGptRefreshLockObservation,
	ChatGptRefreshLockPort,
} from "../../core/src/provider/auth/chatgpt/refresh";

function failure(cause: unknown): PortError {
	return {
		code: "io",
		message:
			cause instanceof Error ? cause.message : "Refresh lock is unavailable.",
		retryable: true,
		cause,
	};
}

function lockPath(root: string, path: string): string {
	const canonical = resolve(root);
	const target = resolve(root, path);
	if (!target.startsWith(`${canonical}${sep}`))
		throw new Error("Refresh lock path escapes its root.");
	return target;
}

function observeDirect(directory: string): ChatGptRefreshLockObservation {
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Refresh lock is not a real directory.");
	let ownerBytes: Uint8Array | null = null;
	try {
		const fd = openSync(
			join(directory, "owner"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			ownerBytes = readFileSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	return {
		ownerBytes,
		directoryModifiedAtUnixMilliseconds: Math.floor(info.mtimeMs),
	};
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
	if (left === null || right === null) return left === right;
	return Buffer.from(left).equals(Buffer.from(right));
}

/** Real cross-process refresh lock with byte-identity release and stale CAS. */
export class FileChatGptRefreshLocks implements ChatGptRefreshLockPort {
	async tryCreateDirectory(
		root: string,
		path: string,
	): Promise<Result<"created" | "exists">> {
		try {
			const target = lockPath(root, path);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			for (const directory of [root, dirname(target)]) {
				const info = lstatSync(directory);
				if (!info.isDirectory() || info.isSymbolicLink())
					throw new Error("Refresh lock parent is not a real directory.");
			}
			mkdirSync(target, { mode: 0o700 });
			return { ok: true, value: "created" };
		} catch (cause) {
			return (cause as NodeJS.ErrnoException).code === "EEXIST"
				? { ok: true, value: "exists" }
				: { ok: false, error: failure(cause) };
		}
	}
	async writeOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<void>> {
		try {
			const target = lockPath(root, path);
			observeDirect(target);
			const fd = openSync(
				join(target, "owner"),
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_WRONLY |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeFileSync(fd, ownerBytes);
			} finally {
				closeSync(fd);
			}
			return { ok: true, value: undefined };
		} catch (cause) {
			return { ok: false, error: failure(cause) };
		}
	}
	async observe(
		root: string,
		path: string,
	): Promise<Result<ChatGptRefreshLockObservation>> {
		try {
			return { ok: true, value: observeDirect(lockPath(root, path)) };
		} catch (cause) {
			return { ok: false, error: failure(cause) };
		}
	}
	async removeIfUnchanged(
		root: string,
		path: string,
		expected: ChatGptRefreshLockObservation,
	): Promise<Result<boolean>> {
		try {
			const target = lockPath(root, path);
			const current = observeDirect(target);
			if (
				current.directoryModifiedAtUnixMilliseconds !==
					expected.directoryModifiedAtUnixMilliseconds ||
				!sameBytes(current.ownerBytes, expected.ownerBytes)
			)
				return { ok: true, value: false };
			if (current.ownerBytes !== null) unlinkSync(join(target, "owner"));
			rmdirSync(target);
			return { ok: true, value: true };
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT")
				return { ok: true, value: false };
			return { ok: false, error: failure(cause) };
		}
	}
	async releaseIfOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<boolean>> {
		try {
			const target = lockPath(root, path);
			const current = observeDirect(target);
			if (!sameBytes(current.ownerBytes, ownerBytes))
				return { ok: true, value: false };
			unlinkSync(join(target, "owner"));
			rmdirSync(target);
			return { ok: true, value: true };
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT")
				return { ok: true, value: false };
			return { ok: false, error: failure(cause) };
		}
	}
}
