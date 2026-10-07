import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
	type ChatGptProfile,
	loadOrCreateHostId,
	readProfilesFile,
	withAccountProfile,
	writeProfilesFile,
} from "../../accounts/profiles";
import { CHATGPT_CALLBACK_URL, listenForChatGptCallback } from "./callback";
import {
	CHATGPT_TOKEN_ISSUER,
	type ChatGptIdentity,
	verifyChatGptIdToken,
} from "./jwks";

export const CHATGPT_AUTH_BASE_URL = CHATGPT_TOKEN_ISSUER;
export const CHATGPT_DISCOVERY_PATH = "/.well-known/openid-configuration";
export const CHATGPT_REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_LOGIN_SCOPES =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_HTTP_TIMEOUT_MILLISECONDS = 20_000;
export const CHATGPT_CREDENTIAL_KEY = {
	provider: "chatgpt",
	name: "credential",
} as const;
export const CHATGPT_LOGIN_RETRY_MESSAGE =
	"Saved ChatGPT client was rejected; retrying with a fresh registration\n";

const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ChatGptCredential {
	readonly client_id: string;
	readonly access_token: string;
	readonly refresh_token: string;
	readonly id_token: string;
	readonly expires_at: number;
	readonly scopes: readonly string[];
	readonly subject: string;
	readonly email: string | null;
	readonly host_id: string;
}

export interface ChatGptLoginOptions {
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly credentials: CredentialPort;
	readonly http: HttpPort;
	readonly random: RandomPort;
	readonly clock: Pick<ClockPort, "unixMilliseconds">;
	readonly homeDirectory: string;
	readonly label: string;
	readonly openBrowser: (authorizationUrl: string) => Promise<Result<void>>;
	readonly progress?: (line: string) => void;
	/** KOGEN_AUTH_URL test seam; production discovery uses auth.openai.com. */
	readonly authUrl?: string;
	/** The production value is 1455. Tests may provide another available port. */
	readonly callbackPort?: number;
	readonly callbackTimeoutMilliseconds?: number;
}

interface DiscoveryDocument {
	readonly issuer: string;
	readonly authorization_endpoint: string;
	readonly token_endpoint: string;
	readonly jwks_uri: string;
}

interface TokenDocument {
	readonly access_token: string;
	readonly refresh_token: string;
	readonly id_token: string;
	readonly expires_in: number;
	readonly scope: string;
}

type LoginAttempt =
	| {
			readonly kind: "success";
			readonly credential: ChatGptCredential;
			readonly identity: ChatGptIdentity;
	  }
	| { readonly kind: "authorization_rejected" };

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable,
		...(cause === undefined ? {} : { cause }),
	};
}

function invalid(message: string): Result<never> {
	return { ok: false, error: portError("invalid_input", message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value)
	);
}

function parseJson(bytes: Uint8Array): unknown | null {
	try {
		return JSON.parse(decoder.decode(bytes)) as unknown;
	} catch {
		return null;
	}
}

