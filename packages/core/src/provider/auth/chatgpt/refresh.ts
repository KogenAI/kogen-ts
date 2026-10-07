import { Buffer } from "node:buffer";
import { isAbsolute, join, resolve } from "node:path";
import type { ClockPort } from "../../../contracts/clock";
import type { PortError, Result } from "../../../contracts/errors";
import type {
	CredentialPort,
	HttpPort,
	HttpRequest,
	HttpResponse,
	RandomPort,
} from "../../../contracts/ports";
import { isAccountLabel } from "../../accounts/format";
import {
	CHATGPT_AUTH_BASE_URL,
	CHATGPT_CREDENTIAL_KEY,
	CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	type ChatGptCredential,
} from "./login";

export const CHATGPT_REFRESH_SKEW_SECONDS = 300;
export const CHATGPT_REFRESH_LOCK_STALE_MILLISECONDS = 60_000;
export const CHATGPT_REFRESH_LOCK_WAIT_MILLISECONDS = 90_000;
export const CHATGPT_REFRESH_LOCK_POLL_MILLISECONDS = 25;
export const CHATGPT_AUTH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const CHATGPT_PROVIDER_LOGIN_MESSAGE =
	"ChatGPT rejected the login; sign in again.";
export const CHATGPT_MISSING_LOGIN_MESSAGE =
	"ChatGPT login is missing or invalid; run `kogen provider login chatgpt`.";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ChatGptAuthError =
	| { readonly kind: "provider_login"; readonly message: string }
	| { readonly kind: "port"; readonly error: PortError };
export type ChatGptAuthResult<Value> = Result<Value, ChatGptAuthError>;

export interface ChatGptRefreshLockObservation {
	/** null means the owner file has not been published yet. */
	readonly ownerBytes: Uint8Array | null;
	readonly directoryModifiedAtUnixMilliseconds: number;
}

/** Atomic, anchored filesystem effects used by the cross-process lock policy. */
export interface ChatGptRefreshLockPort {
	tryCreateDirectory(
		root: string,
		path: string,
	): Promise<Result<"created" | "exists">>;
	writeOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<void>>;
	observe(
		root: string,
		path: string,
	): Promise<Result<ChatGptRefreshLockObservation>>;
	/** Remove only if owner bytes and directory mtime still match. */
	removeIfUnchanged(
		root: string,
		path: string,
		expected: ChatGptRefreshLockObservation,
	): Promise<Result<boolean>>;
	/** Remove only the lock currently owned by these exact bytes. */
	releaseIfOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<boolean>>;
}

export interface ChatGptRefreshOptions {
	readonly credentials: CredentialPort;
	readonly locks: ChatGptRefreshLockPort;
	readonly http: HttpPort;
	readonly random: RandomPort;
	readonly clock: ClockPort;
	readonly homeDirectory: string;
	readonly label: string;
	readonly authUrl?: string;
	/** KOGEN_TIME_SCALE applies to lock staleness and waiting in tests. */
	readonly timeScale?: number;
	readonly signal?: AbortSignal;
}

export type ChatGptRefreshReason =
	| { readonly kind: "proactive" }
	| { readonly kind: "unauthorized"; readonly rejectedAccessToken: string };

export interface ChatGptRefreshOutcome {
	readonly credential: ChatGptCredential;
	readonly refreshed: boolean;
}

export type ChatGptRequestAuth =
	| {
			readonly source: "owned";
			readonly credential: ChatGptCredential;
	  }
	| {
			readonly source: "injected";
			readonly accessToken: string;
			readonly accountId: string;
	  };

export type ChatGptAuthenticatedRequestOptions =
	| {
			readonly http: HttpPort;
			readonly request: HttpRequest;
			readonly auth: Extract<ChatGptRequestAuth, { readonly source: "owned" }>;
			readonly refresh: ChatGptRefreshOptions;
			readonly version?: string;
			readonly signal?: AbortSignal;
	  }
	| {
			readonly http: HttpPort;
			readonly request: HttpRequest;
			readonly auth: Extract<
				ChatGptRequestAuth,
				{ readonly source: "injected" }
			>;
			readonly version?: string;
			readonly signal?: AbortSignal;
	  };

