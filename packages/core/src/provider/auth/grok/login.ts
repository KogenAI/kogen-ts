import { isAbsolute, join, resolve } from "node:path";
import type { ClockPort } from "../../../contracts/clock";
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
	type GrokProfile,
	readProfilesFile,
	withAccountProfile,
	writeProfilesFile,
} from "../../accounts/profiles";

export const GROK_AUTH_ISSUER = "https://auth.x.ai";
export const GROK_AUTH_DISCOVERY_URL = `${GROK_AUTH_ISSUER}/.well-known/openid-configuration`;
export const GROK_DEFAULT_DEVICE_ENDPOINT = `${GROK_AUTH_ISSUER}/oauth2/device/code`;
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_LOGIN_SCOPES =
	"openid profile email offline_access grok-cli:access api:access";
export const GROK_DEVICE_CODE_GRANT =
	"urn:ietf:params:oauth:grant-type:device_code";
export const GROK_HTTP_TIMEOUT_MILLISECONDS = 20_000;
export const GROK_AUTH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const GROK_CREDENTIAL_KEY = {
	provider: "grok",
	name: "credential",
} as const;
export const GROK_MISSING_LOGIN_MESSAGE =
	"Grok login is missing or invalid; run `kogen provider login grok`.";
export const GROK_REFRESH_LOGIN_MESSAGE =
	"Grok login is unavailable; run `kogen provider login grok`.";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface GrokCredential {
	readonly access_token: string;
	readonly refresh_token: string;
	readonly expires_at: number;
	readonly scopes: readonly string[];
	readonly email: string | null;
	readonly client_id: string;
	readonly token_endpoint: string;
}

export type GrokAuthError =
	| { readonly kind: "provider_login"; readonly message: string }
	| { readonly kind: "port"; readonly error: PortError };
export type GrokAuthResult<Value> = Result<Value, GrokAuthError>;

export interface GrokLoginOptions {
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly credentials: CredentialPort;
	readonly http: HttpPort;
	readonly clock: ClockPort;
	readonly homeDirectory: string;
	readonly label: string;
	readonly progress?: (line: string) => void;
	readonly signal?: AbortSignal;
}

interface DiscoveryDocument {
	readonly issuer: string;
	readonly tokenEndpoint: string;
	readonly deviceEndpoint: string;
}

interface DeviceCode {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresIn: number;
	readonly intervalSeconds: number;
}

function providerLogin(message: string): GrokAuthError {
	return { kind: "provider_login", message };
}

function portFailure<Value = never>(error: PortError): GrokAuthResult<Value> {
	return { ok: false, error: { kind: "port", error } };
}

function invalidPort<Value = never>(message: string): GrokAuthResult<Value> {
	return portFailure({ code: "invalid_input", message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint < 0x20 ||
			codePoint === 0x7f ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return true;
	}
	return false;
}

function hasUriWhitespace(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			codePoint <= 0x20 ||
			codePoint === 0x7f ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		)
			return true;
	}
	return false;
}

function safeText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!hasControlCharacters(value)
	);
}

function authRoot(homeDirectory: string): string | null {
	if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) return null;
	return join(resolve(homeDirectory), ".kogen");
}

export function validateGrokHttpsEndpoint(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 2048 ||
		value !== value.trim() ||
		hasUriWhitespace(value)
	)
		return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
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

function validateIssuer(value: unknown): boolean {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		hasUriWhitespace(value)
	)
		return false;
	try {
		const url = new URL(value);
		return (
			url.origin === GROK_AUTH_ISSUER &&
			url.pathname === "/" &&
			url.search.length === 0 &&
			url.hash.length === 0 &&
			url.username.length === 0 &&
			url.password.length === 0
		);
	} catch {
		return false;
	}
}

