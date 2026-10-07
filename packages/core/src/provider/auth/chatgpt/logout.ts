import type { PortError, Result } from "../../../contracts/errors";
import type {
	CredentialPort,
	FileSystemPort,
	HttpPort,
	HttpRequest,
	HttpResponse,
} from "../../../contracts/ports";
import { isAccountLabel } from "../../accounts/format";
import {
	readProfilesFile,
	withAccountProfile,
	writeProfilesFile,
} from "../../accounts/profiles";
import {
	CHATGPT_AUTH_BASE_URL,
	CHATGPT_CREDENTIAL_KEY,
	CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	type ChatGptCredential,
} from "./login";
import {
	CHATGPT_AUTH_MAX_RESPONSE_BYTES,
	type ChatGptAuthResult,
	parseSavedChatGptCredential,
} from "./refresh";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ChatGptLogoutOptions {
	readonly credentials: CredentialPort;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly http: HttpPort;
	readonly homeDirectory: string;
	readonly label: string;
	readonly authUrl?: string;
	readonly signal?: AbortSignal;
}

export interface ChatGptLogoutOutcome {
	/** False means local state was removed but the provider revocation was uncertain. */
	readonly remoteRevocationConfirmed: boolean;
	/** True when no readable credential existed, so remote revocation was impossible. */
	readonly recoveredUnreadableCredential: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authBase(value: string | undefined): string | null {
	try {
		const url = new URL(value ?? CHATGPT_AUTH_BASE_URL);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username.length > 0 ||
			url.password.length > 0 ||
			url.search.length > 0 ||
			url.hash.length > 0 ||
			url.href.length > 2048
		)
			return null;
		return url.toString().replace(/\/$/u, "");
	} catch {
		return null;
	}
}

function sameOriginEndpoint(value: unknown, origin: string): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.origin !== origin ||
			url.username.length > 0 ||
			url.password.length > 0 ||
			url.hash.length > 0 ||
			url.href.length > 2048
		)
			return null;
		return url.toString();
	} catch {
		return null;
	}
}

function getRequest(url: string): HttpRequest {
	return {
		method: "GET",
		url,
		headers: { accept: "application/json" },
		firstByteTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	};
}

async function readJson(
	http: HttpPort,
	request: HttpRequest,
	signal?: AbortSignal,
	allowNonJson = false,
): Promise<Result<{ readonly status: number; readonly body: unknown }>> {
	let response: Result<HttpResponse>;
	try {
		response = await http.request(request, signal);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: "ChatGPT revocation request failed.",
				retryable: true,
				cause,
			},
		};
	}
	if (!response.ok) return response;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of response.value.body) {
			length += chunk.byteLength;
			if (length > CHATGPT_AUTH_MAX_RESPONSE_BYTES)
				return {
					ok: false,
					error: {
						code: "invalid_input",
						message: "ChatGPT revocation response is too large.",
						retryable: false,
					},
				};
			chunks.push(chunk.slice());
		}
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: "ChatGPT revocation response could not be read.",
				retryable: true,
				cause,
			},
		};
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			ok: true,
			value: {
				status: response.value.status,
				body: JSON.parse(decoder.decode(bytes)) as unknown,
			},
		};
	} catch {
		if (allowNonJson)
			return { ok: true, value: { status: response.value.status, body: null } };
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "ChatGPT revocation response is invalid JSON.",
				retryable: false,
			},
		};
	}
}

async function revokeCredential(
	options: ChatGptLogoutOptions,
	credential: ChatGptCredential,
): Promise<boolean> {
	const base = authBase(options.authUrl);
	if (base === null) return false;
	const discovery = await readJson(
		options.http,
		getRequest(`${base}/.well-known/openid-configuration`),
		options.signal,
	);
	if (
		!discovery.ok ||
		discovery.value.status < 200 ||
		discovery.value.status >= 300
	)
		return false;
	const document = discovery.value.body;
	if (!isRecord(document) || document.issuer !== "https://auth.openai.com")
		return false;
	const endpoint = sameOriginEndpoint(
		document.revocation_endpoint,
		new URL(base).origin,
	);
	if (endpoint === null) return false;
	const token = credential.refresh_token || credential.access_token;
	const form = new URLSearchParams({
		token,
		token_type_hint: credential.refresh_token
			? "refresh_token"
			: "access_token",
		client_id: credential.client_id,
	});
	const bytes = encoder.encode(form.toString());
	const request: HttpRequest = {
		method: "POST",
		url: endpoint,
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: bytes,
		firstByteTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	};
	const response = await readJson(options.http, request, options.signal, true);
	return (
		response.ok && response.value.status >= 200 && response.value.status < 300
	);
}

function portFailure<Value = never>(
	error: PortError,
): ChatGptAuthResult<Value> {
	return { ok: false, error: { kind: "port", error } };
}

/** Revoke when possible, then remove the local credential even if it is unreadable. */
export async function logoutChatGpt(
	options: ChatGptLogoutOptions,
): Promise<ChatGptAuthResult<ChatGptLogoutOutcome>> {
	if (!isAccountLabel(options.label) || authBase(options.authUrl) === null)
		return portFailure({
			code: "invalid_input",
			message: "ChatGPT logout settings are invalid.",
			retryable: false,
		});
	const key = { ...CHATGPT_CREDENTIAL_KEY, account: options.label };
	let saved: Result<Uint8Array>;
	try {
		saved = await options.credentials.read(key);
	} catch (cause) {
		saved = {
			ok: false,
			error: {
				code: "io",
				message: "Saved ChatGPT credential could not be read.",
				retryable: true,
				cause,
			},
		};
	}
	const credential = saved.ok ? parseSavedChatGptCredential(saved.value) : null;
	const recoveredUnreadableCredential = !saved.ok
		? saved.error.code !== "not_found"
		: credential === null;
	const remoteRevocationConfirmed =
		credential === null ? false : await revokeCredential(options, credential);
	let removed: Result<void>;
	try {
		removed = await options.credentials.remove(key);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not remove the saved ChatGPT credential.",
			retryable: true,
			cause,
		});
	}
	if (!removed.ok && removed.error.code !== "not_found")
		return portFailure(removed.error);

	const profiles = await readProfilesFile(
		options.filesystem,
		options.homeDirectory,
	);
	if (!profiles.ok) return portFailure(profiles.error);
	const profile = profiles.value.chatgpt[options.label];
	if (profile !== undefined) {
		const updated = withAccountProfile(
			profiles.value,
			"chatgpt",
			options.label,
			{
				...profile,
				signed_in: false,
				remote_revoked: remoteRevocationConfirmed,
			},
		);
		const written = await writeProfilesFile(
			options.filesystem,
			options.homeDirectory,
			updated,
		);
		if (!written.ok) return portFailure(written.error);
	}
	return {
		ok: true,
		value: { remoteRevocationConfirmed, recoveredUnreadableCredential },
	};
}
