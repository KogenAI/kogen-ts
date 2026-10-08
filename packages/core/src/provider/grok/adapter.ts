import type { ClockPort } from "../../contracts/clock";
import type { PortError } from "../../contracts/errors";
import type {
	CredentialPort,
	FileSystemPort,
	HttpPort,
	HttpRequest,
	RandomPort,
} from "../../contracts/ports";
import {
	GROK_REFRESH_LOGIN_MESSAGE,
	type GrokAuthError,
	type GrokCredential,
} from "../auth/grok/login";
import {
	type GrokRefreshLockPort,
	type GrokRefreshReason,
	refreshGrokCredential,
} from "../auth/grok/refresh";
import { createHttpDeadline, HttpDeadlineError } from "../http/deadline";
import {
	HttpTransport,
	MAX_HTTP_ERROR_BODY_BYTES,
	resolveProviderEndpoint,
} from "../http/transport";
import type {
	ProviderAttemptFailure,
	ProviderAttemptResult,
	SendProviderAttempt,
} from "../retry/respond";
import type { SessionState } from "../session/transition";
import type { EncodedSessionRequest } from "../session/wire";
import { assembleResponses } from "../sse/assemble";
import { SseFramer, SseFramingError } from "../sse/framing";

export const GROK_RESPONSES_ENDPOINT =
	"https://cli-chat-proxy.grok.com/v1/responses";
export const GROK_REQUEST_FIRST_BYTE_TIMEOUT_MILLISECONDS = 120_000;
export const GROK_REQUEST_IDLE_TIMEOUT_MILLISECONDS = 90_000;
export const GROK_REQUEST_TOTAL_TIMEOUT_MILLISECONDS = 1_200_000;

const decoder = new TextDecoder("utf-8");

export interface GrokAttemptSenderOptions {
	readonly version: string;
	readonly label: string;
	readonly homeDirectory: string;
	readonly http: HttpPort;
	readonly credentials: CredentialPort;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly locks: GrokRefreshLockPort;
	readonly random: RandomPort;
	readonly clock: ClockPort;
	readonly timeScale?: number;
	readonly signal?: AbortSignal;
	/** The existing KOGEN_PROVIDER_URL test seam. Production leaves this unset. */
	readonly testEndpointOverride?: string;
}

type HttpAttemptResult =
	| { readonly kind: "response"; readonly response: ProviderAttemptResult }
	| { readonly kind: "unauthorized" }
	| { readonly kind: "failure"; readonly error: ProviderAttemptFailure };

function failure(
	className: ProviderAttemptFailure["class"],
	message: string,
	additional: Partial<ProviderAttemptFailure> = {},
): ProviderAttemptResult {
	return { ok: false, error: { class: className, message, ...additional } };
}

function validVersion(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		!/\r|\n|\0/u.test(value)
	);
}

function formatUuidV4(bytes: Uint8Array): string {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16)
		throw new TypeError(
			"Secure random source must return 16 bytes for a Grok request UUID.",
		);
	const value = bytes.slice();
	value[6] = ((value[6] ?? 0) & 0x0f) | 0x40;
	value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function newRequestUuid(random: RandomPort): Promise<string> {
	const result = await random.bytes(16);
	if (!result.ok)
		throw new Error(
			"Secure random values are unavailable for a Grok request UUID.",
			{
				cause: result.error,
			},
		);
	return formatUuidV4(result.value);
}

function withGrokHeaders(
	request: EncodedSessionRequest,
	session: SessionState,
	credential: GrokCredential,
	version: string,
	requestUuid: string,
): Readonly<Record<string, string>> {
	const headers: Record<string, string> = { ...request.headers };
	Object.assign(headers, {
		authorization: `Bearer ${credential.access_token}`,
		"x-xai-token-auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
		"x-grok-model-override": session.model,
		"x-grok-client-identifier": "kogen",
		"x-grok-client-mode": "headless",
		"x-grok-client-version": version,
		"user-agent": `kogen/${version}`,
		"x-grok-req-id": requestUuid,
	});
	return Object.freeze(headers);
}

function mapPortFailure(error: PortError): ProviderAttemptFailure {
	const cause = error.cause;
	if (cause instanceof HttpDeadlineError) {
		if (cause.kind === "idle_stall")
			return {
				class: "stall",
				message: "Provider stream sent nothing for 90 s after it started.",
			};
		if (cause.kind === "cancelled")
			return { class: "transport", message: "Grok request could not connect." };
		return { class: "timeout", message: "Grok request timed out." };
	}
	if (error.code === "timeout")
		return { class: "timeout", message: "Grok request timed out." };
	if (error.code === "cancelled")
		return { class: "transport", message: "Grok request could not connect." };
	return { class: "transport", message: "Grok request could not connect." };
}