async function collectBody(
	response: HttpResponse,
): Promise<Result<Uint8Array>> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of response.body) {
			length += chunk.byteLength;
			if (length > GROK_AUTH_MAX_RESPONSE_BYTES)
				return {
					ok: false,
					error: {
						code: "invalid_input",
						message: "Grok authentication response is too large.",
						retryable: false,
					},
				};
			chunks.push(chunk.slice());
		}
	} catch (cause) {
		return {
			ok: false,
			error: {
				code:
					isRecord(cause) && cause.code === "timeout"
						? "timeout"
						: "unavailable",
				message: "Grok authentication response could not be read.",
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
	return { ok: true, value: bytes };
}

async function requestJson(
	options: GrokLoginOptions,
	request: HttpRequest,
	phase: "discovery" | "device" | "poll",
): Promise<
	GrokAuthResult<{ readonly status: number; readonly body: unknown }>
> {
	let response: Result<HttpResponse>;
	try {
		response = await options.http.request(request, options.signal);
	} catch (cause) {
		return providerRequestFailure(cause, options.signal);
	}
	if (!response.ok) {
		if (options.signal?.aborted)
			return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };
		return response.error.code === "timeout"
			? { ok: false, error: providerLogin("Grok sign-in timed out.") }
			: {
					ok: false,
					error: providerLogin("Grok sign-in could not connect to xAI."),
				};
	}
	const collected = await collectBody(response.value);
	if (!collected.ok) {
		if (options.signal?.aborted)
			return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };
		if (collected.error.code === "invalid_input") {
			const message =
				phase === "discovery"
					? "Grok returned an invalid sign-in discovery document."
					: phase === "device"
						? "Grok returned an invalid device sign-in response."
						: "Grok returned an invalid sign-in token response.";
			return { ok: false, error: providerLogin(message) };
		}
		return {
			ok: false,
			error: providerLogin(
				collected.error.code === "timeout"
					? "Grok sign-in timed out."
					: "Grok sign-in could not connect to xAI.",
			),
		};
	}
	let body: unknown;
	try {
		body = JSON.parse(decoder.decode(collected.value)) as unknown;
	} catch {
		if (response.value.status < 200 || response.value.status >= 300)
			return {
				ok: true,
				value: { status: response.value.status, body: null },
			};
		const message =
			phase === "discovery"
				? "Grok returned an invalid sign-in discovery document."
				: phase === "device"
					? "Grok returned an invalid device sign-in response."
					: "Grok returned an invalid sign-in token response.";
		return { ok: false, error: providerLogin(message) };
	}
	return { ok: true, value: { status: response.value.status, body } };
}

function providerRequestFailure(
	cause: unknown,
	signal: AbortSignal | undefined,
): GrokAuthResult<never> {
	if (signal?.aborted)
		return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };
	if (isRecord(cause) && cause.code === "timeout")
		return { ok: false, error: providerLogin("Grok sign-in timed out.") };
	return {
		ok: false,
		error: providerLogin("Grok sign-in could not connect to xAI."),
	};
}

function authRequest(
	method: string,
	url: string,
	body?: Uint8Array,
	contentType?: string,
): HttpRequest {
	return {
		method,
		url,
		headers: {
			accept: "application/json",
			...(contentType === undefined ? {} : { "content-type": contentType }),
		},
		...(body === undefined ? {} : { body }),
		firstByteTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: GROK_HTTP_TIMEOUT_MILLISECONDS,
	};
}

function parseDiscovery(value: unknown): GrokAuthResult<DiscoveryDocument> {
	if (!isRecord(value) || !validateIssuer(value.issuer))
		return {
			ok: false,
			error: providerLogin(
				"Grok returned an invalid sign-in discovery document.",
			),
		};
	const tokenEndpoint = validateGrokHttpsEndpoint(value.token_endpoint);
	if (tokenEndpoint === null)
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid sign-in endpoint."),
		};
	let deviceEndpoint = GROK_DEFAULT_DEVICE_ENDPOINT;
	if (value.device_authorization_endpoint !== undefined) {
		const validated = validateGrokHttpsEndpoint(
			value.device_authorization_endpoint,
		);
		if (validated === null)
			return {
				ok: false,
				error: providerLogin("Grok returned an invalid sign-in endpoint."),
			};
		deviceEndpoint = validated;
	}
	return {
		ok: true,
		value: { issuer: GROK_AUTH_ISSUER, tokenEndpoint, deviceEndpoint },
	};
}

