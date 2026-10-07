import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { ClockPort } from "../../packages/core/src/contracts/clock";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	CredentialKey,
	CredentialPort,
	FileReadRequest,
	FileSystemPort,
	FileWriteRequest,
	HttpPort,
	HttpRequest,
	HttpResponse,
	RandomPort,
} from "../../packages/core/src/contracts/ports";
import {
	CHATGPT_CALLBACK_FAILURE_TEXT,
	CHATGPT_LOOPBACK_PORT,
	listenForChatGptCallback,
} from "../../packages/core/src/provider/auth/chatgpt/callback";
import { CHATGPT_TOKEN_ISSUER } from "../../packages/core/src/provider/auth/chatgpt/jwks";
import {
	CHATGPT_CREDENTIAL_KEY,
	CHATGPT_LOGIN_RETRY_MESSAGE,
	type ChatGptCredential,
	loginChatGpt,
} from "../../packages/core/src/provider/auth/chatgpt/login";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NOW_MILLISECONDS = 1_800_000_000_000;
const SIGNING_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = SIGNING_KEYS.publicKey.export({ format: "jwk" });

function bytesOf(value: string): Uint8Array {
	return encoder.encode(value);
}

function jsonBody(value: unknown): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield bytesOf(JSON.stringify(value));
		},
	};
}

function signedIdToken(
	clientId: string,
	nonce: string,
	claims: Record<string, unknown> = {},
): string {
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", kid: "login-test-key", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: CHATGPT_TOKEN_ISSUER,
			aud: [clientId],
			exp: NOW_MILLISECONDS / 1000 + 3600,
			nonce,
			sub: "test-subject",
			email: "test@kogen.invalid",
			...claims,
		}),
	).toString("base64url");
	const signature = sign(
		"RSA-SHA256",
		Buffer.from(`${header}.${payload}`, "ascii"),
		SIGNING_KEYS.privateKey,
	).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

class MemoryFileSystem
	implements Pick<FileSystemPort, "readFile" | "writeFileAtomically">
{
	readonly files = new Map<string, Uint8Array>();
	readonly writes: FileWriteRequest[] = [];

	async readFile(request: FileReadRequest): Promise<Result<Uint8Array>> {
		const value = this.files.get(`${request.root}\0${request.path}`);
		return value === undefined
			? {
					ok: false,
					error: { code: "not_found", message: "missing", retryable: false },
				}
			: { ok: true, value: value.slice() };
	}

	async writeFileAtomically(request: FileWriteRequest): Promise<Result<void>> {
		this.writes.push({ ...request, bytes: request.bytes.slice() });
		this.files.set(`${request.root}\0${request.path}`, request.bytes.slice());
		return { ok: true, value: undefined };
	}
}

class MemoryCredentials implements CredentialPort {
	readonly files = new Map<string, Uint8Array>();

	async read(key: CredentialKey): Promise<Result<Uint8Array>> {
		const value = this.files.get(this.key(key));
		return value === undefined
			? {
					ok: false,
					error: { code: "not_found", message: "missing", retryable: false },
				}
			: { ok: true, value: value.slice() };
	}

	async write(key: CredentialKey, value: Uint8Array): Promise<Result<void>> {
		this.files.set(this.key(key), value.slice());
		return { ok: true, value: undefined };
	}

	async remove(key: CredentialKey): Promise<Result<void>> {
		this.files.delete(this.key(key));
		return { ok: true, value: undefined };
	}

	private key(key: CredentialKey): string {
		return `${key.provider}/${key.account}/${key.name}`;
	}
}

class TestRandom implements RandomPort {
	private nextByte = 1;

	async bytes(length: number): Promise<Result<Uint8Array>> {
		const bytes = new Uint8Array(length);
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = this.nextByte;
			this.nextByte = (this.nextByte % 250) + 1;
		}
		return { ok: true, value: bytes };
	}
}

class TestClock implements Pick<ClockPort, "unixMilliseconds"> {
	unixMilliseconds(): number {
		return NOW_MILLISECONDS;
	}
}

interface PendingCode {
	readonly clientId: string;
	readonly challenge: string;
	readonly nonce: string;
	readonly redirectUri: string;
}

class FakeOAuthHttp implements HttpPort {
	readonly events: {
		readonly kind: string;
		readonly url: string;
		readonly body?: string;
	}[] = [];
	readonly unmatched: string[] = [];
	readonly codes = new Map<string, PendingCode>();
	subject = "test-subject";
	private registrationNumber = 0;

	recordAuthorization(code: string, data: PendingCode): void {
		this.codes.set(code, data);
	}