function parseStoredCredential(bytes: Uint8Array): Result<ChatGptCredential> {
	const value = parseJson(bytes);
	if (!isRecord(value)) return invalid("Saved ChatGPT credential is invalid.");
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
		return invalid("Saved ChatGPT credential is invalid.");
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

function validatedUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
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

function normalizedAuthBase(value: string | undefined): Result<string> {
	const candidate = value ?? CHATGPT_AUTH_BASE_URL;
	const validated = validatedUrl(candidate);
	if (validated === null)
		return invalid(
			"ChatGPT auth URL must be an absolute HTTP(S) URL without userinfo.",
		);
	const url = new URL(validated);
	if (url.search.length > 0 || url.hash.length > 0)
		return invalid("ChatGPT auth URL must not include a query or fragment.");
	return { ok: true, value: url.toString().replace(/\/$/, "") };
}

function validateDiscoveredEndpoint(
	value: unknown,
	authOrigin: string,
): string | null {
	const validated = validatedUrl(value);
	if (validated === null) return null;
	const url = new URL(validated);
	return url.origin === authOrigin ? url.toString() : null;
}

async function collectBody(
	response: HttpResponse,
): Promise<Result<Uint8Array>> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for await (const chunk of response.body) {
			length += chunk.byteLength;
			if (length > MAX_OAUTH_RESPONSE_BYTES)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"ChatGPT OAuth response is too large.",
					),
				};
			chunks.push(chunk.slice());
		}
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"ChatGPT OAuth response could not be read.",
				true,
				cause,
			),
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
	http: HttpPort,
	request: HttpRequest,
): Promise<Result<{ readonly status: number; readonly body: unknown }>> {
	let responseResult: Result<HttpResponse>;
	try {
		responseResult = await http.request(request);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"ChatGPT OpenID request failed.",
				true,
				cause,
			),
		};
	}
	if (!responseResult.ok) return responseResult;
	const body = await collectBody(responseResult.value);
	if (!body.ok) return body;
	const document = parseJson(body.value);
	if (document === null)
		return invalid("ChatGPT OpenID response is invalid JSON.");
	return {
		ok: true,
		value: { status: responseResult.value.status, body: document },
	};
}

function getJsonRequest(url: string): HttpRequest {
	return {
		method: "GET",
		url,
		headers: { accept: "application/json" },
		firstByteTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	};
}

async function discover(
	http: HttpPort,
	authBase: string,
): Promise<Result<DiscoveryDocument>> {
	const origin = new URL(authBase).origin;
	const result = await requestJson(
		http,
		getJsonRequest(`${authBase}${CHATGPT_DISCOVERY_PATH}`),
	);
	if (!result.ok) return result;
	if (result.value.status < 200 || result.value.status >= 300)
		return {
			ok: false,
			error: portError("unavailable", "ChatGPT OpenID discovery failed.", true),
		};
	const value = result.value.body;
	if (!isRecord(value) || value.issuer !== CHATGPT_TOKEN_ISSUER)
		return invalid("ChatGPT OpenID issuer is invalid.");
	const authorizationEndpoint = validateDiscoveredEndpoint(
		value.authorization_endpoint,
		origin,
	);
	const tokenEndpoint = validateDiscoveredEndpoint(
		value.token_endpoint,
		origin,
	);
	const jwksUri = validateDiscoveredEndpoint(value.jwks_uri, origin);
	if (
		authorizationEndpoint === null ||
		tokenEndpoint === null ||
		jwksUri === null
	)
		return invalid("ChatGPT OpenID endpoint is invalid.");
	return {
		ok: true,
		value: {
			issuer: value.issuer,
			authorization_endpoint: authorizationEndpoint,
			token_endpoint: tokenEndpoint,
			jwks_uri: jwksUri,
		},
	};
}

async function randomBase64Url(
	random: RandomPort,
	length: number,
): Promise<Result<string>> {
	let result: Result<Uint8Array>;
	try {
		result = await random.bytes(length);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				"Secure random values are unavailable.",
				true,
				cause,
			),
		};
	}
	if (!result.ok) return result;
	if (
		!(result.value instanceof Uint8Array) ||
		result.value.byteLength !== length
	)
		return invalid("Secure random source returned an invalid byte count.");
	return { ok: true, value: Buffer.from(result.value).toString("base64url") };
}

function authorizationUrl(
	discovery: DiscoveryDocument,
	clientId: string,
	hostId: string,
	state: string,
	nonce: string,
	challenge: string,
	callbackUrl: string,
): string {
	const url = new URL(discovery.authorization_endpoint);
	const query = url.searchParams;
	query.set("client_id", clientId);
	query.set("ext_agent_host_id", hostId);
	query.set("response_type", "code");
	query.set("redirect_uri", callbackUrl);
	query.set("scope", CHATGPT_LOGIN_SCOPES);
	query.set("resource", CHATGPT_RESOURCE);
	query.set("state", state);
	query.set("nonce", nonce);
	query.set("code_challenge_method", "S256");
	query.set("code_challenge", challenge);
	if (clientId === CHATGPT_DYNAMIC_CLIENT_ID)
		query.set("agent_name_hint", "Kogen");
	else query.delete("agent_name_hint");
	return url.toString();
}