function parseDeviceCode(value: unknown): GrokAuthResult<DeviceCode> {
	if (!isRecord(value))
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid device sign-in response."),
		};
	const verificationUri =
		value.verification_uri_complete ?? value.verification_uri;
	if (
		!safeText(value.device_code) ||
		!safeText(value.user_code) ||
		!validVerificationUri(verificationUri) ||
		!Number.isSafeInteger(value.expires_in) ||
		(value.expires_in as number) <= 0 ||
		!(
			value.interval === undefined ||
			(Number.isSafeInteger(value.interval) && (value.interval as number) >= 0)
		)
	)
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid device sign-in response."),
		};
	return {
		ok: true,
		value: {
			deviceCode: value.device_code,
			userCode: value.user_code,
			verificationUri,
			expiresIn: value.expires_in as number,
			intervalSeconds:
				value.interval === undefined ? 5 : (value.interval as number),
		},
	};
}

function validVerificationUri(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 2048 ||
		value !== value.trim() ||
		hasUriWhitespace(value)
	)
		return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username.length === 0 &&
			url.password.length === 0 &&
			url.hash.length === 0
		);
	} catch {
		return false;
	}
}

function parseToken(
	value: unknown,
	tokenEndpoint: string,
	nowMilliseconds: number,
): GrokAuthResult<GrokCredential> {
	if (
		!isRecord(value) ||
		!safeText(value.access_token) ||
		!safeText(value.refresh_token) ||
		!Number.isSafeInteger(value.expires_in) ||
		(value.expires_in as number) <= 0 ||
		!(value.scope === undefined || safeText(value.scope)) ||
		!(
			value.email === undefined ||
			value.email === null ||
			safeText(value.email)
		)
	)
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid sign-in token response."),
		};
	const nowSeconds = Math.floor(nowMilliseconds / 1000);
	const expiresAt = nowSeconds + (value.expires_in as number);
	if (
		!Number.isSafeInteger(nowSeconds) ||
		nowSeconds < 0 ||
		!Number.isSafeInteger(expiresAt)
	)
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid sign-in token response."),
		};
	const scopes =
		typeof value.scope === "string"
			? value.scope.split(/[\t\n\r ]+/u).filter(Boolean)
			: GROK_LOGIN_SCOPES.split(" ");
	if (scopes.length === 0 || scopes.some((scope) => !safeText(scope)))
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid sign-in token response."),
		};
	return {
		ok: true,
		value: {
			access_token: value.access_token,
			refresh_token: value.refresh_token,
			expires_at: expiresAt,
			scopes,
			email: value.email === undefined ? null : (value.email as string | null),
			client_id: GROK_CLIENT_ID,
			token_endpoint: tokenEndpoint,
		},
	};
}

export function parseSavedGrokCredential(
	bytes: Uint8Array,
): GrokAuthResult<GrokCredential> {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes)) as unknown;
	} catch {
		return { ok: false, error: providerLogin(GROK_MISSING_LOGIN_MESSAGE) };
	}
	if (
		!isRecord(value) ||
		!safeText(value.access_token) ||
		!safeText(value.refresh_token) ||
		!Number.isSafeInteger(value.expires_at) ||
		(value.expires_at as number) < 0 ||
		!Array.isArray(value.scopes) ||
		value.scopes.length === 0 ||
		!value.scopes.every(safeText) ||
		!(value.email === null || safeText(value.email)) ||
		value.client_id !== GROK_CLIENT_ID
	)
		return { ok: false, error: providerLogin(GROK_MISSING_LOGIN_MESSAGE) };
	const tokenEndpoint = validateGrokHttpsEndpoint(value.token_endpoint);
	if (tokenEndpoint === null)
		return { ok: false, error: providerLogin(GROK_MISSING_LOGIN_MESSAGE) };
	return {
		ok: true,
		value: {
			access_token: value.access_token,
			refresh_token: value.refresh_token,
			expires_at: value.expires_at as number,
			scopes: value.scopes,
			email: value.email as string | null,
			client_id: GROK_CLIENT_ID,
			token_endpoint: tokenEndpoint,
		},
	};
}

function monotonicMilliseconds(clock: ClockPort): GrokAuthResult<number> {
	let value: number;
	try {
		value = clock.monotonicMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the monotonic clock for Grok sign-in.",
			retryable: true,
			cause,
		});
	}
	return Number.isFinite(value) && value >= 0
		? { ok: true, value }
		: invalidPort("Monotonic clock returned an invalid Grok sign-in time.");
}

