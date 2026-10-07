import type { PortError, Result } from "../contracts/errors";
import {
	GIT_MAX_OUTPUT_LIMIT_BYTES,
	GIT_MAX_STDIN_BYTES,
} from "../git/command";
import type { PrivateGitRepository } from "../git/repository";

export interface IgnoreDecision {
	readonly path: Uint8Array;
	readonly ignored: boolean;
}

const BATCH_BYTES = Math.min(GIT_MAX_STDIN_BYTES, GIT_MAX_OUTPUT_LIMIT_BYTES);

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function pathError(path: Uint8Array): string | null {
	if (path.byteLength === 0) return "Git ignore paths must not be empty.";
	if (path.includes(0)) return "Git ignore paths cannot contain NUL.";
	if (path[0] === 0x2f) return "Git ignore paths must be relative.";
	let componentStart = 0;
	for (let index = 0; index <= path.byteLength; index += 1) {
		if (index !== path.byteLength && path[index] !== 0x2f) continue;
		const length = index - componentStart;
		if (length === 0)
			return "Git ignore paths must not contain empty components.";
		if (
			(length === 1 && path[componentStart] === 0x2e) ||
			(length === 2 &&
				path[componentStart] === 0x2e &&
				path[componentStart + 1] === 0x2e)
		)
			return "Git ignore paths cannot contain dot components.";
		componentStart = index + 1;
	}
	return null;
}

function byteKey(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
	return result;
}

function splitNul(bytes: Uint8Array): Result<readonly Uint8Array[]> {
	if (bytes.byteLength === 0) return { ok: true, value: [] };
	if (bytes[bytes.byteLength - 1] !== 0)
		return {
			ok: false,
			error: error("unknown", "Git returned an unterminated ignore path."),
		};
	const values: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0) continue;
		if (index === start)
			return {
				ok: false,
				error: error("unknown", "Git returned an empty ignore path."),
			};
		values.push(bytes.slice(start, index));
		start = index + 1;
	}
	return { ok: true, value: values };
}

function batches(
	paths: readonly Uint8Array[],
): Result<readonly Uint8Array[][]> {
	const result: Uint8Array[][] = [];
	let batch: Uint8Array[] = [];
	let batchBytes = 0;
	for (const path of paths) {
		const size = path.byteLength + 1;
		if (size > BATCH_BYTES)
			return {
				ok: false,
				error: error(
					"invalid_input",
					"Git ignore path exceeds the input limit.",
				),
			};
		if (batchBytes + size > BATCH_BYTES) {
			result.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(path);
		batchBytes += size;
	}
	if (batch.length > 0) result.push(batch);
	return { ok: true, value: result };
}

/**
 * Ask trusted Git to evaluate ignore rules from the worktree, including nested
 * .gitignore files and negations. `--no-index` deliberately reports ignore
 * matches even for tracked paths; snapshotting decides tracked retention from
 * its saved-base index instead.
 */
export async function checkGitIgnore(
	repository: Pick<PrivateGitRepository, "command">,
	paths: readonly Uint8Array[],
): Promise<Result<readonly IgnoreDecision[]>> {
	for (const path of paths) {
		const problem = pathError(path);
		if (problem !== null)
			return { ok: false, error: error("invalid_input", problem) };
	}
	if (paths.length === 0) return { ok: true, value: [] };
	const grouped = batches(paths);
	if (!grouped.ok) return grouped;
	const ignored = new Set<string>();
	for (const batch of grouped.value) {
		const stdin = new Uint8Array(
			batch.reduce((total, path) => total + path.byteLength + 1, 0),
		);
		let offset = 0;
		for (const path of batch) {
			stdin.set(path, offset);
			offset += path.byteLength + 1;
		}
		const command = await repository.command(
			["check-ignore", "--no-index", "-z", "--stdin"],
			{ stdin, outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES },
		);
		if (!command.ok) return command;
		if (command.value.timedOut)
			return {
				ok: false,
				error: error("timeout", "Git ignore evaluation timed out.", true),
			};
		if (command.value.exitCode !== 0 && command.value.exitCode !== 1)
			return {
				ok: false,
				error: error(
					"unavailable",
					`Git ignore evaluation failed with exit ${command.value.exitCode}.`,
					true,
				),
			};
		const decoded = splitNul(command.value.stdout);
		if (!decoded.ok) return decoded;
		if (command.value.exitCode === 0 && decoded.value.length === 0)
			return {
				ok: false,
				error: error(
					"unknown",
					"Git reported an ignore match without returning its pathname.",
				),
			};
		const batchKeys = new Set(batch.map(byteKey));
		for (const ignoredPath of decoded.value) {
			const key = byteKey(ignoredPath);
			if (!batchKeys.has(key))
				return {
					ok: false,
					error: error(
						"unknown",
						"Git returned an ignore path that was not requested.",
					),
				};
			ignored.add(key);
		}
		if (command.value.exitCode === 1 && decoded.value.length > 0)
			return {
				ok: false,
				error: error(
					"unknown",
					"Git reported ignored paths with a non-match exit status.",
				),
			};
	}
	return {
		ok: true,
		value: paths.map((path) => ({
			path: path.slice(),
			ignored: ignored.has(byteKey(path)),
		})),
	};
}
