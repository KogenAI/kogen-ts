import { createHash } from "node:crypto";
import type { PortError, Result } from "../contracts/errors";
import { removePathNoFollow } from "../fs/publish";
import {
	FILESYSTEM_MAX_ENTRIES,
	FILESYSTEM_MAX_RESPONSE_BYTES,
	type FileSystemDirectoryEntry,
	type FileSystemHostRequest,
	listDirectoryBytes,
	readControllerFileBytes,
} from "../fs/read";
import { restorePathNoFollow } from "../fs/restore";
import type { PrivateGitRepository } from "../git/repository";
import type { WorkspaceSnapshot } from "../workspace/snapshot";
import { snapshotWorkspace } from "../workspace/snapshot";
import type { GateFinding } from "./findings";
import {
	ABSENT_PROTECTED_SHA256,
	matchesProtectedPath,
	type ProtectedManifest,
	type ProtectedManifestEntry,
} from "./manifest";

export const PROTECTED_RESTORE_LIMIT = 4;

const MAX_WORKSPACE_ENTRIES = 100_000;
const MAX_WORKSPACE_DEPTH = 128;

export interface ProtectedWorkspacePath {
	/** Display/matching form. Invalid UTF-8 bytes use one code unit per byte. */
	readonly path: string;
	/** Original bytes are retained for safe no-follow filesystem operations. */
	readonly pathBytes: Uint8Array;
	readonly kind: FileSystemDirectoryEntry["kind"];
}

export interface ProtectedWorkspaceState {
	readonly snapshot: WorkspaceSnapshot;
	readonly paths: readonly ProtectedWorkspacePath[];
	/** A failed snapshot makes every present protected file fail closed. */
	readonly snapshotError?: PortError;
	/** Bounded direct hashes let restore localize a failed Git snapshot. */
	readonly regularHashes?: ReadonlyMap<string, string>;
}

export interface CaptureProtectedWorkspaceRequest {
	readonly repository: PrivateGitRepository;
	readonly sourceRepository: string;
	readonly baseCommit: string;
	readonly filesystem: FileSystemHostRequest;
	readonly manifest?: ProtectedManifest;
}

export interface ProtectedManifestCheckOptions {
	/** Paths intentionally removed after the acceptance test is staged. */
	readonly absentPaths?: readonly string[];
}

export interface ProtectedMismatch {
	readonly path: string;
	readonly expected:
		| ProtectedManifestEntry
		| {
				readonly path: string;
				readonly kind: "directory";
				readonly source: "base-directory";
		  };
	readonly actualKind: FileSystemDirectoryEntry["kind"] | "absent";
}

export interface ProtectedRestoreEvent {
	readonly event: "protected_restored";
	readonly rung: string;
	readonly path: string;
	readonly note: string;
}

export interface RestoreProtectedPathsRequest {
	readonly repository: PrivateGitRepository;
	readonly sourceRepository: string;
	readonly manifest: ProtectedManifest;
	readonly filesystem: FileSystemHostRequest;
	readonly rung: string;
	readonly previousRestoreCount: number;
	readonly absentPaths?: readonly string[];
}

export interface RestoreProtectedPathsResult {
	readonly restoreCount: number;
	readonly limitReached: boolean;
	readonly events: readonly ProtectedRestoreEvent[];
	readonly notes: readonly string[];
	readonly remainingMismatches: readonly ProtectedMismatch[];
}

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

/** Return the frozen refusal text when a shaper write targets protected bytes. */
export function protectedWriteRefusal(
	manifest: ProtectedManifest,
	relativePath: string,
): string | null {
	const path = relativePath.replace(/^(?:\.\/)+/u, "");
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path
			.split("/")
			.some(
				(component) =>
					component === "" || component === "." || component === "..",
			)
	)
		return null;
	if (
		!manifest.entries.some((entry) => entry.path === path) &&
		!matchesProtectedPath(manifest.patterns, path)
	)
		return null;
	return `ERROR: ${path} is approved and protected; change the implementation instead.`;
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function byteCompare(left: Uint8Array, right: Uint8Array): number {
	for (
		let index = 0;
		index < Math.min(left.byteLength, right.byteLength);
		index += 1
	) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return left.byteLength - right.byteLength;
}

