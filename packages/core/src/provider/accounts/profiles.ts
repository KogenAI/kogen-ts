import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type { FileSystemPort } from "../../contracts/ports";
import {
	ACCOUNT_LABEL_PATTERN,
	type AccountProvider,
	type AccountsDocument,
} from "./format";

export const PROFILES_FILE_MAX_BYTES = 1024 * 1024;
export const HOST_FILE_MAX_BYTES = 4096;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface ChatGptProfile {
	readonly client_id: string;
	readonly subject: string;
	readonly email: string | null;
	readonly expires_at: number | null;
	readonly signed_in: boolean;
	readonly plan_usage: JsonValue | null;
	readonly notice_shown: boolean;
	readonly remote_revoked: boolean;
}

export interface GrokProfile {
	readonly email: string | null;
	readonly expires_at: number | null;
	readonly signed_in: boolean;
}

export interface ProfilesDocument {
	readonly chatgpt: Readonly<Record<string, ChatGptProfile>>;
	readonly grok: Readonly<Record<string, GrokProfile>>;
}

export type AccountProfile = ChatGptProfile | GrokProfile;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

function kogenDirectory(homeDirectory: string): string {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0"))
		throw new TypeError("HOME must be an absolute path.");
	return join(resolve(homeDirectory), ".kogen");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
	return typeof value === "string" && !/[\0\r\n]/u.test(value);
}

function isTimestamp(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

function isJsonValue(
	value: unknown,
	seen = new Set<object>(),
): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	try {
		if (Array.isArray(value))
			return value.every((item) => isJsonValue(item, seen));
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		)
			return false;
		return Object.entries(value).every(
			([key, item]) => isText(key) && isJsonValue(item, seen),
		);
	} finally {
		seen.delete(value);
	}
}

function parseChatGptProfile(value: unknown): ChatGptProfile | null {
	if (!isRecord(value)) return null;
	if (
		!isText(value.client_id) ||
		!isText(value.subject) ||
		!(value.email === null || isText(value.email)) ||
		!isTimestamp(value.expires_at) ||
		typeof value.signed_in !== "boolean" ||
		!(value.plan_usage === null || isJsonValue(value.plan_usage)) ||
		typeof value.notice_shown !== "boolean" ||
		typeof value.remote_revoked !== "boolean"
	)
		return null;
	return {
		client_id: value.client_id,
		subject: value.subject,
		email: value.email,
		expires_at: value.expires_at,
		signed_in: value.signed_in,
		plan_usage: value.plan_usage,
		notice_shown: value.notice_shown,
		remote_revoked: value.remote_revoked,
	};
}

function parseGrokProfile(value: unknown): GrokProfile | null {
	if (!isRecord(value)) return null;
	if (
		!(value.email === null || isText(value.email)) ||
		!isTimestamp(value.expires_at) ||
		typeof value.signed_in !== "boolean"
	)
		return null;
	return {
		email: value.email,
		expires_at: value.expires_at,
		signed_in: value.signed_in,
	};
}

function parseProviderProfiles<Value>(
	value: unknown,
	parseProfile: (value: unknown) => Value | null,
): Readonly<Record<string, Value>> | null {
	if (!isRecord(value)) return null;
	const profiles: Record<string, Value> = Object.create(null);
	for (const [label, profile] of Object.entries(value)) {
		if (!ACCOUNT_LABEL_PATTERN.test(label)) return null;
		const parsed = parseProfile(profile);
		if (parsed === null) return null;
		profiles[label] = parsed;
	}
	return profiles;
}

export function parseProfilesJson(bytes: Uint8Array): Result<ProfilesDocument> {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes));
	} catch {
		return {
			ok: false,
			error: error("invalid_input", "profiles.json is not valid JSON."),
		};
	}
	if (!isRecord(value))
		return {
			ok: false,
			error: error("invalid_input", "profiles.json must contain a map."),
		};
	const chatgpt = parseProviderProfiles(
		value.chatgpt ?? {},
		parseChatGptProfile,
	);
	const grok = parseProviderProfiles(value.grok ?? {}, parseGrokProfile);
	if (chatgpt === null || grok === null)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"profiles.json contains an invalid account profile.",
			),
		};
	return { ok: true, value: { chatgpt, grok } };
}

function compareUtf8(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.byteLength - b.byteLength;
}

function canonicalChatGptProfiles(
	value: Readonly<Record<string, ChatGptProfile>>,
): Record<string, ChatGptProfile> {
	const sorted: Record<string, ChatGptProfile> = Object.create(null);
	for (const label of Object.keys(value).sort(compareUtf8)) {
		const profile = value[label];
		if (profile === undefined) continue;
		sorted[label] = {
			client_id: profile.client_id,
			subject: profile.subject,
			email: profile.email,
			expires_at: profile.expires_at,
			signed_in: profile.signed_in,
			plan_usage: profile.plan_usage,
			notice_shown: profile.notice_shown,
			remote_revoked: profile.remote_revoked,
		};
	}
	return sorted;
}

function canonicalGrokProfiles(
	value: Readonly<Record<string, GrokProfile>>,
): Record<string, GrokProfile> {
	const sorted: Record<string, GrokProfile> = Object.create(null);
	for (const label of Object.keys(value).sort(compareUtf8)) {
		const profile = value[label];
		if (profile === undefined) continue;
		sorted[label] = {
			email: profile.email,
			expires_at: profile.expires_at,
			signed_in: profile.signed_in,
		};
	}
	return sorted;
}