function unixMilliseconds(clock: ClockPort): GrokAuthResult<number> {
	let value: number;
	try {
		value = clock.unixMilliseconds();
	} catch (cause) {
		return portFailure({
			code: "unavailable",
			message: "Could not read the system clock for Grok sign-in.",
			retryable: true,
			cause,
		});
	}
	return Number.isSafeInteger(value) && value >= 0
		? { ok: true, value }
		: invalidPort("System clock returned an invalid Grok sign-in time.");
}

async function postForm(
	options: GrokLoginOptions,
	url: string,
	form: URLSearchParams,
	phase: "device" | "poll",
): Promise<
	GrokAuthResult<{ readonly status: number; readonly body: unknown }>
> {
	return requestJson(
		options,
		authRequest(
			"POST",
			url,
			encoder.encode(form.toString()),
			"application/x-www-form-urlencoded",
		),
		phase,
	);
}

function httpStatusMessage(
	phase: "discovery" | "device" | "poll",
	status: number,
): string {
	if (phase === "discovery")
		return `Grok sign-in discovery failed (HTTP ${status}).`;
	if (phase === "device") return `Grok device sign-in failed (HTTP ${status}).`;
	return `Grok sign-in polling failed (HTTP ${status}).`;
}

function profileForCredential(credential: GrokCredential): GrokProfile {
	return {
		email: credential.email,
		expires_at: credential.expires_at,
		signed_in: true,
	};
}

async function persistLogin(
	options: GrokLoginOptions,
	credential: GrokCredential,
): Promise<GrokAuthResult<void>> {
	const key = { ...GROK_CREDENTIAL_KEY, account: options.label };
	let previous: Result<Uint8Array>;
	try {
		previous = await options.credentials.read(key);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not inspect the saved Grok credential.",
			retryable: true,
			cause,
		});
	}
	if (!previous.ok && previous.error.code !== "not_found")
		return portFailure(previous.error);
	let profiles = await readProfilesFile(
		options.filesystem,
		options.homeDirectory,
	);
	if (!profiles.ok) return portFailure(profiles.error);
	let written: Result<void>;
	try {
		written = await options.credentials.write(
			key,
			encoder.encode(JSON.stringify(credential)),
		);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not save the Grok credential.",
			retryable: true,
			cause,
		});
	}
	if (!written.ok) return portFailure(written.error);
	profiles = {
		ok: true,
		value: withAccountProfile(
			profiles.value,
			"grok",
			options.label,
			profileForCredential(credential),
		),
	};
	const profileWrite = await writeProfilesFile(
		options.filesystem,
		options.homeDirectory,
		profiles.value,
	);
	if (!profileWrite.ok) {
		try {
			if (previous.ok)
				await options.credentials.write(key, previous.value.slice());
			else await options.credentials.remove(key);
		} catch {
			// Keep the original profile write error; the saved credential remains valid.
		}
		return portFailure(profileWrite.error);
	}
	return { ok: true, value: undefined };
}

