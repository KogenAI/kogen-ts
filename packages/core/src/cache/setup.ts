import { createHash } from "node:crypto";
import type { PortError, Result } from "../contracts/errors";
import type { SetupCacheKeyInput, SetupInputFingerprint } from "./keys";
import { compareUtf8, sameSetupInputFingerprints, setupCacheKey } from "./keys";

export const SETUP_CACHE_DIRECTORY = "setup-cache";
export const SETUP_CACHE_ENTRY_LIMIT = 3;

export type SetupProductKind = "file" | "directory" | "symlink";

/** A lossless leaf of one declared setup output, including mode and link bytes. */
export interface SetupProduct {
	readonly path: string;
	readonly kind: SetupProductKind;
	readonly mode: number;
	/** File bytes, symlink target bytes, or an empty array for a directory. */
	readonly bytes: Uint8Array;
	readonly sha256: string;
}

export interface SetupCacheEntry {
	readonly v: 2;
	readonly key: string;
	readonly setup_wall_ms: number;
	readonly outputs: readonly SetupProduct[];
	readonly last_used_ms: number;
}

export interface SetupCacheIndexEntry {
	readonly key: string;
	readonly last_used_ms: number;
}

/**
 * Operations available while the state-root setup-cache lock is held.
 *
 * `publishComplete` stages all product data away from the visible key, writes
 * `setup-cache/<key>/complete` last, then atomically publishes the entry. That
 * marker uses the v2 fields `v`, `key`, `setup_wall_ms`, `outputs`, and
 * `last_used_ms`. A failure leaves either the previous complete entry or no
 * entry at that key.
 */
export interface LockedSetupCachePort {
	listComplete(): Promise<Result<readonly SetupCacheIndexEntry[]>>;
	readComplete(key: string): Promise<Result<SetupCacheEntry | null>>;
	publishComplete(entry: SetupCacheEntry): Promise<Result<void>>;
	touchComplete(key: string, lastUsedMs: number): Promise<Result<void>>;
	removeEntry(key: string): Promise<Result<void>>;
}

export interface SetupCacheStoragePort {
	/** Serializes recency, atomic publication and eviction for one state root. */
	withExclusiveLock<Value>(
		operation: (locked: LockedSetupCachePort) => Promise<Result<Value>>,
	): Promise<Result<Value>>;
}

/**
 * These methods are backed by the safe workspace/filesystem layer. Restoring
 * must be all-or-nothing and use copy-on-write clones where the host supports
 * them; mutating a restored product must never mutate the cached product.
 */
export interface SetupWorkspacePort {
	/** Read selected files from the current saved-base workspace, in path order. */
	captureSetupInputs(
		paths: readonly string[],
	): Promise<Result<readonly SetupInputFingerprint[]>>;
	captureOutputs(
		declaredOutputs: readonly string[],
	): Promise<Result<readonly SetupProduct[]>>;
	restoreOutputsCopyOnWrite(
		products: readonly SetupProduct[],
	): Promise<Result<void>>;
}

export interface SetupRunResult {
	readonly setupWallMs: number;
}

export interface SetupCacheOutcome {
	readonly setupKey: string | null;
	readonly reused: boolean;
	readonly setupWallMs: number | null;
}

export interface RunSetupWithCacheRequest<Error> {
	readonly cache: SetupCacheStoragePort;
	readonly workspace: SetupWorkspacePort;
	readonly keyInput: SetupCacheKeyInput;
	readonly outputs: readonly string[];
	readonly nowMs: () => number;
	readonly runSetup: () => Promise<Result<SetupRunResult, Error>>;
}

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function safeRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!/[\0\r\n]/u.test(path) &&
		path
			.split("/")
			.every(
				(part) =>
					part !== "" && part !== "." && part !== ".." && part !== ".git",
			)
	);
}

function validDeclaredOutputs(outputs: readonly string[]): boolean {
	if (outputs.length === 0 || outputs.some((path) => !safeRelativePath(path)))
		return false;
	const sorted = [...outputs].sort(compareUtf8);
	for (let index = 0; index < sorted.length; index += 1) {
		const current = sorted[index];
		const next = sorted[index + 1];
		if (current === undefined || (index > 0 && sorted[index - 1] === current))
			return false;
		if (next?.startsWith(`${current}/`)) return false;
	}
	return true;
}

function outputOwnsPath(output: string, path: string): boolean {
	return path === output || path.startsWith(`${output}/`);
}