interface LockHandle {
	readonly root: string;
	readonly path: string;
	readonly ownerBytes: Uint8Array;
}

function providerLogin(
	message = CHATGPT_MISSING_LOGIN_MESSAGE,
): ChatGptAuthError {
	return { kind: "provider_login", message };
}

function portFailure<Value = never>(
	error: PortError,
): ChatGptAuthResult<Value> {
	return { ok: false, error: { kind: "port", error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value)
	);
}

function parseCredential(
	bytes: Uint8Array,
): ChatGptAuthResult<ChatGptCredential> {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes)) as unknown;
	} catch {
		return { ok: false, error: providerLogin() };
	}
	if (!isRecord(value)) return { ok: false, error: providerLogin() };
	const scopes = value.scopes;
	if (
		!safeText(value.client_id) ||
		!safeText(value.access_token) ||
		typeof value.refresh_token !== "string" ||
		!safeText(value.id_token) ||
		!Number.isSafeInteger(value.expires_at) ||
		(value.expires_at as number) < 0 ||
		!Array.isArray(scopes) ||
		!scopes.every((scope: unknown) => typeof scope === "string") ||
		!safeText(value.subject) ||
		!(value.email === null || safeText(value.email)) ||
		!safeText(value.host_id)
	)
		return { ok: false, error: providerLogin() };
	return {
		ok: true,
		value: {
			client_id: value.client_id,
			access_token: value.access_token,
			refresh_token: value.refresh_token,
			id_token: value.id_token,
			expires_at: value.expires_at as number,
			scopes: scopes as string[],
			subject: value.subject,
			email: value.email as string | null,
			host_id: value.host_id,
		},
	};
}

/** Parse saved bytes for local recovery paths such as logout. */
export function parseSavedChatGptCredential(
	bytes: Uint8Array,
): ChatGptCredential | null {
	const result = parseCredential(bytes);
	return result.ok ? result.value : null;
}

async function readCredential(
	options: ChatGptRefreshOptions,
): Promise<ChatGptAuthResult<ChatGptCredential>> {
	let result: Result<Uint8Array>;
	try {
		result = await options.credentials.read({
			...CHATGPT_CREDENTIAL_KEY,
			account: options.label,
		});
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not read the saved ChatGPT credential.",
			retryable: true,
			cause,
		});
	}
	if (!result.ok) {
		if (
			result.error.code === "not_found" ||
			result.error.code === "invalid_input"
		)
			return { ok: false, error: providerLogin() };
		return portFailure(result.error);
	}
	return parseCredential(result.value);
}

function authRoot(homeDirectory: string): string | null {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) return null;
	return join(resolve(homeDirectory), ".kogen");
}

function normalizedAuthBase(value: string | undefined): string | null {
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

async function responseJson(
	http: HttpPort,
	request: HttpRequest,
	signal?: AbortSignal,
): Promise<
	ChatGptAuthResult<{ readonly status: number; readonly body: unknown }>
> {
	let response: Result<HttpResponse>;
	try {
		response = await http.request(request, signal);
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "ChatGPT authentication request failed.",
			retryable: true,
			cause,
		});
	}
	if (!response.ok) return portFailure(response.error);
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of response.value.body) {
			length += chunk.byteLength;
			if (length > CHATGPT_AUTH_MAX_RESPONSE_BYTES)
				return { ok: false, error: providerLogin() };
			chunks.push(chunk.slice());
		}
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "ChatGPT authentication response could not be read.",
			retryable: true,
			cause,
		});
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
		return { ok: false, error: providerLogin() };
	}
}

function authRequest(
	method: string,
	url: string,
	body?: Uint8Array,
): HttpRequest {
	return {
		method,
		url,
		headers:
			body === undefined
				? { accept: "application/json" }
				: {
						accept: "application/json",
						"content-type": "application/x-www-form-urlencoded",
					},
		...(body === undefined ? {} : { body: body.slice() }),
		firstByteTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	};
}