function parseTokenDocument(value: unknown): Result<TokenDocument> {
	if (
		!isRecord(value) ||
		!safeText(value.access_token) ||
		!(
			value.refresh_token === undefined ||
			typeof value.refresh_token === "string"
		) ||
		!safeText(value.id_token) ||
		!Number.isSafeInteger(value.expires_in) ||
		(value.expires_in as number) <= 0 ||
		!safeText(value.scope)
	)
		return invalid("ChatGPT token response is invalid.");
	return {
		ok: true,
		value: {
			access_token: value.access_token,
			refresh_token:
				typeof value.refresh_token === "string" ? value.refresh_token : "",
			id_token: value.id_token,
			expires_in: value.expires_in as number,
			scope: value.scope,
		},
	};
}

async function exchangeCode(
	options: ChatGptLoginOptions,
	discovery: DiscoveryDocument,
	callback: { readonly code: string; readonly clientId: string },
	verifier: string,
): Promise<Result<TokenDocument>> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: callback.code,
		redirect_uri: callbackUrl(options.callbackPort),
		client_id: callback.clientId,
		code_verifier: verifier,
		resource: CHATGPT_RESOURCE,
	});
	const result = await requestJson(options.http, {
		method: "POST",
		url: discovery.token_endpoint,
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: encoder.encode(body.toString()),
		firstByteTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		idleTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
		totalTimeoutMilliseconds: CHATGPT_HTTP_TIMEOUT_MILLISECONDS,
	});
	if (!result.ok) return result;
	if (result.value.status < 200 || result.value.status >= 300)
		return {
			ok: false,
			error: portError("invalid_input", "ChatGPT token exchange was rejected."),
		};
	return parseTokenDocument(result.value.body);
}

async function loadJwks(http: HttpPort, uri: string): Promise<Result<unknown>> {
	const result = await requestJson(http, getJsonRequest(uri));
	if (!result.ok) return result;
	if (result.value.status < 200 || result.value.status >= 300)
		return {
			ok: false,
			error: portError(
				"unavailable",
				"ChatGPT signing keys could not be loaded.",
				true,
			),
		};
	return { ok: true, value: result.value.body };
}

function callbackUrl(port: number | undefined): string {
	return port === undefined || port === 1455
		? CHATGPT_CALLBACK_URL
		: `http://127.0.0.1:${port}/auth/callback`;
}