function decodeForMatching(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		let value = "";
		for (const byte of bytes) value += String.fromCharCode(byte);
		return value;
	}
}

function joinPathBytes(parent: Uint8Array, name: Uint8Array): Uint8Array {
	if (parent.byteLength === 0) return name.slice();
	const result = new Uint8Array(parent.byteLength + 1 + name.byteLength);
	result.set(parent);
	result[parent.byteLength] = 0x2f;
	result.set(name, parent.byteLength + 1);
	return result;
}

function containsGitMetadataComponent(path: Uint8Array): boolean {
	let start = 0;
	for (let index = 0; index <= path.byteLength; index += 1) {
		if (index !== path.byteLength && path[index] !== 0x2f) continue;
		if (
			index - start === 4 &&
			path[start] === 0x2e &&
			path[start + 1] === 0x67 &&
			path[start + 2] === 0x69 &&
			path[start + 3] === 0x74
		)
			return true;
		start = index + 1;
	}
	return false;
}

function directoryRequestPath(path: Uint8Array): Uint8Array {
	return path;
}

/** Enumerate the candidate worktree without following symlinks or Git metadata. */
export async function listProtectedWorkspacePaths(
	filesystem: FileSystemHostRequest,
	root: string,
): Promise<Result<readonly ProtectedWorkspacePath[]>> {
	const rootBytes = utf8(root);
	try {
		if (new TextDecoder("utf-8", { fatal: true }).decode(rootBytes) !== root)
			throw new TypeError("Workspace root is not valid UTF-8.");
	} catch {
		return {
			ok: false,
			error: error("invalid_input", "Protected workspace root is invalid."),
		};
	}
	if (rootBytes.byteLength === 0 || rootBytes.byteLength > 64 * 1024)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Protected workspace root is outside its bound.",
			),
		};

	const output: ProtectedWorkspacePath[] = [];
	const visit = async (
		directory: Uint8Array,
		depth: number,
	): Promise<Result<void>> => {
		if (depth > MAX_WORKSPACE_DEPTH)
			return {
				ok: false,
				error: error(
					"invalid_input",
					"Protected workspace exceeds its directory-depth limit.",
				),
			};
		const listed = await listDirectoryBytes(filesystem, {
			root: rootBytes,
			path: directoryRequestPath(directory),
			maxEntries: FILESYSTEM_MAX_ENTRIES,
			maxNameBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 16,
		});
		if (!listed.ok) return listed;
		for (const entry of listed.value) {
			const pathBytes = joinPathBytes(directory, entry.name);
			if (containsGitMetadataComponent(pathBytes)) continue;
			if (output.length >= MAX_WORKSPACE_ENTRIES)
				return {
					ok: false,
					error: error(
						"invalid_input",
						"Protected workspace exceeds its entry limit.",
					),
				};
			output.push({
				path: decodeForMatching(pathBytes),
				pathBytes,
				kind: entry.kind,
			});
			if (entry.kind === "directory") {
				const nested = await visit(pathBytes, depth + 1);
				if (!nested.ok) return nested;
			}
		}
		return { ok: true, value: undefined };
	};
	const walked = await visit(new Uint8Array(), 0);
	if (!walked.ok) return walked;
	output.sort((left, right) => byteCompare(left.pathBytes, right.pathBytes));
	return { ok: true, value: output };
}