async function discoverTokenEndpoint(
	options: ChatGptRefreshOptions,
): Promise<ChatGptAuthResult<string>> {
	const authBase = normalizedAuthBase(options.authUrl);
	if (authBase === null)
		return portFailure({
			code: "invalid_input",
			message: "ChatGPT auth URL is invalid.",
			retryable: false,
		});
	const response = await responseJson(
		options.http,
		authRequest("GET", `${authBase}/.well-known/openid-configuration`),
		options.signal,
	);
	if (!response.ok) return response;
	if (response.value.status < 200 || response.value.status >= 300)
		return {
			ok: false,
			error: providerLogin("ChatGPT sign-in is unavailable; sign in again."),
		};
	const document = response.value.body;
	if (!isRecord(document) || document.issuer !== "https://auth.openai.com")
		return {
			ok: false,
			error: providerLogin("ChatGPT sign-in returned invalid discovery data."),
		};
	const endpoint = sameOriginEndpoint(
		document.token_endpoint,
		new URL(authBase).origin,
	);
	if (endpoint === null)
		return {
			ok: false,
			error: providerLogin("ChatGPT sign-in returned invalid discovery data."),
		};
	return { ok: true, value: endpoint };
}

function parseLockOwner(bytes: Uint8Array): {
	readonly pid: number;
	readonly milliseconds: number;
	readonly token: string;
} | null {
	try {
		const parts = decoder.decode(bytes).split(" ");
		if (
			parts.length !== 3 ||
			!/^[1-9][0-9]*$/u.test(parts[0] ?? "") ||
			!/^(0|[1-9][0-9]*)$/u.test(parts[1] ?? "") ||
			!/^[A-Za-z0-9_-]{16,128}$/u.test(parts[2] ?? "")
		)
			return null;
		const pid = Number(parts[0]);
		const milliseconds = Number(parts[1]);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(milliseconds))
			return null;
		return { pid, milliseconds, token: parts[2] as string };
	} catch {
		return null;
	}
}

function lockIsStale(
	observation: ChatGptRefreshLockObservation,
	now: number,
	staleMilliseconds: number,
): boolean {
	const owner = observation.ownerBytes;
	if (owner === null || owner.byteLength === 0)
		return (
			now - observation.directoryModifiedAtUnixMilliseconds >= staleMilliseconds
		);
	const parsed = parseLockOwner(owner);
	if (parsed === null)
		return (
			now - observation.directoryModifiedAtUnixMilliseconds >= staleMilliseconds
		);
	return now - parsed.milliseconds >= staleMilliseconds;
}

async function newOwnerBytes(
	options: ChatGptRefreshOptions,
): Promise<ChatGptAuthResult<Uint8Array>> {
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const milliseconds = time.value;
	const pid = process.pid;
	if (
		!Number.isSafeInteger(milliseconds) ||
		milliseconds < 0 ||
		!Number.isSafeInteger(pid) ||
		pid <= 0
	)
		return portFailure({
			code: "invalid_input",
			message: "Current time or process ID is invalid for ChatGPT refresh.",
			retryable: false,
		});
	let random: Result<Uint8Array>;
	try {
		random = await options.random.bytes(24);
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Secure random values are unavailable for ChatGPT refresh.",
			retryable: true,
			cause,
		});
	}
	if (!random.ok) return portFailure(random.error);
	if (!(random.value instanceof Uint8Array) || random.value.byteLength !== 24)
		return portFailure({
			code: "invalid_input",
			message: "Secure random source returned an invalid byte count.",
			retryable: false,
		});
	return {
		ok: true,
		value: encoder.encode(
			`${pid} ${milliseconds} ${Buffer.from(random.value).toString("base64url")}`,
		),
	};
}

