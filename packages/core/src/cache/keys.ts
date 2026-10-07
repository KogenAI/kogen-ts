import { createHash } from "node:crypto";
import type { CheckSpec } from "../project/schema";

export interface SetupInputFingerprint {
	readonly path: string;
	/** POSIX permission bits from the checked base tree. */
	readonly mode: number;
	readonly sha256: string;
}

export interface SetupCacheKeyInput {
	readonly baseTree: string | null;
	readonly setup: readonly CheckSpec[];
	readonly setupOutputs: readonly string[];
	readonly setupInputs: readonly string[];
	/** The exact input files, in setupInputs order; null means not established. */
	readonly inputs: readonly SetupInputFingerprint[] | null;
	readonly childEnv: Readonly<Record<string, string>> | null;
	readonly os: string | null;
	readonly arch: string | null;
	readonly elixir: string | null;
	readonly otp: string | null;
}

export interface ApprovalBaselineKeyInput {
	readonly checkedBaseTree: string | null;
	readonly setupKey: string | null;
	readonly checks: readonly CheckSpec[];
	readonly childEnv: Readonly<Record<string, string>> | null;
	readonly toolchain: Readonly<Record<string, string>> | null;
	readonly os: string | null;
	readonly arch: string | null;
	readonly adapterVersion: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SETUP_ENV_OMIT = new Set([
	"TMPDIR",
	"MISE_STATE_DIR",
	"MISE_CACHE_DIR",
	"MISE_TRUSTED_CONFIG_PATHS",
]);

/** Byte-order comparison keeps key encoding independent of host locale. */
export function compareUtf8(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

/** Canonical JSON for cache material: sorted object keys, preserved array order. */
export function canonicalCacheJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value))
			throw new TypeError("Cache keys accept only safe integer numbers.");
		return String(value);
	}
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalCacheJson(entry)).join(",")}]`;
	if (typeof value !== "object")
		throw new TypeError("Cache key material is not JSON-compatible.");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError("Cache key objects must be plain records.");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort(compareUtf8);
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalCacheJson(record[key])}`)
		.join(",")}}`;
}

function digestCanonical(value: unknown): string | null {
	try {
		return createHash("sha256")
			.update(canonicalCacheJson(value), "utf8")
			.digest("hex");
	} catch {
		return null;
	}
}

function validGitTree(value: string | null): value is string {
	return value !== null && GIT_TREE.test(value);
}

function validIdentity(value: string | null): value is string {
	return value !== null && value.length > 0 && !value.includes("\0");
}

function validRelativePath(path: string): boolean {
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

function hasOverlappingPaths(paths: readonly string[]): boolean {
	const sorted = [...paths].sort(compareUtf8);
	for (let index = 0; index < sorted.length; index += 1) {
		const current = sorted[index];
		if (current === undefined) return true;
		if (index > 0 && sorted[index - 1] === current) return true;
		const next = sorted[index + 1];
		if (next?.startsWith(`${current}/`)) return true;
	}
	return false;
}

function pathsOverlap(left: string, right: string): boolean {
	return (
		left === right ||
		left.startsWith(`${right}/`) ||
		right.startsWith(`${left}/`)
	);
}

function validChecks(checks: readonly CheckSpec[]): boolean {
	const names = new Set<string>();
	return checks.every((check) => {
		if (
			check.name.length === 0 ||
			check.name.includes("\0") ||
			names.has(check.name) ||
			check.argv.length === 0 ||
			check.argv.some(
				(argument) => argument.length === 0 || argument.includes("\0"),
			) ||
			!Number.isSafeInteger(check.timeoutMs) ||
			check.timeoutMs < 1
		)
			return false;
		names.add(check.name);
		return true;
	});
}

function validStringRecord(
	value: Readonly<Record<string, string>> | null,
): value is Readonly<Record<string, string>> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.entries(value).every(
		([key, entry]) =>
			key.length > 0 &&
			!key.includes("\0") &&
			typeof entry === "string" &&
			!entry.includes("\0"),
	);
}

function checkMaterial(checks: readonly CheckSpec[]): readonly {
	name: string;
	argv: readonly string[];
	timeout_ms: number;
}[] {
	return checks.map((check) => ({
		name: check.name,
		argv: [...check.argv],
		timeout_ms: check.timeoutMs,
	}));
}

/**
 * Build the v2 setup-product key. Declared setup inputs narrow only this key:
 * their ordered path/mode/content identities replace the full base-tree identity.
 */
export function setupCacheKey(input: SetupCacheKeyInput): string | null {
	if (
		!validGitTree(input.baseTree) ||
		input.setup.length === 0 ||
		input.setupOutputs.length === 0 ||
		!validChecks(input.setup) ||
		!validStringRecord(input.childEnv) ||
		!validIdentity(input.os) ||
		!validIdentity(input.arch) ||
		!validIdentity(input.elixir) ||
		!validIdentity(input.otp) ||
		input.setupOutputs.some((path) => !validRelativePath(path)) ||
		hasOverlappingPaths(input.setupOutputs) ||
		input.setupInputs.some((path) => !validRelativePath(path)) ||
		new Set(input.setupInputs).size !== input.setupInputs.length ||
		input.setupInputs.some((inputPath) =>
			input.setupOutputs.some((outputPath) =>
				pathsOverlap(inputPath, outputPath),
			),
		)
	)
		return null;

	let inputs: readonly SetupInputFingerprint[] | null = null;
	let baseTree = input.baseTree;
	if (input.setupInputs.length === 0) {
		if (input.inputs !== null) return null;
	} else {
		if (
			input.inputs === null ||
			input.inputs.length !== input.setupInputs.length ||
			input.inputs.some((entry, index) => {
				const expectedPath = input.setupInputs[index];
				return (
					expectedPath === undefined ||
					entry.path !== expectedPath ||
					!validRelativePath(entry.path) ||
					!Number.isSafeInteger(entry.mode) ||
					entry.mode < 0 ||
					entry.mode > 0o777 ||
					!SHA256.test(entry.sha256)
				);
			})
		)
			return null;
		inputs = input.inputs.map((entry) => ({
			path: entry.path,
			mode: entry.mode,
			sha256: entry.sha256,
		}));
		const narrowedTree = digestCanonical({ setup_inputs: inputs });
		if (narrowedTree === null) return null;
		baseTree = narrowedTree;
	}

	const childEnv = Object.fromEntries(
		Object.entries(input.childEnv)
			.filter(([name]) => !SETUP_ENV_OMIT.has(name))
			.sort(([left], [right]) => compareUtf8(left, right)),
	);
	return digestCanonical({
		v: 2,
		base_tree: baseTree,
		setup: checkMaterial(input.setup),
		setup_outputs: [...input.setupOutputs],
		child_env: childEnv,
		os: input.os,
		arch: input.arch,
		elixir: input.elixir,
		otp: input.otp,
		inputs,
	});
}

/** Build the v3 approval-baseline key; every unknown check identity is a miss. */
export function approvalBaselineCacheKeyV3(
	input: ApprovalBaselineKeyInput,
): string | null {
	if (
		!validGitTree(input.checkedBaseTree) ||
		input.setupKey === null ||
		!SHA256.test(input.setupKey) ||
		!validChecks(input.checks) ||
		!validStringRecord(input.childEnv) ||
		!validStringRecord(input.toolchain) ||
		!validIdentity(input.os) ||
		!validIdentity(input.arch) ||
		!validIdentity(input.adapterVersion)
	)
		return null;
	return digestCanonical({
		v: 3,
		checked_base_tree: input.checkedBaseTree,
		setup_key: input.setupKey,
		checks: checkMaterial(input.checks),
		child_env: input.childEnv,
		toolchain: input.toolchain,
		os: input.os,
		arch: input.arch,
		adapter_version: input.adapterVersion,
	});
}

/** Fingerprint bytes read from the saved base snapshot, preserving file mode. */
export function fingerprintSetupInput(
	path: string,
	mode: number,
	bytes: Uint8Array,
): SetupInputFingerprint | null {
	if (
		!validRelativePath(path) ||
		!Number.isSafeInteger(mode) ||
		mode < 0 ||
		mode > 0o777
	)
		return null;
	return {
		path,
		mode,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

export function sameSetupInputFingerprints(
	left: readonly SetupInputFingerprint[],
	right: readonly SetupInputFingerprint[],
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index];
			return (
				other !== undefined &&
				entry.path === other.path &&
				entry.mode === other.mode &&
				entry.sha256 === other.sha256
			);
		})
	);
}
