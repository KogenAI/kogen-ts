import { expect, test } from "bun:test";
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
	CHATGPT_CREDENTIAL_KEY,
	type ChatGptCredential,
} from "../../packages/core/src/provider/auth/chatgpt/login";
import { logoutChatGpt } from "../../packages/core/src/provider/auth/chatgpt/logout";
import {
	type ChatGptRefreshLockObservation,
	type ChatGptRefreshLockPort,
	type ChatGptRefreshOptions,
	chatGptAuthHeaders,
	refreshChatGptCredential,
	sendChatGptAuthenticatedRequest,
} from "../../packages/core/src/provider/auth/chatgpt/refresh";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NOW_MS = 1_800_000_000_000;
const AUTH_URL = "http://auth.test";

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function body(value: unknown): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield bytes(JSON.stringify(value));
		},
	};
}

function response(status: number, value: unknown): HttpResponse {
	return { status, headers: {}, body: body(value) };
}

function ok<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

function missing<Value>(): Result<Value> {
	return {
		ok: false,
		error: { code: "not_found", message: "missing", retryable: false },
	};
}

function testCredential(
	overrides: Partial<ChatGptCredential> = {},
): ChatGptCredential {
	return {
		client_id: "test-client",
		access_token: "old-access",
		refresh_token: "old-refresh",
		id_token: "old-id-token",
		expires_at: Math.floor(NOW_MS / 1000) + 100,
		scopes: ["chatgpt.tokens.use.direct"],
		subject: "test-subject",
		email: "test@kogen.invalid",
		host_id: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
		...overrides,
	};
}

class MemoryCredentials implements CredentialPort {
	readonly values = new Map<string, Uint8Array>();
	readCount = 0;
	writeCount = 0;
	removeCount = 0;
	readError: Result<Uint8Array> | null = null;

	private key(key: CredentialKey): string {
		return `${key.provider}:${key.account}:${key.name}`;
	}

	async read(key: CredentialKey): Promise<Result<Uint8Array>> {
		this.readCount += 1;
		if (this.readError !== null) return this.readError;
		const value = this.values.get(this.key(key));
		return value === undefined ? missing() : ok(value.slice());
	}

	async write(key: CredentialKey, value: Uint8Array): Promise<Result<void>> {
		this.writeCount += 1;
		this.values.set(this.key(key), value.slice());
		return ok(undefined);
	}

	async remove(key: CredentialKey): Promise<Result<void>> {
		this.removeCount += 1;
		this.values.delete(this.key(key));
		return ok(undefined);
	}

	put(value: ChatGptCredential): void {
		this.values.set(
			this.key({ ...CHATGPT_CREDENTIAL_KEY, account: "default" }),
			bytes(JSON.stringify(value)),
		);
	}

	stored(): ChatGptCredential | null {
		const value = this.values.get(
			this.key({ ...CHATGPT_CREDENTIAL_KEY, account: "default" }),
		);
		return value === undefined
			? null
			: (JSON.parse(decoder.decode(value)) as ChatGptCredential);
	}
}

class MemoryFileSystem
	implements Pick<FileSystemPort, "readFile" | "writeFileAtomically">
{
	readonly files = new Map<string, Uint8Array>();
	readonly writes: FileWriteRequest[] = [];

	private key(request: FileReadRequest | FileWriteRequest): string {
		return `${request.root}\0${request.path}`;
	}

	async readFile(request: FileReadRequest): Promise<Result<Uint8Array>> {
		const value = this.files.get(this.key(request));
		return value === undefined ? missing() : ok(value.slice());
	}

	async writeFileAtomically(request: FileWriteRequest): Promise<Result<void>> {
		this.writes.push({ ...request, bytes: request.bytes.slice() });
		this.files.set(this.key(request), request.bytes.slice());
		return ok(undefined);
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(`${root}\0${path}`)?.slice();
	}
}

class TestClock implements ClockPort {
	monotonicMilliseconds(): number {
		return performance.now();
	}

	unixMilliseconds(): number {
		return NOW_MS;
	}

	async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(done, milliseconds);
			function done(): void {
				signal?.removeEventListener("abort", abort);
				resolve();
			}
			function abort(): void {
				clearTimeout(timeout);
				reject(signal?.reason ?? new Error("aborted"));
			}
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
}