export async function captureProtectedWorkspace(
	request: CaptureProtectedWorkspaceRequest,
): Promise<Result<ProtectedWorkspaceState>> {
	const paths = await listProtectedWorkspacePaths(
		request.filesystem,
		request.repository.workTree,
	);
	if (!paths.ok) return paths;
	const snapshot = await snapshotWorkspace({
		repository: request.repository,
		sourceRepository: request.sourceRepository,
		baseCommit: request.baseCommit,
		filesystem: request.filesystem,
	});
	if (!snapshot.ok) {
		const regularHashes = new Map<string, string>();
		const expectedPaths = new Set(
			(request.manifest?.entries ?? [])
				.filter((entry) => entry.kind === "regular")
				.map((entry) => entry.path),
		);
		const pathMap = new Map(paths.value.map((entry) => [entry.path, entry]));
		for (const path of expectedPaths) {
			const current = pathMap.get(path);
			if (current?.kind !== "regular") continue;
			const bytes = await readControllerFileBytes(request.filesystem, {
				root: new TextEncoder().encode(request.repository.workTree),
				path: current.pathBytes,
				maxBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 1,
			});
			if (!bytes.ok) continue;
			regularHashes.set(
				path,
				createHash("sha256").update(bytes.value).digest("hex"),
			);
		}
		return {
			ok: true,
			value: {
				snapshot: {
					baseCommit: request.baseCommit,
					baseTree: "",
					tree: "",
					changedPaths: [],
					indexEntries: [],
				},
				paths: paths.value,
				snapshotError: snapshot.error,
				regularHashes,
			},
		};
	}
	return { ok: true, value: { snapshot: snapshot.value, paths: paths.value } };
}

function objectIdEntries(snapshot: WorkspaceSnapshot): ReadonlyMap<
	string,
	{
		readonly mode: string;
		readonly objectId: string;
	}
> {
	const entries = new Map<string, { mode: string; objectId: string }>();
	for (const entry of snapshot.indexEntries) {
		const path = decodeForMatching(entry.path);
		entries.set(path, { mode: entry.mode, objectId: entry.objectId });
	}
	return entries;
}

function expectedEntries(
	manifest: ProtectedManifest,
	options: ProtectedManifestCheckOptions,
): ReadonlyMap<string, ProtectedManifestEntry | "absent"> {
	const entries = new Map<string, ProtectedManifestEntry | "absent">(
		manifest.entries.map((entry) => [entry.path, entry]),
	);
	for (const path of options.absentPaths ?? []) entries.set(path, "absent");
	return entries;
}

function absentEntry(path: string): ProtectedManifestEntry {
	return {
		path,
		sha256: ABSENT_PROTECTED_SHA256,
		source: "absent",
		kind: "absent",
		mode: null,
		objectId: null,
		bytes: null,
	};
}

function requiredDirectories(
	manifest: ProtectedManifest,
	entries: ReadonlyMap<string, ProtectedManifestEntry | "absent">,
): ReadonlySet<string> {
	const directories = new Set(manifest.baseDirectories);
	for (const [path, entry] of entries) {
		if (entry === "absent" || !regularOrSymlink(entry)) continue;
		for (const parent of parentPaths(path)) directories.add(parent);
	}
	return directories;
}

export function protectedManifestMismatches(
	manifest: ProtectedManifest,
	state: ProtectedWorkspaceState,
	options: ProtectedManifestCheckOptions = {},
): readonly ProtectedMismatch[] {
	const expected = expectedEntries(manifest, options);
	const paths = new Map(state.paths.map((entry) => [entry.path, entry]));
	const objectIds = objectIdEntries(state.snapshot);
	const mismatches: ProtectedMismatch[] = [];
	for (const [path, value] of expected) {
		const actual = paths.get(path);
		const actualKind = actual?.kind ?? "absent";
		if (
			value === "absent" ||
			(typeof value === "object" && value.kind === "absent")
		) {
			if (actual !== undefined)
				mismatches.push({
					path,
					expected: absentEntry(path),
					actualKind,
				});
			continue;
		}
		const directlyVerified =
			value.kind === "regular" &&
			state.regularHashes?.get(path) === value.sha256;
		if (
			actual === undefined ||
			actual.kind !== value.kind ||
			(state.snapshotError !== undefined
				? !directlyVerified
				: objectIds.get(path)?.mode !== value.mode ||
					objectIds.get(path)?.objectId !== value.objectId)
		)
			mismatches.push({ path, expected: value, actualKind });
	}
	const directories = requiredDirectories(manifest, expected);
	for (const path of directories) {
		const actual = paths.get(path);
		if (actual?.kind === "directory") continue;
		mismatches.push({
			path,
			expected: { path, kind: "directory", source: "base-directory" },
			actualKind: actual?.kind ?? "absent",
		});
	}
	for (const actual of state.paths) {
		if (
			expected.has(actual.path) ||
			directories.has(actual.path) ||
			!matchesProtectedPath(manifest.patterns, actual.path)
		)
			continue;
		mismatches.push({
			path: actual.path,
			expected: absentEntry(actual.path),
			actualKind: actual.kind,
		});
	}
	mismatches.sort((left, right) => {
		const a = utf8(left.path);
		const b = utf8(right.path);
		return byteCompare(a, b);
	});
	return mismatches;
}

