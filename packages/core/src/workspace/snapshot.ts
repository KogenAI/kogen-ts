import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type { ProcessResult } from "../contracts/ports";
import {
	FILESYSTEM_MAX_RESPONSE_BYTES,
	type FileSystemHostRequest,
	readControllerFileBytes,
} from "../fs/read";
import {
	GIT_MAX_ARG_BYTES,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
	GIT_MAX_STDIN_BYTES,
} from "../git/command";
import type { GitObjectFormat, PrivateGitRepository } from "../git/repository";

export interface RawIndexEntry {
	/** Git's six-digit octal mode, retained without interpreting file contents. */
	readonly mode: string;
	readonly objectId: string;
	readonly stage: number;
	/** NUL-free repository-relative pathname bytes; this need not be UTF-8. */
	readonly path: Uint8Array;
}

export interface WorkspaceSnapshot {
	readonly baseCommit: string;
	readonly baseTree: string;
	readonly tree: string;
	readonly changedPaths: readonly Uint8Array[];
	readonly indexEntries: readonly RawIndexEntry[];
}

export interface SnapshotWorkspaceOptions {
	readonly repository: Pick<
		PrivateGitRepository,
		"gitDirectory" | "workTree" | "objectFormat" | "command" | "hashObject"
	>;
	readonly sourceRepository: string;
	/** The saved build-base commit. Never inferred from workspace HEAD or index. */
	readonly baseCommit: string;
	readonly filesystem: FileSystemHostRequest;
}

const REHASH_BATCH_BYTES = Math.min(
	GIT_MAX_STDIN_BYTES,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
);

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function objectIdLength(format: GitObjectFormat): number {
	return format === "sha1" ? 40 : 64;
}

function validObjectId(value: string, format: GitObjectFormat): boolean {
	return (
		value.length === objectIdLength(format) &&
		new RegExp(`^[0-9a-f]{${objectIdLength(format)}}$`).test(value)
	);
}

function metadataPathIsPrivate(
	repository: SnapshotWorkspaceOptions["repository"],
): boolean {
	const workTree = resolve(repository.workTree);
	const gitDirectory = resolve(repository.gitDirectory);
	const fromWorkTree = relative(workTree, gitDirectory);
	return (
		fromWorkTree === ".." ||
		fromWorkTree.startsWith(`..${sep}`) ||
		fromWorkTree.startsWith(sep)
	);
}

function validSourceRepositoryPath(path: string): boolean {
	if (!isAbsolute(path) || path.includes("\0")) return false;
	const encoded = new TextEncoder().encode(path);
	if (encoded.byteLength > 4096) return false;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(encoded) === path;
	} catch {
		return false;
	}
}