function outputForPath(
	outputs: readonly string[],
	path: string,
): string | undefined {
	return outputs.find((output) => outputOwnsPath(output, path));
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Validate, deep-copy and byte-sort a snapshot before it can be cached/hit. */
export function canonicalizeSetupProducts(
	declaredOutputs: readonly string[],
	products: readonly SetupProduct[],
): Result<readonly SetupProduct[]> {
	if (!Array.isArray(products) || !validDeclaredOutputs(declaredOutputs))
		return {
			ok: false,
			error: portError("invalid_input", "Setup output paths are invalid."),
		};
	const byPath = new Map<string, SetupProduct>();
	for (const product of products) {
		if (
			!safeRelativePath(product.path) ||
			outputForPath(declaredOutputs, product.path) === undefined ||
			(product.kind !== "file" &&
				product.kind !== "directory" &&
				product.kind !== "symlink") ||
			!Number.isSafeInteger(product.mode) ||
			product.mode < 0 ||
			product.mode > 0o777 ||
			!(product.bytes instanceof Uint8Array) ||
			(product.kind === "directory" && product.bytes.byteLength !== 0) ||
			(product.kind === "symlink" && product.bytes.includes(0)) ||
			!/^[0-9a-f]{64}$/u.test(product.sha256) ||
			product.sha256 !== digest(product.bytes) ||
			byPath.has(product.path)
		)
			return {
				ok: false,
				error: portError(
					"invalid_input",
					"Setup output snapshot is incomplete or inconsistent.",
				),
			};
		byPath.set(product.path, {
			path: product.path,
			kind: product.kind,
			mode: product.mode,
			bytes: product.bytes.slice(),
			sha256: product.sha256,
		});
	}

	for (const output of declaredOutputs) {
		if (!byPath.has(output))
			return {
				ok: false,
				error: portError(
					"invalid_input",
					`Setup output snapshot is missing ${output}.`,
				),
			};
	}
	for (const product of byPath.values()) {
		const output = outputForPath(declaredOutputs, product.path);
		if (output === undefined) continue;
		const parts = product.path.split("/");
		const outputDepth = output.split("/").length;
		for (let depth = outputDepth; depth < parts.length; depth += 1) {
			const ancestor = parts.slice(0, depth).join("/");
			const directory = byPath.get(ancestor);
			if (directory === undefined || directory.kind !== "directory")
				return {
					ok: false,
					error: portError(
						"invalid_input",
						`Setup output snapshot is missing directory ${ancestor}.`,
					),
				};
		}
	}
	return {
		ok: true,
		value: [...byPath.values()].sort((left, right) =>
			compareUtf8(left.path, right.path),
		),
	};
}

function validEntry(
	entry: SetupCacheEntry | null,
	key: string,
	outputs: readonly string[],
): SetupCacheEntry | null {
	if (
		entry === null ||
		typeof entry !== "object" ||
		entry.v !== 2 ||
		entry.key !== key ||
		!Array.isArray(entry.outputs) ||
		!Number.isSafeInteger(entry.setup_wall_ms) ||
		entry.setup_wall_ms < 0 ||
		!Number.isSafeInteger(entry.last_used_ms) ||
		entry.last_used_ms < 0
	)
		return null;
	const canonical = canonicalizeSetupProducts(outputs, entry.outputs);
	if (!canonical.ok) return null;
	return {
		v: 2,
		key,
		setup_wall_ms: entry.setup_wall_ms,
		outputs: canonical.value,
		last_used_ms: entry.last_used_ms,
	};
}

function validIndexEntry(entry: SetupCacheIndexEntry): boolean {
	return (
		/^[0-9a-f]{64}$/u.test(entry.key) &&
		Number.isSafeInteger(entry.last_used_ms) &&
		entry.last_used_ms >= 0
	);
}

async function pruneToLimit(
	cache: LockedSetupCachePort,
	entries: readonly SetupCacheIndexEntry[],
	keep: number,
	protectedKey: string | null,
): Promise<boolean> {
	const ordered = entries
		.filter((entry) => entry.key !== protectedKey)
		.sort((left, right) => {
			const leftTime = validIndexEntry(left) ? left.last_used_ms : -1;
			const rightTime = validIndexEntry(right) ? right.last_used_ms : -1;
			return leftTime - rightTime || compareUtf8(left.key, right.key);
		});
	const protectedCount =
		protectedKey !== null && entries.some((entry) => entry.key === protectedKey)
			? 1
			: 0;
	const retainedCount = Math.max(0, keep - protectedCount);
	const victims = ordered.slice(0, Math.max(0, ordered.length - retainedCount));
	for (const victim of victims) {
		if (!/^[0-9a-f]{64}$/u.test(victim.key)) continue;
		const removed = await cache.removeEntry(victim.key);
		if (!removed.ok) return false;
	}
	return true;
}

function validTimestamp(nowMs: number): boolean {
	return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

async function setupInputsStable(
	workspace: SetupWorkspacePort,
	input: SetupCacheKeyInput,
): Promise<boolean> {
	if (input.setupInputs.length === 0) return input.inputs === null;
	if (input.inputs === null) return false;
	try {
		const current = await workspace.captureSetupInputs(input.setupInputs);
		return (
			current.ok && sameSetupInputFingerprints(current.value, input.inputs)
		);
	} catch {
		return false;
	}
}

function samePathList(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((path, index) => path === right[index])
	);
}

async function readAndTouch(
	cache: SetupCacheStoragePort,
	key: string,
	outputs: readonly string[],
	nowMs: number,
): Promise<SetupCacheEntry | null> {
	if (!validTimestamp(nowMs)) return null;
	const result = await cache.withExclusiveLock(async (locked) => {
		const found = await locked.readComplete(key);
		if (!found.ok) return { ok: true, value: null };
		const entry = validEntry(found.value, key, outputs);
		if (entry === null) return { ok: true, value: null };
		const touched = await locked.touchComplete(key, nowMs);
		if (!touched.ok) return { ok: true, value: null };
		const listed = await locked.listComplete();
		if (!listed.ok) return { ok: true, value: null };
		const retained = await pruneToLimit(
			locked,
			listed.value,
			SETUP_CACHE_ENTRY_LIMIT,
			key,
		);
		if (!retained) return { ok: true, value: null };
		return { ok: true, value: { ...entry, last_used_ms: nowMs } };
	});
	return result.ok ? result.value : null;
}

async function publishWithLru3(
	cache: SetupCacheStoragePort,
	entry: SetupCacheEntry,
): Promise<void> {
	await cache.withExclusiveLock(async (locked) => {
		const listed = await locked.listComplete();
		if (!listed.ok) return { ok: false, error: listed.error };
		const hasKey = listed.value.some(
			(candidate) => candidate.key === entry.key,
		);
		const retained = await pruneToLimit(
			locked,
			listed.value,
			SETUP_CACHE_ENTRY_LIMIT - (hasKey ? 0 : 1),
			entry.key,
		);
		if (!retained)
			return {
				ok: false,
				error: portError("io", "Could not enforce setup cache LRU capacity."),
			};
		return locked.publishComplete(entry);
	});
}

/**
 * Reuse complete setup products, otherwise run setup and publish only a
 * successful output snapshot. Cache errors never turn successful setup into a
 * failure and never become hits.
 */
export async function runSetupWithCache<Error>(
	request: RunSetupWithCacheRequest<Error>,
): Promise<Result<SetupCacheOutcome, Error>> {
	const key = samePathList(request.outputs, request.keyInput.setupOutputs)
		? setupCacheKey(request.keyInput)
		: null;
	if (key !== null && validDeclaredOutputs(request.outputs)) {
		let candidate: SetupCacheEntry | null = null;
		if (await setupInputsStable(request.workspace, request.keyInput)) {
			try {
				candidate = await readAndTouch(
					request.cache,
					key,
					request.outputs,
					request.nowMs(),
				);
			} catch {
				candidate = null;
			}
		}
		if (candidate !== null) {
			try {
				const restored = await request.workspace.restoreOutputsCopyOnWrite(
					candidate.outputs,
				);
				if (
					restored.ok &&
					(await setupInputsStable(request.workspace, request.keyInput))
				)
					return {
						ok: true,
						value: {
							setupKey: key,
							reused: true,
							setupWallMs: candidate.setup_wall_ms,
						},
					};
			} catch {
				// A failed CoW restore is an all-or-nothing cache miss.
			}
		}
	}

	const executed = await request.runSetup();
	if (!executed.ok) return executed;
	if (key === null || !validDeclaredOutputs(request.outputs))
		return {
			ok: true,
			value: {
				setupKey: key,
				reused: false,
				setupWallMs: executed.value.setupWallMs,
			},
		};
	if (
		!Number.isSafeInteger(executed.value.setupWallMs) ||
		executed.value.setupWallMs < 0
	)
		return {
			ok: true,
			value: { setupKey: key, reused: false, setupWallMs: null },
		};
	if (!(await setupInputsStable(request.workspace, request.keyInput)))
		return {
			ok: true,
			value: {
				setupKey: key,
				reused: false,
				setupWallMs: executed.value.setupWallMs,
			},
		};

	try {
		const captured = await request.workspace.captureOutputs(request.outputs);
		if (!captured.ok)
			return {
				ok: true,
				value: {
					setupKey: key,
					reused: false,
					setupWallMs: executed.value.setupWallMs,
				},
			};
		const outputs = canonicalizeSetupProducts(request.outputs, captured.value);
		if (!outputs.ok)
			return {
				ok: true,
				value: {
					setupKey: key,
					reused: false,
					setupWallMs: executed.value.setupWallMs,
				},
			};
		const used = request.nowMs();
		if (!validTimestamp(used))
			return {
				ok: true,
				value: {
					setupKey: key,
					reused: false,
					setupWallMs: executed.value.setupWallMs,
				},
			};
		await publishWithLru3(request.cache, {
			v: 2,
			key,
			setup_wall_ms: executed.value.setupWallMs,
			outputs: outputs.value,
			last_used_ms: used,
		});
	} catch {
		// Cache persistence is an optimization; setup already succeeded.
	}
	return {
		ok: true,
		value: {
			setupKey: key,
			reused: false,
			setupWallMs: executed.value.setupWallMs,
		},
	};
}