/** Paths to report as environment/checkout_behind_base during approval. */
export function staleCheckoutPaths(
	manifest: ProtectedManifest,
	state: ProtectedWorkspaceState,
): readonly string[] {
	const own = new Set(manifest.ownPaths);
	return protectedManifestMismatches(manifest, state)
		.filter(
			(mismatch) =>
				mismatch.expected.source !== "base-directory" &&
				!own.has(mismatch.path),
		)
		.map((mismatch) => mismatch.path);
}

/** A protected mismatch is an ordinary red finding and cannot be base-excused. */
export function protectedManifestFindings(
	manifest: ProtectedManifest,
	state: ProtectedWorkspaceState,
	options: ProtectedManifestCheckOptions = {},
): readonly GateFinding[] {
	return protectedManifestMismatches(manifest, state, options).map(
		(mismatch) => ({
			step: "protected",
			path: mismatch.path,
			line: 1,
			column: 1,
			severity: "error",
			rule: `protected/${mismatch.path}`,
			symbol: "",
			message: "Protected path differs from its approved or base bytes.",
			excused: false,
		}),
	);
}

function depth(path: string): number {
	return path.split("/").length;
}

function parentPaths(path: string): readonly string[] {
	const components = path.split("/");
	const parents: string[] = [];
	for (let index = 1; index < components.length; index += 1)
		parents.push(components.slice(0, index).join("/"));
	return parents;
}

function pathBytesFor(path: string): Uint8Array {
	return utf8(path);
}

async function removeTreeNoFollow(
	filesystem: FileSystemHostRequest,
	root: Uint8Array,
	path: ProtectedWorkspacePath,
	paths: readonly ProtectedWorkspacePath[],
): Promise<Result<readonly ProtectedWorkspacePath[]>> {
	const prefix = `${path.path}/`;
	const descendants = paths
		.filter((entry) => entry.path.startsWith(prefix))
		.sort(
			(left, right) =>
				depth(right.path) - depth(left.path) ||
				byteCompare(right.pathBytes, left.pathBytes),
		);
	const removed: ProtectedWorkspacePath[] = [];
	for (const descendant of descendants) {
		const result = await removePathNoFollow(
			filesystem,
			root,
			descendant.pathBytes,
		);
		if (!result.ok && result.error.code !== "not_found") return result;
		removed.push(descendant);
	}
	const target = await removePathNoFollow(filesystem, root, path.pathBytes);
	if (!target.ok && target.error.code !== "not_found") return target;
	removed.push(path);
	return { ok: true, value: removed };
}

function regularOrSymlink(entry: ProtectedManifestEntry): boolean {
	return entry.kind === "regular" || entry.kind === "symlink";
}

function restoreKind(entry: ProtectedManifestEntry) {
	if (entry.kind === "regular")
		return {
			kind: "regular" as const,
			bytes: entry.bytes,
			executable: entry.mode === "100755",
		};
	if (entry.kind === "symlink")
		return { kind: "symlink" as const, target: entry.bytes };
	return { kind: "absent" as const };
}

function noteFor(path: string): string {
	return `You changed ${path}; acceptance tests and the Intent are read-only and have been restored. Make the implementation satisfy them.`;
}

function comparePath(left: string, right: string): number {
	return byteCompare(utf8(left), utf8(right));
}

