import { createHash } from "node:crypto";
import { resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface ConversationKeyMaterial {
	readonly runDirectory: string;
	readonly stage: string;
	readonly attempt?: string;
	readonly rung?: string;
	readonly epoch?: string;
}

export interface SessionKeys {
	readonly cacheKey: string;
	readonly threadId: string;
	readonly protocolSessionId: string;
}

/**
 * Run-scoped affinity key. The run path is supplied by the trusted controller,
 * not by model-visible input. The result contains no path or credential data.
 */
export function deriveCacheKey(runDirectory: string): string {
	const directory = expandedRunDirectory(runDirectory);
	return sha256(["kogen:responses:cache:v3", directory]);
}

/** A distinct stable Lite protocol id; it is never the cache key or thread id. */
export function deriveProtocolSessionId(runDirectory: string): string {
	const directory = expandedRunDirectory(runDirectory);
	return sha256(["kogen:responses:lite-session:v1", directory]);
}

/**
 * Stable conversation identity for a (run, stage, attempt, rung, epoch) tuple.
 * Model and effort are intentionally excluded so a same-conversation model
 * switch retains its thread.
 */
export function deriveThreadId(material: ConversationKeyMaterial): string {
	const directory = expandedRunDirectory(material.runDirectory);
	const attempt = material.attempt ?? "builder";
	const rung = material.rung ?? attempt;
	const epoch = material.epoch ?? "initial";
	for (const [label, value] of Object.entries({
		stage: material.stage,
		attempt,
		rung,
		epoch,
	}))
		validateTupleValue(value, label);
	return sha256([
		"kogen:responses:v2",
		directory,
		material.stage,
		attempt,
		rung,
		epoch,
	]);
}

export function deriveSessionKeys(
	material: ConversationKeyMaterial,
	cacheKeyOverride?: string,
): SessionKeys {
	const cacheKey =
		cacheKeyOverride === undefined
			? deriveCacheKey(material.runDirectory)
			: validateOpaqueId(cacheKeyOverride, "cache key");
	return Object.freeze({
		cacheKey,
		threadId: deriveThreadId(material),
		protocolSessionId: deriveProtocolSessionId(material.runDirectory),
	});
}

export function validateOpaqueId(value: string, label = "identifier"): string {
	if (typeof value !== "string" || !SAFE_ID.test(value))
		throw new TypeError(`${label} must be a safe opaque identifier.`);
	return value;
}

export function expandedRunDirectory(runDirectory: string): string {
	if (
		typeof runDirectory !== "string" ||
		!runDirectory.startsWith("/") ||
		runDirectory.includes("\0")
	)
		throw new TypeError("Run directory must be an absolute path.");
	const expanded = resolve(runDirectory);
	if (expanded.includes("\0")) throw new TypeError("Run directory is invalid.");
	return expanded;
}

function validateTupleValue(value: string, label: string): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		value.includes("\0") ||
		/[\r\n]/.test(value)
	)
		throw new TypeError(`${label} is invalid.`);
}

function sha256(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}