class TestRandom implements RandomPort {
	private value = 1;

	async bytes(length: number): Promise<Result<Uint8Array>> {
		const result = new Uint8Array(length).fill(this.value);
		this.value = (this.value % 200) + 1;
		return ok(result);
	}
}

interface LockRow {
	ownerBytes: Uint8Array | null;
	modifiedAt: number;
}

class MemoryRefreshLocks implements ChatGptRefreshLockPort {
	readonly rows = new Map<string, LockRow>();

	private key(root: string, path: string): string {
		return `${root}\0${path}`;
	}

	async tryCreateDirectory(
		root: string,
		path: string,
	): Promise<Result<"created" | "exists">> {
		const key = this.key(root, path);
		if (this.rows.has(key)) return ok("exists");
		this.rows.set(key, { ownerBytes: null, modifiedAt: NOW_MS });
		return ok("created");
	}

	async writeOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<void>> {
		const row = this.rows.get(this.key(root, path));
		if (row === undefined) return missing();
		row.ownerBytes = ownerBytes.slice();
		row.modifiedAt = NOW_MS;
		return ok(undefined);
	}

	async observe(
		root: string,
		path: string,
	): Promise<Result<ChatGptRefreshLockObservation>> {
		const row = this.rows.get(this.key(root, path));
		return row === undefined
			? missing()
			: ok({
					ownerBytes: row.ownerBytes?.slice() ?? null,
					directoryModifiedAtUnixMilliseconds: row.modifiedAt,
				});
	}

	async removeIfUnchanged(
		root: string,
		path: string,
		expected: ChatGptRefreshLockObservation,
	): Promise<Result<boolean>> {
		const key = this.key(root, path);
		const row = this.rows.get(key);
		if (
			row === undefined ||
			row.modifiedAt !== expected.directoryModifiedAtUnixMilliseconds ||
			!sameBytes(row.ownerBytes, expected.ownerBytes)
		)
			return ok(false);
		this.rows.delete(key);
		return ok(true);
	}

	async releaseIfOwner(
		root: string,
		path: string,
		ownerBytes: Uint8Array,
	): Promise<Result<boolean>> {
		const key = this.key(root, path);
		const row = this.rows.get(key);
		if (row === undefined || !sameBytes(row.ownerBytes, ownerBytes))
			return ok(false);
		this.rows.delete(key);
		return ok(true);
	}
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.byteLength === right.byteLength &&
		left.every((byte, index) => byte === right[index])
	);
}

class FakeAuthHttp implements HttpPort {
	readonly requests: HttpRequest[] = [];
	responseStatuses: number[] = [];
	refreshCount = 0;
	revokeCount = 0;
	refreshGate: Promise<void> | null = null;

	async request(request: HttpRequest): Promise<Result<HttpResponse>> {
		this.requests.push({
			...request,
			...(request.body === undefined ? {} : { body: request.body.slice() }),
			headers: { ...request.headers },
		});
		const url = new URL(request.url);
		if (url.pathname === "/.well-known/openid-configuration")
			return ok(
				response(200, {
					issuer: "https://auth.openai.com",
					token_endpoint: `${AUTH_URL}/api/accounts/oauth/token`,
					revocation_endpoint: `${AUTH_URL}/revoke`,
				}),
			);
		if (url.pathname === "/api/accounts/oauth/token") {
			this.refreshCount += 1;
			if (this.refreshGate !== null) await this.refreshGate;
			return ok(
				response(200, {
					access_token: `rotated-access-${this.refreshCount}`,
					refresh_token: `rotated-refresh-${this.refreshCount}`,
					id_token: `rotated-id-${this.refreshCount}`,
					expires_in: 3600,
					scope: "chatgpt.tokens.use.direct",
				}),
			);
		}
		if (url.pathname === "/revoke") {
			this.revokeCount += 1;
			return ok(response(200, {}));
		}
		if (url.pathname.endsWith("/responses")) {
			const status = this.responseStatuses.shift() ?? 200;
			return ok(
				response(
					status,
					status === 200 ? { result: "ok" } : { error: "denied" },
				),
			);
		}
		return ok(response(404, {}));
	}
}