function findPresentPath(
	paths: readonly ProtectedWorkspacePath[],
	path: string,
): ProtectedWorkspacePath | undefined {
	return paths.find((entry) => entry.path === path);
}

async function ensureParentDirectories(
	filesystem: FileSystemHostRequest,
	root: Uint8Array,
	path: string,
	paths: ProtectedWorkspacePath[],
): Promise<Result<void>> {
	for (const parent of parentPaths(path)) {
		const existing = findPresentPath(paths, parent);
		if (existing?.kind === "directory") continue;
		if (existing !== undefined) {
			const removed = await removeTreeNoFollow(
				filesystem,
				root,
				existing,
				paths,
			);
			if (!removed.ok) return removed;
			const gone = new Set(removed.value.map((entry) => entry.path));
			for (let index = paths.length - 1; index >= 0; index -= 1)
				if (gone.has(paths[index]?.path ?? "")) paths.splice(index, 1);
		}
		const made = await restorePathNoFollow(filesystem, {
			root,
			path: pathBytesFor(parent),
			entry: { kind: "directory" },
		});
		if (!made.ok) return made;
		paths.push({
			path: parent,
			pathBytes: pathBytesFor(parent),
			kind: "directory",
		});
	}
	return { ok: true, value: undefined };
}

/**
 * Restore protected manifest paths after one complete tool batch. Callers pass
 * the per-rung count and end that rung when the returned count reaches four.
 */