async function checkedCommand(
	repository: SnapshotWorkspaceOptions["repository"],
	argv: readonly string[],
	options: { stdin?: Uint8Array; outputLimitBytes?: number } = {},
): Promise<Result<ProcessResult>> {
	const result = await repository.command(argv, {
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		outputLimitBytes: options.outputLimitBytes ?? GIT_MAX_OUTPUT_LIMIT_BYTES,
	});
	if (!result.ok) return result;
	if (result.value.timedOut)
		return {
			ok: false,
			error: error("timeout", `Git ${argv[0] ?? "command"} timed out.`, true),
		};
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${argv[0] ?? "command"} failed with exit ${result.value.exitCode}.`,
				true,
			),
		};
	return result;
}

function outputText(result: ProcessResult, label: string): Result<string> {
	try {
		return {
			ok: true,
			value: new TextDecoder("utf-8", { fatal: true })
				.decode(result.stdout)
				.trim(),
		};
	} catch {
		return {
			ok: false,
			error: error("unknown", `Git returned invalid ${label} bytes.`),
		};
	}
}

function parseNulPaths(bytes: Uint8Array): Result<readonly Uint8Array[]> {
	if (bytes.byteLength === 0) return { ok: true, value: [] };
	if (bytes[bytes.byteLength - 1] !== 0)
		return {
			ok: false,
			error: error("unknown", "Git returned an unterminated pathname."),
		};
	const paths: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0) continue;
		if (index === start)
			return {
				ok: false,
				error: error("unknown", "Git returned an empty pathname."),
			};
		paths.push(bytes.slice(start, index));
		start = index + 1;
	}
	return { ok: true, value: paths };
}

function ascii(bytes: Uint8Array): string | null {
	let value = "";
	for (const byte of bytes) {
		if (byte > 0x7f) return null;
		value += String.fromCharCode(byte);
	}
	return value;
}

function parseIndexEntries(
	bytes: Uint8Array,
	format: GitObjectFormat,
): Result<readonly RawIndexEntry[]> {
	const records = parseNulPaths(bytes);
	if (!records.ok) return records;
	const entries: RawIndexEntry[] = [];
	const objectLength = objectIdLength(format);
	for (const record of records.value) {
		let tab = -1;
		for (let index = 0; index < record.byteLength; index += 1) {
			if (record[index] === 0x09) {
				tab = index;
				break;
			}
		}
		if (tab < 0)
			return {
				ok: false,
				error: error("unknown", "Git returned a malformed raw index entry."),
			};
		const header = ascii(record.subarray(0, tab));
		const match =
			header === null ? null : /^(\d{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
		const mode = match?.[1];
		const objectId = match?.[2];
		const stageText = match?.[3];
		if (
			mode === undefined ||
			objectId === undefined ||
			stageText === undefined ||
			objectId.length !== objectLength
		)
			return {
				ok: false,
				error: error("unknown", "Git returned an invalid raw index header."),
			};
		const stage = Number(stageText);
		if (stage !== 0)
			return {
				ok: false,
				error: error(
					"conflict",
					"Private workspace index unexpectedly contains conflict stages.",
				),
			};
		entries.push({
			mode,
			objectId,
			stage,
			path: record.slice(tab + 1),
		});
	}
	return { ok: true, value: entries };
}

function bytePathRoot(workTree: string): Uint8Array {
	const encoded = new TextEncoder().encode(workTree);
	if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== workTree)
		throw new TypeError("Workspace root is not valid Unicode.");
	return encoded;
}

function splitUpdates(updates: readonly Uint8Array[]): readonly Uint8Array[] {
	const batches: Uint8Array[] = [];
	let batch: Uint8Array[] = [];
	let bytes = 0;
	for (const update of updates) {
		if (bytes + update.byteLength > REHASH_BATCH_BYTES) {
			batches.push(concat(batch, bytes));
			batch = [];
			bytes = 0;
		}
		batch.push(update);
		bytes += update.byteLength;
	}
	if (batch.length > 0) batches.push(concat(batch, bytes));
	return batches;
}

function concat(values: readonly Uint8Array[], length: number): Uint8Array {
	const output = new Uint8Array(length);
	let offset = 0;
	for (const value of values) {
		output.set(value, offset);
		offset += value.byteLength;
	}
	return output;
}

function encodeIndexUpdate(
	mode: string,
	objectId: string,
	path: Uint8Array,
): Uint8Array {
	const header = new TextEncoder().encode(`${mode} ${objectId}\t`);
	const value = new Uint8Array(header.byteLength + path.byteLength + 1);
	value.set(header);
	value.set(path, header.byteLength);
	return value;
}

function containsByte(bytes: Uint8Array, value: number): boolean {
	return bytes.includes(value);
}

async function hashRegularFile(
	repository: SnapshotWorkspaceOptions["repository"],
	filesystem: FileSystemHostRequest,
	root: Uint8Array,
	path: Uint8Array,
): Promise<Result<string>> {
	const read = await readControllerFileBytes(filesystem, {
		root,
		path,
		maxBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 1,
	});
	if (read.ok && read.value.byteLength <= GIT_MAX_STDIN_BYTES)
		return repository.hashObject(read.value, true);
	if (
		!read.ok &&
		(read.error.code !== "invalid_input" ||
			!read.error.message.includes("exceeds its byte or traversal limit"))
	)
		return {
			ok: false,
			error: {
				...read.error,
				message: `Could not safely read workspace path for raw Git hashing: ${read.error.message}`,
			},
		};

	// Large blobs exceed the bounded Git stdin frame. Let trusted Git read the
	// path directly with filters disabled; the caller has already stopped all
	// workspace writers, and the index says this entry is a regular file.
	let utf8Path: string | null = null;
	try {
		utf8Path = new TextDecoder("utf-8", { fatal: true }).decode(path);
	} catch {
		// Git's stdin-path form below still preserves arbitrary non-NUL bytes.
	}
	let argv: readonly string[];
	let stdin: Uint8Array | undefined;
	if (
		utf8Path !== null &&
		new TextEncoder().encode(utf8Path).byteLength <= GIT_MAX_ARG_BYTES
	) {
		argv = ["hash-object", "-w", "--no-filters", "--", utf8Path];
	} else if (!containsByte(path, 0x0a)) {
		argv = ["hash-object", "-w", "--no-filters", "--stdin-paths"];
		stdin = new Uint8Array(path.byteLength + 1);
		stdin.set(path);
		stdin[path.byteLength] = 0x0a;
	} else {
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Oversized non-UTF-8 workspace paths containing newlines cannot be safely hashed by this Git port.",
			),
		};
	}
	const hashed = await checkedCommand(repository, argv, {
		...(stdin === undefined ? {} : { stdin }),
		outputLimitBytes: 128,
	});
	if (!hashed.ok) return hashed;
	const objectId = outputText(hashed.value, "raw blob id");
	if (!objectId.ok) return objectId;
	return { ok: true, value: objectId.value };
}

/**
 * Capture the worktree over the saved base using a controller-owned Git index.
 * Call only after model/tool writers have stopped. Workspace HEAD, index,
 * config, info/exclude, filters and hooks are never selected as Git metadata.
 */
export async function snapshotWorkspace(
	options: SnapshotWorkspaceOptions,
): Promise<Result<WorkspaceSnapshot>> {
	const { repository, sourceRepository, baseCommit, filesystem } = options;
	if (!metadataPathIsPrivate(repository))
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Private Git metadata must be outside the model workspace.",
			),
		};
	if (!validSourceRepositoryPath(sourceRepository))
		return {
			ok: false,
			error: error("invalid_input", "Source repository path is invalid."),
		};
	if (!validObjectId(baseCommit, repository.objectFormat))
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Saved build base must be a full object id in the repository format.",
			),
		};

	const fetched = await checkedCommand(repository, [
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		sourceRepository,
		baseCommit,
	]);
	if (!fetched.ok) return fetched;
	const baseTreeResult = await checkedCommand(
		repository,
		["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{tree}`],
		{ outputLimitBytes: 128 },
	);
	if (!baseTreeResult.ok) return baseTreeResult;
	const baseTreeOutput = outputText(baseTreeResult.value, "base tree id");
	if (!baseTreeOutput.ok) return baseTreeOutput;
	const baseTree = baseTreeOutput.value;
	if (!validObjectId(baseTree, repository.objectFormat))
		return {
			ok: false,
			error: error("unknown", "Git returned an invalid base tree id."),
		};

	const readTree = await checkedCommand(repository, ["read-tree", baseCommit]);
	if (!readTree.ok) return readTree;
	// `git add -A` supplies Git's real nested ignore/negation rules. The private
	// metadata repository keeps workspace .git/config and info/exclude out of
	// the decision; the seeded index keeps ignored base-tracked paths included.
	const add = await checkedCommand(repository, ["add", "-A", "--", "."]);
	if (!add.ok) return add;

	const indexResult = await checkedCommand(
		repository,
		["ls-files", "--stage", "-z"],
		{ outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES },
	);
	if (!indexResult.ok) return indexResult;
	const parsedIndex = parseIndexEntries(
		indexResult.value.stdout,
		repository.objectFormat,
	);
	if (!parsedIndex.ok) return parsedIndex;

	let root: Uint8Array;
	try {
		root = bytePathRoot(repository.workTree);
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				cause instanceof Error ? cause.message : "Workspace root is invalid.",
			),
		};
	}
	const updates: Uint8Array[] = [];
	for (const entry of parsedIndex.value) {
		if (entry.mode !== "100644" && entry.mode !== "100755") continue;
		const object = await hashRegularFile(
			repository,
			filesystem,
			root,
			entry.path,
		);
		if (!object.ok) return object;
		if (!validObjectId(object.value, repository.objectFormat))
			return {
				ok: false,
				error: error("unknown", "Git returned an invalid raw blob id."),
			};
		updates.push(encodeIndexUpdate(entry.mode, object.value, entry.path));
	}
	for (const batch of splitUpdates(updates)) {
		const update = await checkedCommand(
			repository,
			["update-index", "-z", "--index-info"],
			{ stdin: batch, outputLimitBytes: 1024 },
		);
		if (!update.ok) return update;
	}

	const treeResult = await checkedCommand(repository, ["write-tree"], {
		outputLimitBytes: 128,
	});
	if (!treeResult.ok) return treeResult;
	const treeOutput = outputText(treeResult.value, "workspace tree id");
	if (!treeOutput.ok) return treeOutput;
	const tree = treeOutput.value;
	if (!validObjectId(tree, repository.objectFormat))
		return {
			ok: false,
			error: error("unknown", "Git returned an invalid workspace tree id."),
		};

	const finalIndexResult = await checkedCommand(
		repository,
		["ls-files", "--stage", "-z"],
		{ outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES },
	);
	if (!finalIndexResult.ok) return finalIndexResult;
	const finalIndex = parseIndexEntries(
		finalIndexResult.value.stdout,
		repository.objectFormat,
	);
	if (!finalIndex.ok) return finalIndex;
	const diff = await checkedCommand(
		repository,
		[
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"--no-renames",
			"-r",
			"-z",
			baseCommit,
			tree,
		],
		{ outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES },
	);
	if (!diff.ok) return diff;
	const changedPaths = parseNulPaths(diff.value.stdout);
	if (!changedPaths.ok) return changedPaths;
	return {
		ok: true,
		value: {
			baseCommit,
			baseTree,
			tree,
			changedPaths: changedPaths.value,
			indexEntries: finalIndex.value,
		},
	};
}
