import { isAbsolute } from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort } from "../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../fs/read";
import type { IntentPredicate, ParsedIntent } from "./parse";

export const PREDICATE_FILE_MAX_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const UTF8 = new TextEncoder();

export interface CheckedPredicate {
	readonly name: string;
	readonly path: string;
}

export type PredicateCheckResult =
	| {
			readonly kind: "matched";
			readonly checked: readonly CheckedPredicate[];
	  }
	| {
			readonly kind: "stale";
			readonly predicate: IntentPredicate;
			readonly reason: "path_missing" | "content_missing";
	  }
	| {
			readonly kind: "invalid";
			readonly predicate: IntentPredicate;
			readonly message: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly predicate: IntentPredicate;
			readonly error: PortError;
	  };

export interface PredicateReadPort {
	read(path: string): Promise<Result<Uint8Array>>;
}

export interface ApprovalPredicateFailure {
	readonly code:
		| "intent/predicate_invalid"
		| "intent/predicate_missing"
		| "intent/predicate_changed"
		| "environment/predicate_unavailable";
	readonly message: string;
	readonly predicate?: IntentPredicate;
}

export function intentPredicates(
	intent: ParsedIntent,
): readonly IntentPredicate[] {
	return [
		...intent.frontmatter.assumptions,
		...intent.frontmatter.sharedContracts,
	];
}

/** Reject paths that could escape the immutable base or inspect Git metadata. */
export function isSafePredicatePath(path: string): boolean {
	const encoded = UTF8.encode(path);
	let roundTrips = false;
	try {
		roundTrips =
			new TextDecoder("utf-8", { fatal: true }).decode(encoded) === path;
	} catch {
		return false;
	}
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		encoded.byteLength <= 4096 &&
		roundTrips &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path
			.split("/")
			.every(
				(part) =>
					part.length > 0 && part !== "." && part !== ".." && part !== ".git",
			)
	);
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.byteLength === 0) return true;
	if (needle.byteLength > haystack.byteLength) return false;
	for (
		let offset = 0;
		offset <= haystack.byteLength - needle.byteLength;
		offset += 1
	) {
		let matches = true;
		for (let index = 0; index < needle.byteLength; index += 1) {
			if (haystack[offset + index] !== needle[index]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function unavailableError(cause: unknown): PortError {
	return {
		code: "unavailable",
		message:
			cause instanceof Error
				? `Predicate file could not be read: ${cause.message}`
				: "Predicate file could not be read.",
		retryable: true,
		...(cause === undefined ? {} : { cause }),
	};
}

/** Check each expectation against bytes read from the exact base being checked. */
export async function checkIntentPredicates(
	predicates: readonly IntentPredicate[],
	reader: PredicateReadPort,
): Promise<PredicateCheckResult> {
	const checked: CheckedPredicate[] = [];
	const reads = new Map<string, Promise<Result<Uint8Array>>>();
	for (const predicate of predicates) {
		if (
			predicate.name.trim().length === 0 ||
			predicate.contains.trim().length === 0
		)
			return {
				kind: "invalid",
				predicate,
				message: "Predicate names and contains text must be non-empty.",
			};
		if (!isSafePredicatePath(predicate.path))
			return {
				kind: "invalid",
				predicate,
				message: `Predicate ${JSON.stringify(predicate.name)} has an unsafe path.`,
			};
		let read = reads.get(predicate.path);
		if (read === undefined) {
			read = Promise.resolve()
				.then(() => reader.read(predicate.path))
				.catch((cause: unknown) => ({
					ok: false as const,
					error: unavailableError(cause),
				}));
			reads.set(predicate.path, read);
		}
		const result = await read;
		if (!result.ok) {
			if (result.error.code === "not_found")
				return { kind: "stale", predicate, reason: "path_missing" };
			return { kind: "unavailable", predicate, error: result.error };
		}
		const expected = new TextEncoder().encode(predicate.contains);
		if (!containsBytes(result.value, expected))
			return { kind: "stale", predicate, reason: "content_missing" };
		checked.push({ name: predicate.name, path: predicate.path });
	}
	return { kind: "matched", checked };
}

/** Validate approval predicates using an anchored read rooted at the base tree. */
export async function validateApprovalPredicates(input: {
	readonly intent: ParsedIntent;
	readonly baseRoot: string;
	readonly filesystem: Pick<FileSystemPort, "readFile">;
}): Promise<Result<readonly CheckedPredicate[], ApprovalPredicateFailure>> {
	const predicates = intentPredicates(input.intent);
	if (predicates.length === 0) return { ok: true, value: [] };
	if (!isAbsolute(input.baseRoot) || input.baseRoot.includes("\0"))
		return {
			ok: false,
			error: {
				code: "environment/predicate_unavailable",
				message: "The exact approval base path is invalid.",
			},
		};
	const result = await checkIntentPredicates(predicates, {
		read: (path) =>
			input.filesystem.readFile({
				root: input.baseRoot,
				path,
				maxBytes: PREDICATE_FILE_MAX_BYTES,
			}),
	});
	if (result.kind === "matched") return { ok: true, value: result.checked };
	if (result.kind === "invalid")
		return {
			ok: false,
			error: {
				code: "intent/predicate_invalid",
				message: result.message,
				predicate: result.predicate,
			},
		};
	if (result.kind === "stale")
		return {
			ok: false,
			error: {
				code:
					result.reason === "path_missing"
						? "intent/predicate_missing"
						: "intent/predicate_changed",
				message:
					result.reason === "path_missing"
						? `Predicate ${JSON.stringify(result.predicate.name)} references missing base path ${JSON.stringify(result.predicate.path)}.`
						: `Predicate ${JSON.stringify(result.predicate.name)} is not present in base path ${JSON.stringify(result.predicate.path)}.`,
				predicate: result.predicate,
			},
		};
	return {
		ok: false,
		error: {
			code: "environment/predicate_unavailable",
			message: `Could not check predicate ${JSON.stringify(result.predicate.name)} at ${JSON.stringify(result.predicate.path)}: ${result.error.message}`,
			predicate: result.predicate,
		},
	};
}