function refreshFixture(overrides: Partial<ChatGptRefreshOptions> = {}): {
	readonly options: ChatGptRefreshOptions;
	readonly credentials: MemoryCredentials;
	readonly locks: MemoryRefreshLocks;
	readonly filesystem: MemoryFileSystem;
	readonly http: FakeAuthHttp;
} {
	const credentials = new MemoryCredentials();
	credentials.put(testCredential());
	const locks = new MemoryRefreshLocks();
	const filesystem = new MemoryFileSystem();
	const http = new FakeAuthHttp();
	const options: ChatGptRefreshOptions = {
		credentials,
		locks,
		http,
		random: new TestRandom(),
		clock: new TestClock(),
		homeDirectory: "/tmp/kogen-chatgpt-refresh-test",
		label: "default",
		authUrl: AUTH_URL,
		...overrides,
	};
	return { options, credentials, locks, filesystem, http };
}

function responseRequest(): HttpRequest {
	return {
		method: "POST",
		url: "https://api.openai.com/v1/responses",
		headers: { "session-id": "cache-key", "thread-id": "thread-id" },
		body: bytes('{"input":[{"type":"message"}]}'),
		firstByteTimeoutMilliseconds: 120_000,
		idleTimeoutMilliseconds: 90_000,
		totalTimeoutMilliseconds: 1_200_000,
	};
}

test("concurrent expiring-token refreshes reread and rotate only once", async () => {
	const { options, credentials, http } = refreshFixture();
	let releaseRefresh: () => void = () => {};
	http.refreshGate = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	const first = refreshChatGptCredential(options);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const second = refreshChatGptCredential(options);
	await new Promise((resolve) => setTimeout(resolve, 20));
	releaseRefresh();
	const results = await Promise.all([first, second]);
	expect(results.every((result) => result.ok)).toBe(true);
	if (!results[0]?.ok || !results[1]?.ok) throw new Error("refresh failed");
	expect(http.refreshCount).toBe(1);
	expect(results[0].value.credential.access_token).toBe("rotated-access-1");
	expect(results[1].value.credential.access_token).toBe("rotated-access-1");
	expect(credentials.stored()?.refresh_token).toBe("rotated-refresh-1");
	expect(credentials.writeCount).toBe(1);
});

test("owned 401 refreshes once and replays the same body with owned headers", async () => {
	const credentials = new MemoryCredentials();
	const credential = testCredential({
		expires_at: Math.floor(NOW_MS / 1000) + 3600,
	});
	credentials.put(credential);
	const { options, http } = refreshFixture({ credentials });
	http.responseStatuses = [401, 200];
	const result = await sendChatGptAuthenticatedRequest({
		http,
		request: responseRequest(),
		auth: { source: "owned", credential },
		refresh: options,
	});
	expect(result.ok).toBe(true);
	expect(http.refreshCount).toBe(1);
	const responses = http.requests.filter((request) =>
		request.url.endsWith("/responses"),
	);
	expect(responses).toHaveLength(2);
	expect([...(responses[0]?.body ?? [])]).toEqual([
		...(responses[1]?.body ?? []),
	]);
	expect(responses[0]?.headers.authorization).toBe("Bearer old-access");
	expect(responses[1]?.headers.authorization).toBe("Bearer rotated-access-1");
	expect(responses[1]?.headers["user-agent"]).toBe("kogen/0.1");
	expect(responses[1]?.headers["session-id"]).toBe("cache-key");
	expect(responses[1]?.headers["thread-id"]).toBe("thread-id");
});

test("injected 401 is a provider login outcome without credential reads or refresh", async () => {
	const { credentials, http } = refreshFixture();
	http.responseStatuses = [401];
	const result = await sendChatGptAuthenticatedRequest({
		http,
		request: responseRequest(),
		auth: {
			source: "injected",
			accessToken: "injected-access",
			accountId: "acct-1",
		},
	});
	expect(result).toEqual({
		ok: false,
		error: {
			kind: "provider_login",
			message: "Codex login is missing, invalid, or expired.",
		},
	});
	expect(credentials.readCount).toBe(0);
	expect(http.refreshCount).toBe(0);
	expect(
		chatGptAuthHeaders(
			{
				source: "injected",
				accessToken: "injected-access",
				accountId: "acct-1",
			},
			"abc123",
		),
	).toEqual({
		authorization: "Bearer injected-access",
		"chatgpt-account-id": "acct-1",
		"openai-beta": "responses=experimental",
		originator: "kogen",
		"user-agent": "kogen/abc123",
	});
});

