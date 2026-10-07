import { Buffer } from "node:buffer";
import { isAbsolute, join, resolve } from "node:path";
import type { ClockPort } from "../../../contracts/clock";
import type { PortError, Result } from "../../../contracts/errors";
import type {
	CredentialPort,
	FileSystemPort,
	HttpPort,
	HttpRequest,
	HttpResponse,
	RandomPort,
} from "../../../contracts/ports";
import { isAccountLabel } from "../../accounts/format";
import {
	readProfilesFile,
	withAccountProfile,
	writeProfilesFile,
} from "../../accounts/profiles";
import {
	GROK_AUTH_MAX_RESPONSE_BYTES,
	GROK_CREDENTIAL_KEY,
	GROK_HTTP_TIMEOUT_MILLISECONDS,
	GROK_MISSING_LOGIN_MESSAGE,
	GROK_REFRESH_LOGIN_MESSAGE,
	type GrokAuthResult,
	type GrokCredential,
	parseSavedGrokCredential,
} from "./login";

export const GROK_REFRESH_SKEW_SECONDS = 300;
export const GROK_REFRESH_LOCK_STALE_MILLISECONDS = 60_000;
export const GROK_REFRESH_LOCK_WAIT_MILLISECONDS = 90_000;
export const GROK_REFRESH_LOCK_POLL_MILLISECONDS = 25;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface GrokRefreshLockObservation {
	readonly ownerBytes: Uint8Array | null;
	readonly directoryModifiedAtUnixMilliseconds: number;
}

/** Anchored cross-process lock effects for `locks/grok-<label>.lock`. */
export interface GrokRefreshLockPort {
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
	): Promise<Result<GrokRefreshLockObservation>>;
	removeIfUnchanged(
		root: string,
		path: string,
		expected: GrokRefreshLockObservation,
	): Promise<Result<boolean>>;
	releaseIfOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<boolean>>;
}

export interface GrokRefreshOptions {
	readonly credentials: CredentialPort;
	readonly locks: GrokRefreshLockPort;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly http: HttpPort;
	readonly random: RandomPort;
	readonly clock: ClockPort;
	readonly homeDirectory: string;
	readonly label: string;
	/** KOGEN_TIME_SCALE applies to lock stale age and maximum lock wait. */
	readonly timeScale?: number;
	readonly signal?: AbortSignal;
}

export type GrokRefreshReason =
	| { readonly kind: "proactive" }
	| { readonly kind: "unauthorized"; readonly rejectedAccessToken: string };

export interface GrokRefreshOutcome {
	readonly credential: GrokCredential;
	readonly refreshed: boolean;
}

interface LockHandle {
	readonly root: string;
	readonly path: string;
	readonly ownerBytes: Uint8Array;
}

function providerLogin<Value = never>(message: string): GrokAuthResult<Value> {
	return { ok: false, error: { kind: "provider_login", message } };
}

function portFailure<Value = never>(error: PortError): GrokAuthResult<Value> {
	return { ok: false, error: { kind: "port", error } };
}

function safeText(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authRoot(homeDirectory: string): string | null {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) return null;
	return join(resolve(homeDirectory), ".kogen");
}

function unixMilliseconds(clock: ClockPort): GrokAuthResult<number> {
	let value: number;
	try {
		value = clock.unixMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the system clock for Grok refresh.",
			retryable: true,
			cause,
		});
	}
	return Number.isSafeInteger(value) && value >= 0
		? { ok: true, value }
		: portFailure({
				code: "invalid_input",
				message: "System clock returned an invalid Grok refresh time.",
				retryable: false,
			});
}

function monotonicMilliseconds(clock: ClockPort): GrokAuthResult<number> {
	let value: number;
	try {
		value = clock.monotonicMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the monotonic clock for Grok refresh.",
			retryable: true,
			cause,
		});
	}
	return Number.isFinite(value) && value >= 0
		? { ok: true, value }
		: portFailure({
				code: "invalid_input",
				message: "Monotonic clock returned an invalid Grok refresh time.",
				retryable: false,
			});
}

async function readCredential(
	options: GrokRefreshOptions,
): Promise<GrokAuthResult<GrokCredential>> {
	let result: Result<Uint8Array>;
	try {
		result = await options.credentials.read({
			...GROK_CREDENTIAL_KEY,
			account: options.label,
		});
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not read the saved Grok credential.",
			retryable: true,
			cause,
		});
	}
	if (!result.ok) {
		if (
			result.error.code === "not_found" ||
			result.error.code === "invalid_input"
		)
			return providerLogin(GROK_MISSING_LOGIN_MESSAGE);
		return portFailure(result.error);
	}
	return parseSavedGrokCredential(result.value);
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
	observation: GrokRefreshLockObservation,
	now: number,
	staleMilliseconds: number,
): boolean {
	const owner = observation.ownerBytes;
	if (owner === null || owner.byteLength === 0)
		return (
			now - observation.directoryModifiedAtUnixMilliseconds >= staleMilliseconds
		);
	const parsed = parseLockOwner(owner);
	return parsed === null
		? now - observation.directoryModifiedAtUnixMilliseconds >= staleMilliseconds
		: now - parsed.milliseconds >= staleMilliseconds;
}