function mapGrokAuthFailure(error: GrokAuthError): ProviderAttemptFailure {
	if (error.kind === "provider_login")
		return { class: "login", message: error.message };
	const cause = error.error.cause;
	if (
		error.error.code === "timeout" ||
		(cause instanceof HttpDeadlineError &&
			cause.kind !== "cancelled" &&
			cause.kind !== "idle_stall")
	)
		return { class: "login", message: "Grok session refresh timed out." };
	if (error.error.code === "cancelled")
		return {
			class: "login",
			message: "Grok login is unavailable; run `kogen provider login grok`.",
		};
	if (error.error.code === "unavailable" || cause instanceof HttpDeadlineError)
		return {
			class: "login",
			message:
				"Grok session could not refresh. Check the network and sign in again.",
		};
	return { class: "login", message: GROK_REFRESH_LOGIN_MESSAGE };
}

function matchesAny(body: string, needles: readonly string[]): boolean {
	const normalized = body.toLowerCase();
	return needles.some((needle) => normalized.includes(needle));
}

/** Apply the exact §4.10 request-side status/body sentence table. */
export function mapGrokHttpFailure(
	status: number,
	body: string,
): ProviderAttemptFailure {
	if (status === 401)
		return {
			class: "login",
			message: "Grok rejected this session; run `kogen provider login grok`.",
		};
	if (status === 403)
		return {
			class: "login",
			message: "This Grok account cannot access the requested model.",
		};
	if (
		status === 429 ||
		matchesAny(body, [
			"usage_limit",
			"usage limit",
			"quota exceeded",
			"rate limit",
		])
	)
		return {
			class: "usage_limit",
			message: "Grok subscription usage limit reached.",
		};
	if (
		(status >= 500 && status <= 599) ||
		matchesAny(body, ["server_is_overloaded", "overloaded", "overload"])
	)
		return {
			class: "overload",
			message: "Grok service is temporarily overloaded.",
		};
	return {
		class: "malformed",
		message: `Grok rejected the request (HTTP ${status}).`,
	};
}

async function collectErrorBody(
	body: AsyncIterable<Uint8Array>,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of body) {
			const remaining = MAX_HTTP_ERROR_BODY_BYTES - length;
			if (remaining <= 0) break;
			const copied = chunk.subarray(0, remaining).slice();
			chunks.push(copied);
			length += copied.byteLength;
			if (copied.byteLength < chunk.byteLength) break;
		}
	} catch {
		// The HTTP status still determines a safe provider-facing error sentence.
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decoder.decode(bytes);
}

function failureFromAssembly(
	assembly: Exclude<ReturnType<typeof assembleResponses>, { ok: true }>,
): ProviderAttemptResult {
	let message = assembly.message;
	if (assembly.class === "usage_limit")
		message = "Grok subscription usage limit reached.";
	else if (assembly.class === "overload")
		message = "Grok service is temporarily overloaded.";
	else if (assembly.class === "transport")
		message = "Grok request could not connect.";
	else if (assembly.class === "malformed")
		message = "Grok returned a malformed response stream.";
	return failure(assembly.class, message, {
		partialItemJson: assembly.raw_item_json,
		usage: assembly.usage,
	});
}

async function assembleBody(
	body: AsyncIterable<Uint8Array>,
): Promise<ProviderAttemptResult> {
	const framer = new SseFramer();
	const frames = [];
	try {
		for await (const chunk of body) frames.push(...framer.push(chunk));
		frames.push(...framer.finish());
	} catch (cause) {
		const message =
			cause instanceof SseFramingError && cause.code === "body_too_large"
				? "Grok response exceeded the size limit."
				: "Grok returned a malformed response stream.";
		return failure("malformed", message);
	}
	const assembly = assembleResponses(frames);
	if (!assembly.ok) return failureFromAssembly(assembly);
	return { ok: true, response: assembly };
}

function refreshOptions(
	options: GrokAttemptSenderOptions,
	signal: AbortSignal | undefined,
) {
	return {
		credentials: options.credentials,
		locks: options.locks,
		filesystem: options.filesystem,
		http: options.http,
		random: options.random,
		clock: options.clock,
		homeDirectory: options.homeDirectory,
		label: options.label,
		...(options.timeScale === undefined
			? {}
			: { timeScale: options.timeScale }),
		...(signal === undefined ? {} : { signal }),
	};
}