test("403 is a provider login outcome and does not force a refresh", async () => {
	const credentials = new MemoryCredentials();
	const credential = testCredential({
		expires_at: Math.floor(NOW_MS / 1000) + 3600,
	});
	credentials.put(credential);
	const { options, http } = refreshFixture({ credentials });
	http.responseStatuses = [403];
	const result = await sendChatGptAuthenticatedRequest({
		http,
		request: responseRequest(),
		auth: { source: "owned", credential },
		refresh: options,
	});
	expect(result).toEqual({
		ok: false,
		error: {
			kind: "provider_login",
			message: "ChatGPT rejected the login; sign in again.",
		},
	});
	expect(http.refreshCount).toBe(0);
});

test("a held refresh lock times out within the scaled bound", async () => {
	const { options, locks, http } = refreshFixture({ timeScale: 0.001 });
	locks.rows.set(
		"/tmp/kogen-chatgpt-refresh-test/.kogen\0locks/chatgpt-default.lock",
		{
			ownerBytes: bytes("123 1800000000000 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
			modifiedAt: NOW_MS,
		},
	);
	const started = performance.now();
	const result = await refreshChatGptCredential(options);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected bounded lock wait to time out");
	expect(result.error.kind).toBe("port");
	if (result.error.kind === "port")
		expect(result.error.error.code).toBe("timeout");
	expect(performance.now() - started).toBeLessThan(1000);
	expect(http.refreshCount).toBe(0);
});

test("logout removes an unreadable credential and records local sign-out", async () => {
	const { options, credentials, filesystem, http } = refreshFixture();
	credentials.readError = {
		ok: false,
		error: {
			code: "permission_denied",
			message: "unreadable",
			retryable: false,
		},
	};
	filesystem.files.set(
		"/tmp/kogen-chatgpt-refresh-test/.kogen\0profiles.json",
		bytes(
			JSON.stringify({
				chatgpt: {
					default: {
						client_id: "test-client",
						subject: "test-subject",
						email: "test@kogen.invalid",
						expires_at: 1_800_000_100,
						signed_in: true,
						plan_usage: null,
						notice_shown: false,
						remote_revoked: false,
					},
				},
			}),
		),
	);
	const result = await logoutChatGpt({
		credentials,
		filesystem,
		http,
		homeDirectory: options.homeDirectory,
		label: "default",
		authUrl: AUTH_URL,
	});
	expect(result).toEqual({
		ok: true,
		value: {
			remoteRevocationConfirmed: false,
			recoveredUnreadableCredential: true,
		},
	});
	expect(credentials.removeCount).toBe(1);
	expect(http.revokeCount).toBe(0);
	const savedProfiles = filesystem.get(
		"/tmp/kogen-chatgpt-refresh-test/.kogen",
		"profiles.json",
	);
	const profiles = JSON.parse(decoder.decode(savedProfiles ?? bytes("{}"))) as {
		chatgpt: { default: { signed_in: boolean } };
	};
	expect(profiles.chatgpt.default.signed_in).toBe(false);
});

test("logout revokes before deleting a readable credential", async () => {
	const credentials = new MemoryCredentials();
	credentials.put(
		testCredential({ expires_at: Math.floor(NOW_MS / 1000) + 3600 }),
	);
	const { options, filesystem, http } = refreshFixture({ credentials });
	const result = await logoutChatGpt({
		credentials,
		filesystem,
		http,
		homeDirectory: options.homeDirectory,
		label: "default",
		authUrl: AUTH_URL,
	});
	expect(result.ok).toBe(true);
	expect(http.revokeCount).toBe(1);
	expect(credentials.stored()).toBeNull();
	expect(
		http.requests.find((request) => request.url.endsWith("/revoke"))?.body,
	).toBeDefined();
});