async function newOwnerBytes(
	options: GrokRefreshOptions,
): Promise<GrokAuthResult<Uint8Array>> {
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const pid = process.pid;
	if (!Number.isSafeInteger(pid) || pid <= 0)
		return portFailure({
			code: "invalid_input",
			message: "Process ID is invalid for Grok refresh.",
			retryable: false,
		});
	let random: Result<Uint8Array>;
	try {
		random = await options.random.bytes(24);
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Secure random values are unavailable for Grok refresh.",
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
			`${pid} ${time.value} ${Buffer.from(random.value).toString("base64url")}`,
		),
	};
}

async function observeLock(
	options: GrokRefreshOptions,
	root: string,
	path: string,
): Promise<GrokAuthResult<GrokRefreshLockObservation | null>> {
	let result: Result<GrokRefreshLockObservation>;
	try {
		result = await options.locks.observe(root, path);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not inspect the Grok refresh lock.",
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
			message: "Grok refresh lock metadata is invalid.",
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

async function acquireRefreshLock(
	options: GrokRefreshOptions,
): Promise<GrokAuthResult<LockHandle>> {
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
			message: "Grok refresh settings are invalid.",
			retryable: false,
		});
	const path = `locks/grok-${options.label}.lock`;
	const staleMilliseconds = scaledMilliseconds(
		GROK_REFRESH_LOCK_STALE_MILLISECONDS,
		scale,
	);
	const waitMilliseconds = scaledMilliseconds(
		GROK_REFRESH_LOCK_WAIT_MILLISECONDS,
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
				message: "Grok refresh was cancelled.",
				retryable: false,
				cause: options.signal.reason,
			});
		let attempt: Result<"created" | "exists">;
		try {
			attempt = await options.locks.tryCreateDirectory(root, path);
		} catch (cause) {
			return portFailure({
				code: "io",
				message: "Could not acquire the Grok refresh lock.",
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
						message: "Could not publish the Grok refresh lock owner.",
						retryable: true,
						cause,
					},
				};
			}
			if (!written.ok) return portFailure(written.error);
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
		if (lockIsStale(observed.value, time.value, staleMilliseconds)) {
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
					message: "Could not clear the stale Grok refresh lock.",
					retryable: true,
					cause,
				});
			}
			if (!removed.ok) return portFailure(removed.error);
			if (removed.value) continue;
		}
		const monotonic = monotonicMilliseconds(options.clock);
		if (!monotonic.ok) return monotonic;
		if (monotonic.value < startedAt)
			return portFailure({
				code: "invalid_input",
				message: "Monotonic clock moved backwards during Grok refresh.",
				retryable: false,
			});
		const elapsed = monotonic.value - startedAt;
		if (elapsed >= waitMilliseconds)
			return portFailure({
				code: "timeout",
				message: "Timed out waiting for the Grok refresh lock.",
				retryable: true,
			});
		try {
			await options.clock.sleep(
				Math.min(
					GROK_REFRESH_LOCK_POLL_MILLISECONDS,
					waitMilliseconds - elapsed,
				),
				options.signal,
			);
		} catch (cause) {
			return portFailure({
				code: options.signal?.aborted ? "cancelled" : "unavailable",
				message: options.signal?.aborted
					? "Grok refresh was cancelled."
					: "Grok refresh lock wait failed.",
				retryable: !options.signal?.aborted,
				cause,
			});
		}
	}
}

async function releaseRefreshLock(
	options: GrokRefreshOptions,
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
				message: "Could not release the Grok refresh lock.",
				retryable: true,
				cause,
			},
		};
	}
}

async function oauthResponse(
	options: GrokRefreshOptions,
	request: HttpRequest,
): Promise<
	GrokAuthResult<{ readonly status: number; readonly body: unknown }>
> {
	let response: Result<HttpResponse>;
	try {
		response = await options.http.request(request, options.signal);
	} catch (cause) {
		return refreshHttpFailure(cause, options.signal);
	}
	if (!response.ok) return refreshHttpFailure(response.error, options.signal);
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of response.value.body) {
			length += chunk.byteLength;
			if (length > GROK_AUTH_MAX_RESPONSE_BYTES)
				return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
			chunks.push(chunk.slice());
		}
	} catch (cause) {
		return refreshHttpFailure(cause, options.signal);
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
		return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
	}
}

function refreshHttpFailure(
	error: unknown,
	signal: AbortSignal | undefined,
): GrokAuthResult<never> {
	if (signal?.aborted)
		return portFailure({
			code: "cancelled",
			message: "Grok refresh was cancelled.",
			retryable: false,
			cause: signal.reason,
		});
	if (isRecord(error) && error.code === "timeout")
		return providerLogin("Grok session refresh timed out.");
	return providerLogin(
		"Grok session could not refresh. Check the network and sign in again.",
	);
}