export async function restoreProtectedPaths(
	request: RestoreProtectedPathsRequest,
): Promise<Result<RestoreProtectedPathsResult>> {
	if (
		!Number.isSafeInteger(request.previousRestoreCount) ||
		request.previousRestoreCount < 0 ||
		request.rung.length === 0 ||
		request.rung.includes("\0")
	)
		return {
			ok: false,
			error: error("invalid_input", "Protected restore state is invalid."),
		};
	if (request.previousRestoreCount >= PROTECTED_RESTORE_LIMIT)
		return {
			ok: true,
			value: {
				restoreCount: request.previousRestoreCount,
				limitReached: true,
				events: [],
				notes: [],
				remainingMismatches: [],
			},
		};

	const captured = await captureProtectedWorkspace({
		repository: request.repository,
		sourceRepository: request.sourceRepository,
		baseCommit: request.manifest.baseCommit,
		filesystem: request.filesystem,
		manifest: request.manifest,
	});
	if (!captured.ok) return captured;
	let paths = [...captured.value.paths];
	const expected = expectedEntries(request.manifest, request);
	const mismatches = protectedManifestMismatches(
		request.manifest,
		captured.value,
		request,
	);
	const targets = new Map<
		string,
		ProtectedManifestEntry | "absent" | "directory"
	>();
	for (const mismatch of mismatches)
		targets.set(
			mismatch.path,
			mismatch.expected.kind === "directory"
				? "directory"
				: (expected.get(mismatch.path) ?? "absent"),
		);

	const events: ProtectedRestoreEvent[] = [];
	const targetPaths = [...targets.keys()].sort(comparePath);
	for (const path of targetPaths) {
		const target = targets.get(path);
		if (target === undefined) continue;
		const actual = findPresentPath(paths, path);
		if (target === "directory") {
			const parents = await ensureParentDirectories(
				request.filesystem,
				utf8(request.repository.workTree),
				path,
				paths,
			);
			if (!parents.ok) return parents;
			if (actual !== undefined && actual.kind !== "directory") {
				const removed = await removeTreeNoFollow(
					request.filesystem,
					utf8(request.repository.workTree),
					actual,
					paths,
				);
				if (!removed.ok) return removed;
				const gone = new Set(removed.value.map((entry) => entry.path));
				for (let index = paths.length - 1; index >= 0; index -= 1)
					if (gone.has(paths[index]?.path ?? "")) paths.splice(index, 1);
			}
			const restored = await restorePathNoFollow(request.filesystem, {
				root: utf8(request.repository.workTree),
				path: pathBytesFor(path),
				entry: { kind: "directory" },
			});
			if (!restored.ok) return restored;
			paths = paths.filter((entry) => entry.path !== path);
			paths.push({ path, pathBytes: pathBytesFor(path), kind: "directory" });
		} else if (target === "absent" || target.kind === "absent") {
			if (actual === undefined) continue;
			if (actual.kind === "directory") {
				const removed = await removeTreeNoFollow(
					request.filesystem,
					utf8(request.repository.workTree),
					actual,
					paths,
				);
				if (!removed.ok) return removed;
				const gone = new Set(removed.value.map((entry) => entry.path));
				for (let index = paths.length - 1; index >= 0; index -= 1)
					if (gone.has(paths[index]?.path ?? "")) paths.splice(index, 1);
			} else {
				const removed = await removePathNoFollow(
					request.filesystem,
					utf8(request.repository.workTree),
					actual.pathBytes,
				);
				if (!removed.ok && removed.error.code !== "not_found") return removed;
				paths.splice(paths.indexOf(actual), 1);
			}
		} else {
			const parents = await ensureParentDirectories(
				request.filesystem,
				utf8(request.repository.workTree),
				path,
				paths,
			);
			if (!parents.ok) return parents;
			if (actual?.kind === "directory") {
				const removed = await removeTreeNoFollow(
					request.filesystem,
					utf8(request.repository.workTree),
					actual,
					paths,
				);
				if (!removed.ok) return removed;
				const gone = new Set(removed.value.map((entry) => entry.path));
				for (let index = paths.length - 1; index >= 0; index -= 1)
					if (gone.has(paths[index]?.path ?? "")) paths.splice(index, 1);
			} else if (actual?.kind === "other") {
				const removed = await removePathNoFollow(
					request.filesystem,
					utf8(request.repository.workTree),
					actual.pathBytes,
				);
				if (!removed.ok && removed.error.code !== "not_found") return removed;
				paths.splice(paths.indexOf(actual), 1);
			}
			const restored = await restorePathNoFollow(request.filesystem, {
				root: utf8(request.repository.workTree),
				path: pathBytesFor(path),
				entry: restoreKind(target),
			});
			if (!restored.ok) return restored;
			paths = paths.filter((entry) => entry.path !== path);
			paths.push({
				path,
				pathBytes: pathBytesFor(path),
				kind: target.kind,
			});
		}
		events.push({
			event: "protected_restored",
			rung: request.rung,
			path,
			note: noteFor(path),
		});
	}

	const confirmed = await captureProtectedWorkspace({
		repository: request.repository,
		sourceRepository: request.sourceRepository,
		baseCommit: request.manifest.baseCommit,
		filesystem: request.filesystem,
		manifest: request.manifest,
	});
	if (!confirmed.ok) return confirmed;
	const remainingMismatches = protectedManifestMismatches(
		request.manifest,
		confirmed.value,
		request,
	);
	if (remainingMismatches.length > 0)
		return {
			ok: false,
			error: error(
				"conflict",
				`Protected paths remain mismatched after restoration: ${remainingMismatches.map((item) => item.path).join(", ")}`,
				true,
			),
		};
	const restoreCount = request.previousRestoreCount + events.length;
	return {
		ok: true,
		value: {
			restoreCount,
			limitReached: restoreCount >= PROTECTED_RESTORE_LIMIT,
			events,
			notes: events.map((event) => event.note),
			remainingMismatches,
		},
	};
}

/** Build findings for a guard immediately before verify or commit. */
export async function guardProtectedManifest(request: {
	readonly repository: PrivateGitRepository;
	readonly sourceRepository: string;
	readonly manifest: ProtectedManifest;
	readonly filesystem: FileSystemHostRequest;
	readonly absentPaths?: readonly string[];
}): Promise<Result<readonly GateFinding[]>> {
	const captured = await captureProtectedWorkspace({
		repository: request.repository,
		sourceRepository: request.sourceRepository,
		baseCommit: request.manifest.baseCommit,
		filesystem: request.filesystem,
		manifest: request.manifest,
	});
	if (!captured.ok) return captured;
	return {
		ok: true,
		value: protectedManifestFindings(request.manifest, captured.value, request),
	};
}