async function loginAttempt(
	options: ChatGptLoginOptions,
	authBase: string,
	clientId: string,
	hostId: string,
): Promise<Result<LoginAttempt>> {
	const discovery = await discover(options.http, authBase);
	if (!discovery.ok) return discovery;
	const verifierResult = await randomBase64Url(options.random, 32);
	if (!verifierResult.ok) return verifierResult;
	const stateResult = await randomBase64Url(options.random, 32);
	if (!stateResult.ok) return stateResult;
	const nonceResult = await randomBase64Url(options.random, 32);
	if (!nonceResult.ok) return nonceResult;
	const verifier = verifierResult.value;
	const state = stateResult.value;
	const nonce = nonceResult.value;
	const challenge = createHash("sha256")
		.update(verifier, "ascii")
		.digest("base64url");
	const bound = await listenForChatGptCallback({
		expectedState: state,
		...(options.callbackPort === undefined
			? {}
			: { port: options.callbackPort }),
		...(options.callbackTimeoutMilliseconds === undefined
			? {}
			: { timeoutMilliseconds: options.callbackTimeoutMilliseconds }),
	});
	if (!bound.ok) return bound;
	const listener = bound.value;
	try {
		const url = authorizationUrl(
			discovery.value,
			clientId,
			hostId,
			state,
			nonce,
			challenge,
			callbackUrl(options.callbackPort),
		);
		options.progress?.("Continue with ChatGPT\n");
		options.progress?.(`${url}\n`);
		let opened: Result<void>;
		try {
			opened = await options.openBrowser(url);
		} catch (cause) {
			return {
				ok: false,
				error: portError(
					"unavailable",
					"Could not open the ChatGPT sign-in page.",
					true,
					cause,
				),
			};
		}
		if (!opened.ok) return opened;
		const callbackResult = await listener.result;
		if (!callbackResult.ok) return callbackResult;
		if (callbackResult.value.oauthError !== null)
			return { ok: true, value: { kind: "authorization_rejected" } };
		if (callbackResult.value.code === null)
			return invalid("ChatGPT callback did not include an authorization code.");
		const returnedClientId = callbackResult.value.clientId ?? clientId;
		const tokens = await exchangeCode(
			options,
			discovery.value,
			{ code: callbackResult.value.code, clientId: returnedClientId },
			verifier,
		);
		if (!tokens.ok) return tokens;
		if (
			!tokens.value.scope.split(/[\t\n\r ]+/u).includes(CHATGPT_REQUIRED_SCOPE)
		)
			return invalid(`ChatGPT token lacks ${CHATGPT_REQUIRED_SCOPE}.`);
		const jwks = await loadJwks(options.http, discovery.value.jwks_uri);
		if (!jwks.ok) return jwks;
		const nowMilliseconds = options.clock.unixMilliseconds();
		if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0)
			return invalid("System clock returned an invalid login time.");
		const nowSeconds = Math.floor(nowMilliseconds / 1000);
		const identity = verifyChatGptIdToken(tokens.value.id_token, {
			jwks: jwks.value,
			clientId: returnedClientId,
			nonce,
			nowUnixSeconds: nowSeconds,
		});
		if (!identity.ok) return identity;
		const expiresAt = nowSeconds + tokens.value.expires_in;
		if (!Number.isSafeInteger(expiresAt))
			return invalid("ChatGPT token expiry is outside the supported range.");
		return {
			ok: true,
			value: {
				kind: "success",
				identity: identity.value,
				credential: {
					client_id: returnedClientId,
					access_token: tokens.value.access_token,
					refresh_token: tokens.value.refresh_token,
					id_token: tokens.value.id_token,
					expires_at: expiresAt,
					scopes: tokens.value.scope.split(/[\t\n\r ]+/u).filter(Boolean),
					subject: identity.value.subject,
					email: identity.value.email,
					host_id: hostId,
				},
			},
		};
	} finally {
		await listener.close();
	}
}

function serializeCredential(credential: ChatGptCredential): Uint8Array {
	return encoder.encode(JSON.stringify(credential));
}

function profileForLogin(
	credential: ChatGptCredential,
	identity: ChatGptIdentity,
	previous: ChatGptProfile | undefined,
): ChatGptProfile {
	return {
		client_id: credential.client_id,
		subject: identity.subject,
		email: identity.email,
		expires_at: credential.expires_at,
		signed_in: true,
		plan_usage: previous?.plan_usage ?? null,
		notice_shown: previous?.notice_shown ?? false,
		remote_revoked: false,
	};
}

function sameSubject(
	credential: ChatGptCredential | null,
	profile: ChatGptProfile | undefined,
	identity: ChatGptIdentity,
): boolean {
	return (
		(credential === null || credential.subject === identity.subject) &&
		(profile === undefined || profile.subject === identity.subject)
	);
}