async function observeLock(
	options: ChatGptRefreshOptions,
	root: string,
	path: string,
): Promise<ChatGptAuthResult<ChatGptRefreshLockObservation | null>> {
	let result: Result<ChatGptRefreshLockObservation>;
	try {
		result = await options.locks.observe(root, path);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not inspect the ChatGPT refresh lock.",
			retryable: true,
			cause,
		});
	}
	if (!result.ok) {
		if (result.error.code === "not_found") return { ok: true, value: null };
		return portFailure(result.error);
	}
	if (
		!Number.isSafeInteger(result.value.directoryModifiedAtUnixMilliseconds) ||
		result.value.directoryModifiedAtUnixMilliseconds < 0
	)
		return portFailure({
			code: "invalid_input",
			message: "ChatGPT refresh lock metadata is invalid.",
			retryable: false,
		});
	return {
		ok: true,
		value: {
			ownerBytes: result.value.ownerBytes?.slice() ?? null,
			directoryModifiedAtUnixMilliseconds:
				result.value.directoryModifiedAtUnixMilliseconds,
		},
	};
}

function scaledMilliseconds(value: number, scale: number): number {
	return Math.max(1, Math.floor(value * scale));
}

function unixMilliseconds(clock: ClockPort): ChatGptAuthResult<number> {
	let value: number;
	try {
		value = clock.unixMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the system clock for ChatGPT refresh.",
			retryable: true,
			cause,
		});
	}
	return Number.isSafeInteger(value) && value >= 0
		? { ok: true, value }
		: portFailure({
				code: "invalid_input",
				message: "System clock returned an invalid ChatGPT refresh time.",
				retryable: false,
			});
}

function monotonicMilliseconds(clock: ClockPort): ChatGptAuthResult<number> {
	let value: number;
	try {
		value = clock.monotonicMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the monotonic clock for ChatGPT refresh.",
			retryable: true,
			cause,
		});
	}
	return Number.isFinite(value) && value >= 0
		? { ok: true, value }
		: portFailure({
				code: "invalid_input",
				message: "Monotonic clock returned an invalid ChatGPT refresh time.",
				retryable: false,
			});
}

async function acquireRefreshLock(
	options: ChatGptRefreshOptions,
): Promise<ChatGptAuthResult<LockHandle>> {
	const root = authRoot(options.homeDirectory);
	const scale = options.timeScale ?? 1;
	if (
		root === null ||
		!isAccountLabel(options.label) ||
		!Number.isFinite(scale) ||
		scale <= 0 ||
		scale > 100
	)
		return portFailure({
			code: "invalid_input",
			message: "ChatGPT refresh settings are invalid.",
			retryable: false,
		});
	const path = `locks/chatgpt-${options.label}.lock`;
	const staleMs = scaledMilliseconds(
		CHATGPT_REFRESH_LOCK_STALE_MILLISECONDS,
		scale,
	);
	const waitMs = scaledMilliseconds(
		CHATGPT_REFRESH_LOCK_WAIT_MILLISECONDS,
		scale,
	);
	const owner = await newOwnerBytes(options);
	if (!owner.ok) return owner;
	const ownerBytes = owner.value;
	const started = monotonicMilliseconds(options.clock);
	if (!started.ok) return started;
	const startedAt = started.value;
	while (true) {
		if (options.signal?.aborted)
			return portFailure({
				code: "cancelled",
				message: "ChatGPT refresh was cancelled.",
				retryable: false,
				cause: options.signal.reason,
			});
		let attempt: Result<"created" | "exists">;
		try {
			attempt = await options.locks.tryCreateDirectory(root, path);
		} catch (cause) {
			return portFailure({
				code: "io",
				message: "Could not acquire the ChatGPT refresh lock.",
				retryable: true,
				cause,
			});
		}
		if (!attempt.ok) return portFailure(attempt.error);
		if (attempt.value === "created") {
			let written: Result<void>;
			try {
				written = await options.locks.writeOwner(
					root,
					path,
					ownerBytes.slice(),
				);
			} catch (cause) {
				written = {
					ok: false,
					error: {
						code: "io",
						message: "Could not publish the ChatGPT refresh lock owner.",
						retryable: true,
						cause,
					},
				};
			}
			if (!written.ok) {
				// Leave an empty directory to age out by mtime; an observation here
				// could see another process's owner and must not be used to remove it.
				return portFailure(written.error);
			}
			return {
				ok: true,
				value: { root, path, ownerBytes: ownerBytes.slice() },
			};
		}
		const observed = await observeLock(options, root, path);
		if (!observed.ok) return observed;
		if (observed.value === null) continue;
		const time = unixMilliseconds(options.clock);
		if (!time.ok) return time;
		const now = time.value;
		if (lockIsStale(observed.value, now, staleMs)) {
			let removed: Result<boolean>;
			try {
				removed = await options.locks.removeIfUnchanged(
					root,
					path,
					observed.value,
				);
			} catch (cause) {
				return portFailure({
					code: "io",
					message: "Could not clear the stale ChatGPT refresh lock.",
					retryable: true,
					cause,
				});
			}
			if (!removed.ok) return portFailure(removed.error);
			if (removed.value) continue;
		}
		const monotonic = monotonicMilliseconds(options.clock);
		if (!monotonic.ok) return monotonic;
		const nowMonotonic = monotonic.value;
		if (nowMonotonic < startedAt)
			return portFailure({
				code: "invalid_input",
				message: "Monotonic clock returned an invalid ChatGPT refresh time.",
				retryable: false,
			});
		const elapsed = nowMonotonic - startedAt;
		if (elapsed >= waitMs)
			return portFailure({
				code: "timeout",
				message: "Timed out waiting for the ChatGPT refresh lock.",
				retryable: true,
			});
		try {
			await options.clock.sleep(
				Math.min(CHATGPT_REFRESH_LOCK_POLL_MILLISECONDS, waitMs - elapsed),
				options.signal,
			);
		} catch (cause) {
			return portFailure({
				code: options.signal?.aborted ? "cancelled" : "unavailable",
				message: options.signal?.aborted
					? "ChatGPT refresh was cancelled."
					: "ChatGPT refresh lock wait failed.",
				retryable: !options.signal?.aborted,
				cause,
			});
		}
	}
}