export function serializeProfilesJson(profiles: ProfilesDocument): Uint8Array {
	const bytes = encoder.encode(
		JSON.stringify({
			chatgpt: canonicalChatGptProfiles(profiles.chatgpt),
			grok: canonicalGrokProfiles(profiles.grok),
		}),
	);
	if (bytes.byteLength > PROFILES_FILE_MAX_BYTES)
		throw new RangeError("profiles.json exceeds its size limit.");
	if (!parseProfilesJson(bytes).ok)
		throw new TypeError("profiles.json contains an invalid account profile.");
	return bytes;
}

export async function readProfilesFile(
	filesystem: Pick<FileSystemPort, "readFile">,
	homeDirectory: string,
): Promise<Result<ProfilesDocument>> {
	let root: string;
	try {
		root = kogenDirectory(homeDirectory);
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				cause instanceof Error ? cause.message : "HOME is invalid.",
			),
		};
	}
	const result = await filesystem.readFile({
		root,
		path: "profiles.json",
		maxBytes: PROFILES_FILE_MAX_BYTES,
	});
	if (!result.ok) {
		if (result.error.code === "not_found")
			return { ok: true, value: { chatgpt: {}, grok: {} } };
		return { ok: false, error: result.error };
	}
	return parseProfilesJson(result.value);
}

export async function writeProfilesFile(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	homeDirectory: string,
	profiles: ProfilesDocument,
): Promise<Result<void>> {
	let root: string;
	let bytes: Uint8Array;
	try {
		root = kogenDirectory(homeDirectory);
		bytes = serializeProfilesJson(profiles);
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				cause instanceof Error ? cause.message : "profiles.json is invalid.",
			),
		};
	}
	return filesystem.writeFileAtomically({
		root,
		path: "profiles.json",
		bytes,
		mode: 0o600,
	});
}

export function withAccountProfile(
	profiles: ProfilesDocument,
	provider: "chatgpt",
	label: string,
	profile: ChatGptProfile,
): ProfilesDocument;
export function withAccountProfile(
	profiles: ProfilesDocument,
	provider: "grok",
	label: string,
	profile: GrokProfile,
): ProfilesDocument;
export function withAccountProfile(
	profiles: ProfilesDocument,
	provider: AccountProvider,
	label: string,
	profile: AccountProfile,
): ProfilesDocument {
	if (!ACCOUNT_LABEL_PATTERN.test(label))
		throw new TypeError("Account label is invalid.");
	return {
		chatgpt:
			provider === "chatgpt"
				? { ...profiles.chatgpt, [label]: profile as ChatGptProfile }
				: profiles.chatgpt,
		grok:
			provider === "grok"
				? { ...profiles.grok, [label]: profile as GrokProfile }
				: profiles.grok,
	};
}

export function formatProfileList(
	profiles: ProfilesDocument,
	accounts: AccountsDocument,
): string {
	const rows: string[] = [];
	const selectedProvider = accounts.selection?.default ?? "chatgpt";
	for (const provider of ["chatgpt", "grok"] as const) {
		const entries = profiles[provider];
		for (const label of Object.keys(entries).sort(compareUtf8)) {
			const profile = entries[label];
			if (profile === undefined) continue;
			const defaultLabel = accounts[provider]?.default ?? "default";
			const isDefault = provider === selectedProvider && label === defaultLabel;
			const signedIn = profile.signed_in ? "signed in" : "signed out";
			const email = profile.email === null ? "" : ` ${profile.email}`;
			const expiry =
				profile.expires_at === null ? "" : ` expires=${profile.expires_at}`;
			rows.push(
				`${provider}:${label}${isDefault ? " (default)" : ""} ${signedIn}${email}${expiry}`,
			);
		}
	}
	return rows.length > 0
		? `${rows.join("\n")}\n`
		: "chatgpt: not signed in\ngrok: not signed in\n";
}

function isHostUuid(value: string): boolean {
	return UUID_V4.test(value);
}

export function isHostId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("urn:uuid:") &&
		isHostUuid(value.slice("urn:uuid:".length))
	);
}

export async function loadOrCreateHostId(
	filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">,
	homeDirectory: string,
	createUuid: () => string = randomUUID,
): Promise<Result<string>> {
	let root: string;
	try {
		root = kogenDirectory(homeDirectory);
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				cause instanceof Error ? cause.message : "HOME is invalid.",
			),
		};
	}
	const existing = await filesystem.readFile({
		root,
		path: "host.json",
		maxBytes: HOST_FILE_MAX_BYTES,
	});
	if (existing.ok) {
		try {
			const parsed: unknown = JSON.parse(decoder.decode(existing.value));
			if (isRecord(parsed) && isHostId(parsed.ext_agent_host_id))
				return { ok: true, value: parsed.ext_agent_host_id };
		} catch {
			// A malformed persistent host identity is reported below, never replaced silently.
		}
		return {
			ok: false,
			error: error(
				"invalid_input",
				"host.json contains an invalid ext_agent_host_id.",
			),
		};
	}
	if (existing.error.code !== "not_found")
		return { ok: false, error: existing.error };
	let uuid: string;
	try {
		uuid = createUuid();
	} catch {
		return {
			ok: false,
			error: error("unavailable", "Could not create a host UUID."),
		};
	}
	if (!isHostUuid(uuid))
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Host UUID generator must return a UUID v4.",
			),
		};
	const hostId = `urn:uuid:${uuid.toLowerCase()}`;
	const bytes = encoder.encode(JSON.stringify({ ext_agent_host_id: hostId }));
	const written = await filesystem.writeFileAtomically({
		root,
		path: "host.json",
		bytes,
		mode: 0o600,
	});
	if (!written.ok) return written;
	return { ok: true, value: hostId };
}