	async request(request: HttpRequest): Promise<Result<HttpResponse>> {
		const url = new URL(request.url);
		if (
			request.method === "GET" &&
			url.pathname === "/.well-known/openid-configuration"
		) {
			this.events.push({ kind: "discovery", url: request.url });
			return this.response(200, {
				issuer: CHATGPT_TOKEN_ISSUER,
				authorization_endpoint: `${url.origin}/api/accounts/authorize`,
				token_endpoint: `${url.origin}/api/accounts/oauth/token`,
				jwks_uri: `${url.origin}/jwks`,
			});
		}
		if (request.method === "GET" && url.pathname === "/jwks") {
			this.events.push({ kind: "jwks", url: request.url });
			return this.response(200, {
				keys: [
					{
						kty: "RSA",
						kid: "login-test-key",
						alg: "RS256",
						use: "sig",
						n: PUBLIC_JWK.n,
						e: PUBLIC_JWK.e,
					},
				],
			});
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/accounts/oauth/token"
		) {
			const bodyText = request.body ? decoder.decode(request.body) : "";
			this.events.push({ kind: "token", url: request.url, body: bodyText });
			const form = new URLSearchParams(bodyText);
			const code = form.get("code") ?? "";
			const issued = this.codes.get(code);
			if (
				form.get("grant_type") !== "authorization_code" ||
				issued === undefined ||
				form.get("redirect_uri") !== issued.redirectUri ||
				form.get("client_id") !== issued.clientId ||
				form.get("resource") !== "https://api.openai.com/v1" ||
				createHash("sha256")
					.update(form.get("code_verifier") ?? "", "ascii")
					.digest("base64url") !== issued.challenge
			) {
				this.unmatched.push(`invalid token exchange ${bodyText}`);
				return this.response(400, { error: "scripted_mismatch" });
			}
			return this.response(200, {
				access_token: "access-token-test",
				refresh_token: "refresh-token-test",
				id_token: signedIdToken(issued.clientId, issued.nonce, {
					sub: this.subject,
				}),
				expires_in: 3600,
				scope:
					"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
			});
		}
		this.unmatched.push(`${request.method} ${request.url}`);
		return this.response(404, { error: "not_found" });
	}

	registerFreshClient(): string {
		this.registrationNumber += 1;
		return `registered-client-${this.registrationNumber}`;
	}

	private response(status: number, value: unknown): Result<HttpResponse> {
		return {
			ok: true,
			value: {
				status,
				headers: { "content-type": "application/json" },
				body: jsonBody(value),
			},
		};
	}
}

function loginOptions(
	filesystem: MemoryFileSystem,
	credentials: MemoryCredentials,
	http: FakeOAuthHttp,
	options: {
		readonly authorizationErrors?: ReadonlySet<number>;
		readonly progress?: string[];
	} = {},
) {
	let authorizationCount = 0;
	return {
		filesystem,
		credentials,
		http,
		random: new TestRandom(),
		clock: new TestClock(),
		homeDirectory: "/test-home",
		label: "default",
		authUrl: "http://oauth.test",
		progress: (line: string) => options.progress?.push(line),
		openBrowser: async (authorizationUrl: string): Promise<Result<void>> => {
			authorizationCount += 1;
			const authorization = new URL(authorizationUrl);
			http.events.push({
				kind: "authorize",
				url: authorization.origin + authorization.pathname,
				body: authorization.searchParams.toString(),
			});
			const query = authorization.searchParams;
			const requestedClient = query.get("client_id") ?? "";
			const state = query.get("state") ?? "";
			const nonce = query.get("nonce") ?? "";
			const redirectUri = query.get("redirect_uri") ?? "";
			const code = `auth-code-${authorizationCount}`;
			const clientId =
				requestedClient === "dynamic_agent_client"
					? http.registerFreshClient()
					: requestedClient;
			const callback = new URL(redirectUri);
			callback.searchParams.set("state", state);
			if (options.authorizationErrors?.has(authorizationCount)) {
				callback.searchParams.set("error", "3p_login_workspace_scope_denied");
			} else {
				callback.searchParams.set("code", code);
				if (requestedClient === "dynamic_agent_client")
					callback.searchParams.set("client_id", clientId);
				http.recordAuthorization(code, {
					clientId,
					challenge: query.get("code_challenge") ?? "",
					nonce,
					redirectUri,
				});
			}
			const callbackResponse = await fetch(callback);
			if (options.authorizationErrors?.has(authorizationCount)) {
				expect(callbackResponse.status).toBe(200);
				expect(await callbackResponse.text()).toBe(
					CHATGPT_CALLBACK_FAILURE_TEXT,
				);
			} else {
				expect(callbackResponse.status).toBe(200);
			}
			return { ok: true, value: undefined };
		},
	};
}