async function releaseRefreshLock(
	options: ChatGptRefreshOptions,
	handle: LockHandle,
): Promise<Result<boolean>> {
	try {
		return await options.locks.releaseIfOwner(
			handle.root,
			handle.path,
			handle.ownerBytes.slice(),
		);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "io",
				message: "Could not release the ChatGPT refresh lock.",
				retryable: true,
				cause,
			},
		};
	}
}

async function refreshUnderLock(
	options: ChatGptRefreshOptions,
	credential: ChatGptCredential,
): Promise<ChatGptAuthResult<ChatGptCredential>> {
	if (credential.refresh_token.length === 0)
		return { ok: false, error: providerLogin() };
	const endpoint = await discoverTokenEndpoint(options);
	if (!endpoint.ok) return endpoint;
	const form = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: credential.client_id,
		refresh_token: credential.refresh_token,
	});
	const response = await responseJson(
		options.http,
		authRequest("POST", endpoint.value, encoder.encode(form.toString())),
		options.signal,
	);
	if (!response.ok) return response;
	if (response.value.status < 200 || response.value.status >= 300)
		return { ok: false, error: providerLogin() };
	const value = response.value.body;
	if (
		!isRecord(value) ||
		!safeText(value.access_token) ||
		!(value.refresh_token === undefined || safeText(value.refresh_token)) ||
		!(value.id_token === undefined || safeText(value.id_token)) ||
		!Number.isSafeInteger(value.expires_in) ||
		(value.expires_in as number) <= 0 ||
		!(value.scope === undefined || safeText(value.scope))
	)
		return { ok: false, error: providerLogin() };
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const nowMilliseconds = time.value;
	const expiresAt =
		Math.floor(nowMilliseconds / 1000) + (value.expires_in as number);
	if (!Number.isSafeInteger(expiresAt))
		return { ok: false, error: providerLogin() };
	const refreshed: ChatGptCredential = {
		...credential,
		access_token: value.access_token,
		refresh_token: safeText(value.refresh_token)
			? value.refresh_token
			: credential.refresh_token,
		id_token: safeText(value.id_token) ? value.id_token : credential.id_token,
		expires_at: expiresAt,
		scopes:
			typeof value.scope === "string"
				? value.scope.split(/[\t\n\r ]+/u).filter(Boolean)
				: credential.scopes,
	};
	let written: Result<void>;
	try {
		written = await options.credentials.write(
			{ ...CHATGPT_CREDENTIAL_KEY, account: options.label },
			encoder.encode(JSON.stringify(refreshed)),
		);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not save the refreshed ChatGPT credential.",
			retryable: true,
			cause,
		});
	}
	if (!written.ok) return portFailure(written.error);
	return { ok: true, value: refreshed };
}