function refreshRequest(credential: GrokCredential): HttpRequest {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: credential.client_id,
		refresh_token: credential.refresh_token,
	});
	return {
		method: "POST",
		url: credential.token_endpoint,
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: encoder.encode(body.toString()),
		firstByteTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
	};
}

async function refreshUnderLock(
	options: GrokRefreshOptions,
	credential: GrokCredential,
): Promise<GrokAuthResult<GrokCredential>> {
	if (credential.refresh_token.length === 0)
		return providerLogin(GROK_MISSING_LOGIN_MESSAGE);
	const response = await oauthResponse(options, refreshRequest(credential));
	if (!response.ok) return response;
	if (response.value.status < 200 || response.value.status >= 300)
		return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
	const value = response.value.body;
	if (
		!isRecord(value) ||
		!safeText(value.access_token) ||
		!(value.refresh_token === undefined || safeText(value.refresh_token)) ||
		!Number.isSafeInteger(value.expires_in) ||
		(value.expires_in as number) <= 0 ||
		!(value.scope === undefined || safeText(value.scope)) ||
		!(
			value.email === undefined ||
			value.email === null ||
			safeText(value.email)
		)
	)
		return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const nowSeconds = Math.floor(time.value / 1000);
	const expiresAt = nowSeconds + (value.expires_in as number);
	if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
		return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
	const refreshed: GrokCredential = {
		...credential,
		access_token: value.access_token,
		refresh_token: safeText(value.refresh_token)
			? value.refresh_token
			: credential.refresh_token,
		expires_at: expiresAt,
		scopes:
			typeof value.scope === "string"
				? value.scope.split(/[\t\n\r ]+/u).filter(Boolean)
				: credential.scopes,
		email:
			value.email === undefined
				? credential.email
				: (value.email as string | null),
	};
	if (
		refreshed.scopes.length === 0 ||
		refreshed.scopes.some((scope) => !safeText(scope))
	)
		return providerLogin(GROK_REFRESH_LOGIN_MESSAGE);
	let written: Result<void>;
	try {
		written = await options.credentials.write(
			{ ...GROK_CREDENTIAL_KEY, account: options.label },
			encoder.encode(JSON.stringify(refreshed)),
		);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not save the refreshed Grok credential.",
			retryable: true,
			cause,
		});
	}
	if (!written.ok) return portFailure(written.error);
	const profiles = await readProfilesFile(
		options.filesystem,
		options.homeDirectory,
	);
	if (!profiles.ok) return portFailure(profiles.error);
	const updatedProfiles = withAccountProfile(
		profiles.value,
		"grok",
		options.label,
		{
			email: refreshed.email,
			expires_at: refreshed.expires_at,
			signed_in: true,
		},
	);
	const profileWrite = await writeProfilesFile(
		options.filesystem,
		options.homeDirectory,
		updatedProfiles,
	);
	if (!profileWrite.ok) return portFailure(profileWrite.error);
	return { ok: true, value: refreshed };
}

/** Stale credentials refresh under a compare-and-remove owner lock. */
export async function refreshGrokCredential(
	options: GrokRefreshOptions,
	reason: GrokRefreshReason = { kind: "proactive" },
): Promise<GrokAuthResult<GrokRefreshOutcome>> {
	if (
		!isAccountLabel(options.label) ||
		authRoot(options.homeDirectory) === null ||
		(reason.kind === "unauthorized" && !safeText(reason.rejectedAccessToken))
	)
		return portFailure({
			code: "invalid_input",
			message: "Grok refresh settings are invalid.",
			retryable: false,
		});
	if (options.signal?.aborted)
		return portFailure({
			code: "cancelled",
			message: "Grok refresh was cancelled.",
			retryable: false,
			cause: options.signal.reason,
		});
	const initial = await readCredential(options);
	if (!initial.ok) return initial;
	const time = unixMilliseconds(options.clock);
	if (!time.ok) return time;
	const currentSeconds = Math.floor(time.value / 1000);
	const shouldRefresh = (credential: GrokCredential, now: number) =>
		reason.kind === "unauthorized"
			? credential.access_token === reason.rejectedAccessToken
			: credential.expires_at <= now + GROK_REFRESH_SKEW_SECONDS;
	if (!shouldRefresh(initial.value, currentSeconds))
		return {
			ok: true,
			value: { credential: initial.value, refreshed: false },
		};
	const acquired = await acquireRefreshLock(options);
	if (!acquired.ok) return acquired;
	const handle = acquired.value;
	let outcome: GrokAuthResult<GrokRefreshOutcome>;
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
						message: "System clock returned an invalid Grok refresh time.",
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
			message: "Grok credential refresh failed.",
			retryable: true,
			cause,
		});
	}
	const released = await releaseRefreshLock(options, handle);
	if (!released.ok && outcome.ok) return portFailure(released.error);
	return outcome;
}
