import type { ApprovalCheckBaseline } from "../approval/card";
import type {
	ApprovalBaselineCacheEntry,
	ApprovalBaselineCachePort,
} from "../approval/preflight";
import type { PortError } from "../contracts/errors";
import type { FileSystemPort } from "../contracts/ports";
import { canonicalCacheJson } from "./keys";

export const APPROVAL_BASELINE_CACHE_DIRECTORY = "approval-cache";
export const APPROVAL_BASELINE_CACHE_MODE = 0o600;
export const APPROVAL_BASELINE_CACHE_MAX_BYTES = 16 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STATUSES = new Set([
	"green",
	"red",
	"unavailable",
	"timeout",
	"mutating",
]);

interface BaselineDiskEntry {
	readonly v: 3;
	readonly key: string;
	readonly checked_base_tree: string;
	readonly checks: readonly ApprovalCheckBaseline[];
}

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validFinding(
	value: unknown,
): value is ApprovalCheckBaseline["findings"][number] {
	if (!isRecord(value)) return false;
	return (
		typeof value.path === "string" &&
		typeof value.rule === "string" &&
		typeof value.symbol === "string" &&
		typeof value.message === "string" &&
		(value.line === undefined ||
			(Number.isSafeInteger(value.line) && Number(value.line) >= 1))
	);
}

function validRows(value: unknown): value is readonly ApprovalCheckBaseline[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => {
			if (!isRecord(entry) || !Array.isArray(entry.findings)) return false;
			return (
				typeof entry.name === "string" &&
				entry.name.length > 0 &&
				typeof entry.status === "string" &&
				STATUSES.has(entry.status) &&
				(entry.exit_status === null ||
					Number.isSafeInteger(entry.exit_status)) &&
				entry.findings.every(validFinding)
			);
		})
	);
}

function cloneRows(
	rows: readonly ApprovalCheckBaseline[],
): readonly ApprovalCheckBaseline[] {
	return rows.map((row) => ({
		name: row.name,
		status: row.status,
		exit_status: row.exit_status,
		findings: row.findings.map((finding) => ({
			path: finding.path,
			rule: finding.rule,
			symbol: finding.symbol,
			message: finding.message,
			...(finding.line === undefined ? {} : { line: finding.line }),
		})),
	}));
}

function baselinePath(key: string): string {
	return `${APPROVAL_BASELINE_CACHE_DIRECTORY}/${key}.json`;
}

function validLookup(request: {
	readonly key: string;
	readonly checkedBaseTree: string;
}): boolean {
	return SHA256.test(request.key) && GIT_TREE.test(request.checkedBaseTree);
}

function decodeEntry(
	bytes: Uint8Array,
	request: { readonly key: string; readonly checkedBaseTree: string },
): ApprovalBaselineCacheEntry | null {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		value.v !== 3 ||
		value.key !== request.key ||
		value.checked_base_tree !== request.checkedBaseTree ||
		!validRows(value.checks)
	)
		return null;
	return {
		key: request.key,
		checkedBaseTree: request.checkedBaseTree,
		checks: cloneRows(value.checks),
	};
}

function validEntry(entry: ApprovalBaselineCacheEntry): boolean {
	return (
		SHA256.test(entry.key) &&
		GIT_TREE.test(entry.checkedBaseTree) &&
		validRows(entry.checks)
	);
}

/** Create the atomic JSON-file port consumed by approval preflight. */
export function createApprovalBaselineCache(
	filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">,
	root: string,
): ApprovalBaselineCachePort {
	return {
		async get(request) {
			if (!validLookup(request)) return { ok: true, value: null };
			const read = await filesystem.readFile({
				root,
				path: baselinePath(request.key),
				maxBytes: APPROVAL_BASELINE_CACHE_MAX_BYTES,
			});
			if (!read.ok) {
				if (read.error.code === "not_found") return { ok: true, value: null };
				return read;
			}
			const entry = decodeEntry(read.value, request);
			return { ok: true, value: entry };
		},
		async put(entry) {
			if (!validEntry(entry))
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Approval baseline cache entry is invalid.",
					),
				};
			const diskEntry: BaselineDiskEntry = {
				v: 3,
				key: entry.key,
				checked_base_tree: entry.checkedBaseTree,
				checks: cloneRows(entry.checks),
			};
			let bytes: Uint8Array;
			try {
				bytes = new TextEncoder().encode(canonicalCacheJson(diskEntry));
			} catch {
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Approval baseline cache entry is not JSON-compatible.",
					),
				};
			}
			return filesystem.writeFileAtomically({
				root,
				path: baselinePath(entry.key),
				bytes,
				mode: APPROVAL_BASELINE_CACHE_MODE,
			});
		},
	};
}

/** A v2 or malformed entry can never be promoted into a v3 baseline hit. */
export function decodeApprovalBaselineCacheEntry(
	bytes: Uint8Array,
	request: { readonly key: string; readonly checkedBaseTree: string },
): ApprovalBaselineCacheEntry | null {
	if (
		!validLookup(request) ||
		bytes.byteLength > APPROVAL_BASELINE_CACHE_MAX_BYTES
	)
		return null;
	return decodeEntry(bytes, request);
}