/** Reread under the owner lock; only its owner may rotate a saved token. */
export async function refreshChatGptCredential(
	options: ChatGptRefreshOptions,
	reason: ChatGptRefreshReason = { kind: "proactive" },
): Promise<ChatGptAuthResult<ChatGptRefreshOutcome>> {
	if (
		!isAccountLabel(options.label) ||
		authRoot(options.homeDirectory) === null ||
		(reason.kind === "unauthorized" && !safeText(reason.rejectedAccessToken))
	)
		return portFailure({
			code: "invalid_input",
			message: "ChatGPT refresh settings are invalid.",
			retryable: false,
		});
	if (options.signal?.aborted)
		return portFailure({
			code: "cancelled",
			message: "ChatGPT refresh was cancelled.",
			retryable: false,
			cause: options.signal.reason,
		});
	const initial = await readCredential(options);
	if (!initial.ok) return initial;
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const currentSeconds = Math.floor(time.value / 1000);
	if (!Number.isSafeInteger(currentSeconds) || currentSeconds < 0)
		return portFailure({
			code: "invalid_input",
			message: "System clock returned an invalid ChatGPT refresh time.",
			retryable: false,
		});
	const shouldRefresh = (credential: ChatGptCredential, nowSeconds: number) =>
		reason.kind === "unauthorized"
			? credential.access_token === reason.rejectedAccessToken
			: credential.expires_at <= nowSeconds + CHATGPT_REFRESH_SKEW_SECONDS;
	if (!shouldRefresh(initial.value, currentSeconds))
		return {
			ok: true,
			value: { credential: initial.value, refreshed: false },
		};
	const acquired = await acquireRefreshLock(options);
	if (!acquired.ok) return acquired;
	const handle = acquired.value;
	let outcome: ChatGptAuthResult<ChatGptRefreshOutcome>;
	try {
		const reread = await readCredential(options);
		if (!reread.ok) outcome = reread;
		else {
			const rereadTime = unixMilliseconds(options.clock);
			if (!rereadTime.ok) outcome = rereadTime;
			else {
				const nowSeconds = Math.floor(rereadTime.value / 1000);
				if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
					outcome = portFailure({
						code: "invalid_input",
						message: "System clock returned an invalid ChatGPT refresh time.",
						retryable: false,
					});
				else if (!shouldRefresh(reread.value, nowSeconds))
					outcome = {
						ok: true,
						value: { credential: reread.value, refreshed: false },
					};
				else {
					const refreshed = await refreshUnderLock(options, reread.value);
					outcome = refreshed.ok
						? {
								ok: true,
								value: { credential: refreshed.value, refreshed: true },
							}
						: refreshed;
				}
			}
		}
	} catch (cause) {
		outcome = portFailure({
			code: "unavailable",
			message: "ChatGPT credential refresh failed.",
			retryable: true,
			cause,
		});
	}
	const released = await releaseRefreshLock(options, handle);
	if (!released.ok && outcome.ok) return portFailure(released.error);
	return outcome;
}

/** Auth-only headers; the session encoder adds its sticky routing headers. */
export function chatGptAuthHeaders(
	auth: ChatGptRequestAuth,
	version = "0.1",
): Readonly<Record<string, string>> {
	if (!safeText(version) || /\s/u.test(version))
		throw new TypeError("Kogen version must be nonempty single-line text.");
	if (auth.source === "owned") {
		if (!safeText(auth.credential.access_token))
			throw new TypeError("Saved ChatGPT access token is invalid.");
		return Object.freeze({
			authorization: `Bearer ${auth.credential.access_token}`,
			"user-agent": "kogen/0.1",
		});
	}
	if (!safeText(auth.accessToken) || !safeText(auth.accountId))
		throw new TypeError("Injected ChatGPT identity is invalid.");
	return Object.freeze({
		authorization: `Bearer ${auth.accessToken}`,
		"chatgpt-account-id": auth.accountId,
		"openai-beta": "responses=experimental",
		originator: "kogen",
		"user-agent": `kogen/${version}`,
	});
}