/** Device-code OAuth login using only Kogen's HTTP, clock, and credential ports. */
export async function loginGrok(
	options: GrokLoginOptions,
): Promise<GrokAuthResult<GrokCredential>> {
	if (!isAccountLabel(options.label))
		return { ok: false, error: providerLogin("Invalid Grok account label.") };
	if (authRoot(options.homeDirectory) === null)
		return invalidPort("HOME must be an absolute path.");
	if (options.signal?.aborted)
		return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };

	const discoveryResult = await requestJson(
		options,
		authRequest("GET", GROK_AUTH_DISCOVERY_URL),
		"discovery",
	);
	if (!discoveryResult.ok) return discoveryResult;
	if (discoveryResult.value.status < 200 || discoveryResult.value.status >= 300)
		return {
			ok: false,
			error: providerLogin(
				httpStatusMessage("discovery", discoveryResult.value.status),
			),
		};
	const discovery = parseDiscovery(discoveryResult.value.body);
	if (!discovery.ok) return discovery;

	const deviceResponse = await postForm(
		options,
		discovery.value.deviceEndpoint,
		new URLSearchParams({
			client_id: GROK_CLIENT_ID,
			scope: GROK_LOGIN_SCOPES,
		}),
		"device",
	);
	if (!deviceResponse.ok) return deviceResponse;
	if (deviceResponse.value.status < 200 || deviceResponse.value.status >= 300)
		return {
			ok: false,
			error: providerLogin(
				httpStatusMessage("device", deviceResponse.value.status),
			),
		};
	const device = parseDeviceCode(deviceResponse.value.body);
	if (!device.ok) return device;

	const start = monotonicMilliseconds(options.clock);
	if (!start.ok) return start;
	const lifetime = device.value.expiresIn * 1000;
	const deadline = start.value + lifetime;
	let intervalMilliseconds = Math.max(1, device.value.intervalSeconds) * 1000;
	if (!Number.isSafeInteger(lifetime) || !Number.isFinite(deadline))
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid device sign-in response."),
		};
	if (!Number.isSafeInteger(intervalMilliseconds))
		return {
			ok: false,
			error: providerLogin("Grok returned an invalid device sign-in response."),
		};
	try {
		options.progress?.(`Grok sign-in code: ${device.value.userCode}\n`);
		options.progress?.(`Open: ${device.value.verificationUri}\n`);
	} catch (cause) {
		return portFailure({
			code: "io",
			message: "Could not display the Grok sign-in code.",
			retryable: false,
			cause,
		});
	}
	while (true) {
		if (options.signal?.aborted)
			return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };
		const beforeSleep = monotonicMilliseconds(options.clock);
		if (!beforeSleep.ok) return beforeSleep;
		const remaining = deadline - beforeSleep.value;
		if (remaining <= 0)
			return {
				ok: false,
				error: providerLogin(
					"Grok sign-in code expired; run `kogen provider login grok` again.",
				),
			};
		try {
			await options.clock.sleep(
				Math.min(intervalMilliseconds, remaining),
				options.signal,
			);
		} catch (cause) {
			return options.signal?.aborted
				? {
						ok: false,
						error: providerLogin("Grok sign-in was cancelled."),
					}
				: portFailure({
						code: "unavailable",
						message: "Grok sign-in wait failed.",
						retryable: true,
						cause,
					});
		}
		const afterSleep = monotonicMilliseconds(options.clock);
		if (!afterSleep.ok) return afterSleep;
		if (afterSleep.value >= deadline)
			return {
				ok: false,
				error: providerLogin(
					"Grok sign-in code expired; run `kogen provider login grok` again.",
				),
			};

		const poll = await postForm(
			options,
			discovery.value.tokenEndpoint,
			new URLSearchParams({
				grant_type: GROK_DEVICE_CODE_GRANT,
				device_code: device.value.deviceCode,
				client_id: GROK_CLIENT_ID,
			}),
			"poll",
		);
		if (!poll.ok) return poll;
		const oauthError = isRecord(poll.value.body)
			? poll.value.body.error
			: undefined;
		if (oauthError === "authorization_pending") continue;
		if (oauthError === "slow_down") {
			if (!Number.isSafeInteger(intervalMilliseconds + 5_000))
				return {
					ok: false,
					error: providerLogin(
						"Grok returned an invalid device sign-in response.",
					),
				};
			intervalMilliseconds += 5_000;
			continue;
		}
		if (oauthError === "expired_token")
			return {
				ok: false,
				error: providerLogin(
					"Grok sign-in code expired; run `kogen provider login grok` again.",
				),
			};
		if (oauthError === "access_denied")
			return { ok: false, error: providerLogin("Grok sign-in was cancelled.") };
		if (poll.value.status < 200 || poll.value.status >= 300)
			return {
				ok: false,
				error: providerLogin(httpStatusMessage("poll", poll.value.status)),
			};
		const now = unixMilliseconds(options.clock);
		if (!now.ok) return now;
		const credential = parseToken(
			poll.value.body,
			discovery.value.tokenEndpoint,
			now.value,
		);
		if (!credential.ok) return credential;
		const persisted = await persistLogin(options, credential.value);
		if (!persisted.ok) return persisted;
		return credential;
	}
}