async function sendHttpAttempt(
	options: GrokAttemptSenderOptions,
	endpoint: string,
	request: EncodedSessionRequest,
	session: SessionState,
	credential: GrokCredential,
	requestSignal: AbortSignal | undefined,
): Promise<HttpAttemptResult> {
	let requestUuid: string;
	try {
		requestUuid = await newRequestUuid(options.random);
	} catch {
		return {
			kind: "failure",
			error: {
				class: "transport",
				message: "Grok request could not connect.",
			},
		};
	}
	const httpRequest: HttpRequest = {
		method: "POST",
		url: endpoint,
		headers: withGrokHeaders(
			request,
			session,
			credential,
			options.version,
			requestUuid,
		),
		body: request.body.slice(),
		firstByteTimeoutMilliseconds: GROK_REQUEST_FIRST_BYTE_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: GROK_REQUEST_IDLE_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: GROK_REQUEST_TOTAL_TIMEOUT_MILLISECONDS,
	};
	try {
		const result = await options.http.request(httpRequest, requestSignal);
		if (!result.ok)
			return { kind: "failure", error: mapPortFailure(result.error) };
		if (result.value.status === 401) return { kind: "unauthorized" };
		if (result.value.status < 200 || result.value.status >= 300) {
			const body = await collectErrorBody(result.value.body);
			return {
				kind: "failure",
				error: mapGrokHttpFailure(result.value.status, body),
			};
		}
		return {
			kind: "response",
			response: await assembleBody(result.value.body),
		};
	} catch (cause) {
		const portError: PortError = {
			code: "unavailable",
			message: "Grok HTTP request failed.",
			retryable: true,
			cause,
		};
		return { kind: "failure", error: mapPortFailure(portError) };
	}
}

async function refreshCredential(
	options: GrokAttemptSenderOptions,
	signal: AbortSignal | undefined,
	reason?: GrokRefreshReason,
): Promise<
	| { readonly ok: true; readonly value: GrokCredential }
	| { readonly ok: false; readonly error: ProviderAttemptFailure }
> {
	const result = await refreshGrokCredential(
		refreshOptions(options, signal),
		reason,
	);
	if (!result.ok) return { ok: false, error: mapGrokAuthFailure(result.error) };
	return { ok: true, value: result.value.credential };
}

/**
 * Bind the shared Responses retry/session policy to Grok's exact HTTP adapter.
 * This sender cannot switch providers: a non-Grok session is rejected before
 * credentials or HTTP are touched.
 */
export function createGrokAttemptSender(
	options: GrokAttemptSenderOptions,
): SendProviderAttempt {
	if (!validVersion(options.version))
		throw new TypeError("Grok client version is invalid.");
	const endpoint = resolveProviderEndpoint(
		GROK_RESPONSES_ENDPOINT,
		options.testEndpointOverride,
	);
	return async ({ request, session, signal }) => {
		if (session.provider !== "grok")
			return failure(
				"unsupported",
				"Grok request adapter received a non-Grok session.",
			);
		const effectiveSignal = signal ?? options.signal;
		const beginDeadline = () =>
			options.http instanceof HttpTransport
				? createHttpDeadline(
						options.clock,
						{
							firstByteTimeoutMilliseconds:
								GROK_REQUEST_FIRST_BYTE_TIMEOUT_MILLISECONDS,
							idleTimeoutMilliseconds: GROK_REQUEST_IDLE_TIMEOUT_MILLISECONDS,
							totalTimeoutMilliseconds: GROK_REQUEST_TOTAL_TIMEOUT_MILLISECONDS,
						},
						effectiveSignal,
					)
				: null;
		const firstDeadline = beginDeadline();
		let current: Awaited<ReturnType<typeof refreshCredential>>;
		let sent: HttpAttemptResult;
		try {
			current = await refreshCredential(
				options,
				firstDeadline?.signal ?? effectiveSignal,
			);
			if (firstDeadline?.error)
				return failure("timeout", "Grok request timed out.");
			if (!current.ok) return { ok: false, error: current.error };
			sent = await sendHttpAttempt(
				options,
				endpoint,
				request,
				session,
				current.value,
				firstDeadline?.signal ?? effectiveSignal,
			);
		} finally {
			firstDeadline?.complete();
		}
		if (sent.kind === "failure") return { ok: false, error: sent.error };
		if (sent.kind === "response") return sent.response;

		const replayDeadline = beginDeadline();
		let replay: HttpAttemptResult;
		try {
			const refreshed = await refreshCredential(
				options,
				replayDeadline?.signal ?? effectiveSignal,
				{
					kind: "unauthorized",
					rejectedAccessToken: current.value.access_token,
				},
			);
			if (replayDeadline?.error)
				return failure("timeout", "Grok request timed out.");
			if (!refreshed.ok) return { ok: false, error: refreshed.error };
			replay = await sendHttpAttempt(
				options,
				endpoint,
				request,
				session,
				refreshed.value,
				replayDeadline?.signal ?? effectiveSignal,
			);
		} finally {
			replayDeadline?.complete();
		}
		if (replay.kind === "failure") return { ok: false, error: replay.error };
		if (replay.kind === "response") return replay.response;
		return failure(
			"login",
			"Grok rejected this session; run `kogen provider login grok`.",
		);
	};
}