test("failed state callback responds safely and releases port 1455", async () => {
	const listenerResult = await listenForChatGptCallback({
		expectedState: "expected-state",
		port: CHATGPT_LOOPBACK_PORT,
		timeoutMilliseconds: 1000,
	});
	expect(listenerResult.ok).toBe(true);
	if (!listenerResult.ok) return;
	const response = await fetch(
		`http://127.0.0.1:${CHATGPT_LOOPBACK_PORT}/auth/callback?state=wrong&code=not-used`,
	);
	expect(response.status).toBe(400);
	expect(await response.text()).toBe(CHATGPT_CALLBACK_FAILURE_TEXT);
	const callback = await listenerResult.value.result;
	expect(callback.ok).toBe(false);
	await listenerResult.value.close();
});

test("PKCE login reuses loopback 1455 and repairs a rejected saved client once", async () => {
	const filesystem = new MemoryFileSystem();
	const credentials = new MemoryCredentials();
	const http = new FakeOAuthHttp();
	const progress: string[] = [];
	const options = loginOptions(filesystem, credentials, http, { progress });

	const first = await loginChatGpt(options);
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	expect(first.value.client_id).toBe("registered-client-1");
	expect(first.value.scopes).toContain("chatgpt.tokens.use.direct");
	expect(first.value.host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u);
	expect(filesystem.writes.some((write) => write.path === "host.json")).toBe(
		true,
	);
	const firstDiscovery = new URL(
		http.events.find((event) => event.kind === "discovery")?.url ??
			"http://invalid",
	);
	expect(firstDiscovery.pathname).toBe("/.well-known/openid-configuration");

	const second = await loginChatGpt(options);
	expect(second.ok).toBe(true);
	if (!second.ok) return;
	expect(second.value.client_id).toBe("registered-client-1");

	const repairOptions = loginOptions(filesystem, credentials, http, {
		authorizationErrors: new Set([1]),
		progress,
	});
	const repaired = await loginChatGpt(repairOptions);
	expect(repaired.ok).toBe(true);
	if (!repaired.ok) return;
	expect(repaired.value.client_id).toBe("registered-client-2");
	expect(progress).toContain(CHATGPT_LOGIN_RETRY_MESSAGE);

	const authorizations = http.events
		.filter((event) => event.kind === "authorize")
		.map((event) => new URLSearchParams(event.body));
	expect(authorizations).toHaveLength(4);
	expect(authorizations.map((params) => params.get("client_id"))).toEqual([
		"dynamic_agent_client",
		"registered-client-1",
		"registered-client-1",
		"dynamic_agent_client",
	]);
	expect(authorizations[0]?.get("agent_name_hint")).toBe("Kogen");
	expect(authorizations[3]?.get("agent_name_hint")).toBe("Kogen");
	expect(authorizations[0]?.get("scope")).toBe(
		"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
	);
	expect(authorizations[0]?.get("resource")).toBe("https://api.openai.com/v1");
	expect(authorizations[0]?.get("code_challenge_method")).toBe("S256");
	expect(authorizations[0]?.get("code_challenge")).toMatch(
		/^[A-Za-z0-9_-]{43}$/u,
	);
	expect(authorizations[0]?.get("state")).toBeTruthy();
	expect(authorizations[0]?.get("nonce")).toBeTruthy();
	expect(authorizations[0]?.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
	const tokenBodies = http.events
		.filter((event) => event.kind === "token")
		.map((event) => new URLSearchParams(event.body));
	expect(tokenBodies).toHaveLength(3);
	expect(tokenBodies[0]?.get("client_id")).toBe("registered-client-1");
	expect(tokenBodies[1]?.get("client_id")).toBe("registered-client-1");
	expect(tokenBodies[2]?.get("client_id")).toBe("registered-client-2");
	expect(http.unmatched).toEqual([]);

	const savedBytes = credentials.files.get(
		`${CHATGPT_CREDENTIAL_KEY.provider}/default/${CHATGPT_CREDENTIAL_KEY.name}`,
	);
	expect(savedBytes).toBeDefined();
	expect(
		JSON.parse(decoder.decode(savedBytes)) as ChatGptCredential,
	).toMatchObject({
		client_id: "registered-client-2",
		subject: "test-subject",
		email: "test@kogen.invalid",
	});
	expect(
		http.events.filter((event) => event.kind === "discovery"),
	).toHaveLength(4);
	expect(http.events.filter((event) => event.kind === "jwks")).toHaveLength(3);

	http.subject = "different-subject";
	const changedSubject = await loginChatGpt(options);
	expect(changedSubject.ok).toBe(false);
	expect(
		JSON.parse(decoder.decode(savedBytes)) as ChatGptCredential,
	).toMatchObject({
		client_id: "registered-client-2",
		subject: "test-subject",
	});
	expect(http.events.filter((event) => event.kind === "token")).toHaveLength(4);
	expect(http.events.filter((event) => event.kind === "jwks")).toHaveLength(4);
	expect(http.unmatched).toEqual([]);
});