/** Perform a fakeable ChatGPT PKCE login and atomically publish its credential/profile. */
export async function loginChatGpt(
	options: ChatGptLoginOptions,
): Promise<Result<ChatGptCredential>> {
	if (
		!isAccountLabel(options.label) ||
		options.homeDirectory.length === 0 ||
		options.homeDirectory.includes("\0") ||
		(options.callbackPort !== undefined &&
			(!Number.isSafeInteger(options.callbackPort) ||
				options.callbackPort < 1 ||
				options.callbackPort > 65_535)) ||
		(options.callbackTimeoutMilliseconds !== undefined &&
			(!Number.isSafeInteger(options.callbackTimeoutMilliseconds) ||
				options.callbackTimeoutMilliseconds <= 0))
	)
		return invalid("ChatGPT login settings are invalid.");
	const authBase = normalizedAuthBase(options.authUrl);
	if (!authBase.ok) return authBase;
	const hostId = await loadOrCreateHostId(
		options.filesystem,
		options.homeDirectory,
	);
	if (!hostId.ok) return hostId;
	const profileResult = await readProfilesFile(
		options.filesystem,
		options.homeDirectory,
	);
	if (!profileResult.ok) return profileResult;
	const previousProfile = profileResult.value.chatgpt[options.label];
	const existing = await options.credentials.read({
		...CHATGPT_CREDENTIAL_KEY,
		account: options.label,
	});
	let previousCredential: ChatGptCredential | null = null;
	let previousCredentialBytes: Uint8Array | null = null;
	if (existing.ok) {
		const parsed = parseStoredCredential(existing.value);
		if (!parsed.ok) return parsed;
		previousCredential = parsed.value;
		previousCredentialBytes = existing.value.slice();
	} else if (existing.error.code !== "not_found") return existing;

	if (
		previousCredential !== null &&
		previousProfile !== undefined &&
		previousCredential.subject !== previousProfile.subject
	)
		return invalid("Saved ChatGPT account identity is inconsistent.");

	const savedClientId = previousCredential?.client_id;
	let attempt = await loginAttempt(
		options,
		authBase.value,
		savedClientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
		hostId.value,
	);
	if (!attempt.ok) return attempt;
	if (attempt.value.kind === "authorization_rejected") {
		if (
			savedClientId === undefined ||
			savedClientId === CHATGPT_DYNAMIC_CLIENT_ID
		)
			return {
				ok: false,
				error: portError("invalid_input", "ChatGPT sign-in was declined."),
			};
		options.progress?.(CHATGPT_LOGIN_RETRY_MESSAGE);
		attempt = await loginAttempt(
			options,
			authBase.value,
			CHATGPT_DYNAMIC_CLIENT_ID,
			hostId.value,
		);
		if (!attempt.ok) return attempt;
		if (attempt.value.kind === "authorization_rejected")
			return {
				ok: false,
				error: portError("invalid_input", "ChatGPT sign-in was declined."),
			};
	}
	const { credential, identity } = attempt.value;
	if (!sameSubject(previousCredential, previousProfile, identity))
		return invalid("ChatGPT account subject changed for this label.");

	const key = { ...CHATGPT_CREDENTIAL_KEY, account: options.label };
	const writtenCredential = await options.credentials.write(
		key,
		serializeCredential(credential),
	);
	if (!writtenCredential.ok) return writtenCredential;
	const updatedProfiles = withAccountProfile(
		profileResult.value,
		"chatgpt",
		options.label,
		profileForLogin(credential, identity, previousProfile),
	);
	const writtenProfile = await writeProfilesFile(
		options.filesystem,
		options.homeDirectory,
		updatedProfiles,
	);
	if (!writtenProfile.ok) {
		const rollback =
			previousCredentialBytes === null
				? await options.credentials.remove(key)
				: await options.credentials.write(key, previousCredentialBytes);
		if (!rollback.ok)
			return {
				ok: false,
				error: portError(
					"io",
					"ChatGPT login could not be saved and credential rollback failed.",
					false,
					{ profileError: writtenProfile.error, rollbackError: rollback.error },
				),
			};
		return writtenProfile;
	}
	return { ok: true, value: credential };
}