function withHeaders(
	request: HttpRequest,
	auth: ChatGptRequestAuth,
	version: string | undefined,
): HttpRequest {
	return {
		...request,
		headers: { ...request.headers, ...chatGptAuthHeaders(auth, version) },
		...(request.body === undefined ? {} : { body: request.body.slice() }),
	};
}

async function discardBody(
	response: HttpResponse,
): Promise<ChatGptAuthResult<void>> {
	try {
		for await (const _chunk of response.body) {
			// Drain auth errors so streaming transports release their resources.
		}
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "ChatGPT authentication response could not be read.",
			retryable: true,
			cause,
		});
	}
	return { ok: true, value: undefined };
}

async function send(
	http: HttpPort,
	request: HttpRequest,
	signal?: AbortSignal,
): Promise<ChatGptAuthResult<HttpResponse>> {
	let result: Result<HttpResponse>;
	try {
		result = await http.request(request, signal);
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "ChatGPT request failed.",
			retryable: true,
			cause,
		});
	}
	return result.ok ? result : portFailure(result.error);
}

function combineSignals(
	first: AbortSignal | undefined,
	second: AbortSignal | undefined,
): AbortSignal | undefined {
	if (first === undefined) return second;
	if (second === undefined || first === second) return first;
	return AbortSignal.any([first, second]);
}

/** Owned 401s refresh once and replay identical request bytes; injected auth never refreshes. */
export async function sendChatGptAuthenticatedRequest(
	options: ChatGptAuthenticatedRequestOptions,
): Promise<ChatGptAuthResult<HttpResponse>> {
	let auth: ChatGptRequestAuth = options.auth;
	const ownedRefresh = "refresh" in options ? options.refresh : null;
	const signal = combineSignals(ownedRefresh?.signal, options.signal);
	const refreshOptions =
		ownedRefresh === null
			? null
			: { ...ownedRefresh, ...(signal === undefined ? {} : { signal }) };
	if (refreshOptions !== null) {
		const ensured = await refreshChatGptCredential(refreshOptions);
		if (!ensured.ok) return ensured;
		auth = { source: "owned", credential: ensured.value.credential };
	}
	const first = await send(
		options.http,
		withHeaders(options.request, auth, options.version),
		signal,
	);
	if (!first.ok) return first;
	if (first.value.status === 403) {
		const drained = await discardBody(first.value);
		return drained.ok
			? { ok: false, error: providerLogin(CHATGPT_PROVIDER_LOGIN_MESSAGE) }
			: drained;
	}
	if (first.value.status !== 401) return first;
	const drained = await discardBody(first.value);
	if (!drained.ok) return drained;
	if (auth.source === "injected")
		return {
			ok: false,
			error: providerLogin("Codex login is missing, invalid, or expired."),
		};
	if (refreshOptions === null)
		return {
			ok: false,
			error: providerLogin(CHATGPT_PROVIDER_LOGIN_MESSAGE),
		};
	const forced = await refreshChatGptCredential(refreshOptions, {
		kind: "unauthorized",
		rejectedAccessToken: auth.credential.access_token,
	});
	if (!forced.ok) return forced;
	const replay = await send(
		options.http,
		withHeaders(
			options.request,
			{ source: "owned", credential: forced.value.credential },
			options.version,
		),
		signal,
	);
	if (!replay.ok) return replay;
	if (replay.value.status === 401 || replay.value.status === 403) {
		const replayDrained = await discardBody(replay.value);
		return replayDrained.ok
			? { ok: false, error: providerLogin(CHATGPT_PROVIDER_LOGIN_MESSAGE) }
			: replayDrained;
	}
	return replay;
}
