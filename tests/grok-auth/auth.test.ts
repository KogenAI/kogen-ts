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
	GROK_AUTH_DISCOVERY_URL,
	GROK_CLIENT_ID,
	GROK_CREDENTIAL_KEY,
	GROK_DEFAULT_DEVICE_ENDPOINT,
	GROK_DEVICE_CODE_GRANT,
	GROK_LOGIN_SCOPES,
	type GrokCredential,
	type GrokLoginOptions,
	loginGrok,
} from "../../packages/core/src/provider/auth/grok/login";
import { logoutGrok } from "../../packages/core/src/provider/auth/grok/logout";
import {
	GROK_REFRESH_LOCK_STALE_MILLISECONDS,
	type GrokRefreshLockObservation,
	type GrokRefreshLockPort,
	type GrokRefreshOptions,
	refreshGrokCredential,
} from "../../packages/core/src/provider/auth/grok/refresh";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const NOW_MS = 1_800_000_000_000;
const HOME = "/tmp/kogen-grok-auth-test";
const KOGEN_ROOT = `${HOME}/.kogen`;
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const DEVICE_ENDPOINT = "https://auth.x.ai/oauth2/device/code";

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

function credential(overrides: Partial<GrokCredential> = {}): GrokCredential {
	return {
		access_token: "old-access",
		refresh_token: "old-refresh",
		expires_at: Math.floor(NOW_MS / 1000) + 100,
		scopes: ["openid", "profile", "email", "offline_access"],
		email: "grok@example.test",
		client_id: GROK_CLIENT_ID,
		token_endpoint: TOKEN_ENDPOINT,
		...overrides,
	};
}

class MemoryCredentials implements CredentialPort {
	readonly values = new Map<string, Uint8Array>();
	readCount = 0;
	writeCount = 0;
	removeCount = 0;
	removeError: Result<void> | null = null;

	private key(key: CredentialKey): string {
		return `${key.provider}:${key.account}:${key.name}`;
	}

	async read(key: CredentialKey): Promise<Result<Uint8Array>> {
		this.readCount += 1;
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
		if (this.removeError !== null) return this.removeError;
		if (!this.values.has(this.key(key))) return missing();
		this.values.delete(this.key(key));
		return ok(undefined);
	}

	put(value: GrokCredential, label = "default"): void {
		this.values.set(
			this.key({ ...GROK_CREDENTIAL_KEY, account: label }),
			bytes(JSON.stringify(value)),
		);
	}

	stored(label = "default"): GrokCredential | null {
		const value = this.values.get(
			this.key({ ...GROK_CREDENTIAL_KEY, account: label }),
		);
		return value === undefined
			? null
			: (JSON.parse(decoder.decode(value)) as GrokCredential);
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

	seed(path: string, value: unknown): void {
		this.files.set(`${KOGEN_ROOT}\0${path}`, bytes(JSON.stringify(value)));
	}

	get(path: string): Uint8Array | undefined {
		return this.files.get(`${KOGEN_ROOT}\0${path}`)?.slice();
	}
}

class InstantClock implements ClockPort {
	monotonic = 10_000;
	readonly sleeps: number[] = [];

	monotonicMilliseconds(): number {
		return this.monotonic;
	}

	unixMilliseconds(): number {
		return NOW_MS;
	}

	async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason;
		this.sleeps.push(milliseconds);
		this.monotonic += milliseconds;
	}
}

class RefreshClock implements ClockPort {
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

class FakeHttp implements HttpPort {
	readonly requests: HttpRequest[] = [];
	readonly order: string[] = [];
	readonly unmatched: HttpRequest[] = [];
	constructor(
		private readonly handler: (
			request: HttpRequest,
		) => HttpResponse | Promise<HttpResponse | undefined> | undefined,
	) {}

	async request(request: HttpRequest): Promise<Result<HttpResponse>> {
		const saved = {
			...request,
			headers: { ...request.headers },
			...(request.body === undefined ? {} : { body: request.body.slice() }),
		};
		this.requests.push(saved);
		this.order.push(`${request.method} ${new URL(request.url).pathname}`);
		const result = await this.handler(saved);
		if (result === undefined) {
			this.unmatched.push(saved);
			return ok(response(599, { error: "unmatched" }));
		}
		return ok(result);
	}
}

function deviceResponse(overrides: Record<string, unknown> = {}): HttpResponse {
	return response(200, {
		device_code: "device-code-test",
		user_code: "ABCD-EFGH",
		verification_uri: "https://grok.com/activate",
		expires_in: 120,
		interval: 2,
		...overrides,
	});
}

function tokenResponse(overrides: Record<string, unknown> = {}): HttpResponse {
	return response(200, {
		access_token: "access-from-device",
		refresh_token: "refresh-from-device",
		expires_in: 3600,
		scope: GROK_LOGIN_SCOPES,
		email: "grok@example.test",
		...overrides,
	});
}

function loginOptions(
	overrides: Partial<GrokLoginOptions> = {},
): GrokLoginOptions & {
	filesystem: MemoryFileSystem;
	credentials: MemoryCredentials;
	http: FakeHttp;
	clock: InstantClock;
} {
	const filesystem = new MemoryFileSystem();
	const credentials = new MemoryCredentials();
	const clock = new InstantClock();
	const http = new FakeHttp(() => undefined);
	return {
		filesystem,
		credentials,
		http,
		clock,
		homeDirectory: HOME,
		label: "default",
		...overrides,
	} as GrokLoginOptions & {
		filesystem: MemoryFileSystem;
		credentials: MemoryCredentials;
		http: FakeHttp;
		clock: InstantClock;
	};
}

function parsedForm(request: HttpRequest): URLSearchParams {
	return new URLSearchParams(decoder.decode(request.body ?? new Uint8Array()));
}

test("P10 device login waits before every poll and prints the code before polling", async () => {
	const filesystem = new MemoryFileSystem();
	const credentials = new MemoryCredentials();
	const clock = new InstantClock();
	let poll = 0;
	const http = new FakeHttp((request) => {
		if (request.method === "GET" && request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				device_authorization_endpoint: DEVICE_ENDPOINT,
				token_endpoint: TOKEN_ENDPOINT,
			});
		if (request.method === "POST" && request.url === DEVICE_ENDPOINT)
			return deviceResponse({
				verification_uri_complete:
					"https://grok.com/activate?user_code=ABCD-EFGH",
			});
		if (request.method === "POST" && request.url === TOKEN_ENDPOINT) {
			poll += 1;
			return poll === 1
				? response(400, { error: "authorization_pending" })
				: poll === 2
					? response(400, { error: "slow_down" })
					: tokenResponse();
		}
		return undefined;
	});
	const order = http.order;
	const result = await loginGrok({
		filesystem,
		credentials,
		http,
		clock,
		homeDirectory: HOME,
		label: "default",
		progress(line) {
			order.push(line.trimEnd());
		},
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Grok device login failed");
	expect(result.value).toEqual(
		credential({
			access_token: "access-from-device",
			refresh_token: "refresh-from-device",
			expires_at: Math.floor(NOW_MS / 1000) + 3600,
			scopes: GROK_LOGIN_SCOPES.split(" "),
			email: "grok@example.test",
		}),
	);
	expect(clock.sleeps).toEqual([2000, 2000, 7000]);
	expect(order).toEqual([
		"GET /.well-known/openid-configuration",
		"POST /oauth2/device/code",
		"Grok sign-in code: ABCD-EFGH",
		"Open: https://grok.com/activate?user_code=ABCD-EFGH",
		"POST /oauth2/token",
		"POST /oauth2/token",
		"POST /oauth2/token",
	]);
	expect(http.unmatched).toHaveLength(0);
	const deviceRequest = http.requests[1];
	expect(deviceRequest?.headers["content-type"]).toBe(
		"application/x-www-form-urlencoded",
	);
	expect(parsedForm(deviceRequest as HttpRequest).get("client_id")).toBe(
		GROK_CLIENT_ID,
	);
	expect(parsedForm(deviceRequest as HttpRequest).get("scope")).toBe(
		GROK_LOGIN_SCOPES,
	);
	for (const request of http.requests) {
		expect(request.firstByteTimeoutMilliseconds).toBe(20_000);
		expect(request.idleTimeoutMilliseconds).toBe(20_000);
		expect(request.totalTimeoutMilliseconds).toBe(20_000);
	}
	const firstPoll = http.requests[2];
	expect(parsedForm(firstPoll as HttpRequest)).toEqual(
		new URLSearchParams({
			grant_type: GROK_DEVICE_CODE_GRANT,
			device_code: "device-code-test",
			client_id: GROK_CLIENT_ID,
		}),
	);
	expect(http.order.indexOf("POST /oauth2/token")).toBeGreaterThan(-1);
	expect(credentials.stored()).toEqual(result.value);
	const profile = JSON.parse(
		decoder.decode(filesystem.get("profiles.json") ?? bytes("{}")),
	) as {
		grok: {
			default: { email: string | null; expires_at: number; signed_in: boolean };
		};
	};
	expect(profile.grok.default).toEqual({
		email: "grok@example.test",
		expires_at: result.value.expires_at,
		signed_in: true,
	});
});

test("P10 omitted device endpoint falls back and missing interval waits five seconds", async () => {
	const fixture = loginOptions();
	const http = new FakeHttp((request) => {
		if (request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				token_endpoint: TOKEN_ENDPOINT,
			});
		if (request.url === GROK_DEFAULT_DEVICE_ENDPOINT)
			return deviceResponse({ interval: undefined });
		if (request.url === TOKEN_ENDPOINT) return tokenResponse();
		return undefined;
	});
	const result = await loginGrok({ ...fixture, http });
	expect(result.ok).toBe(true);
	expect(fixture.clock.sleeps).toEqual([5000]);
	expect(http.order).toEqual([
		"GET /.well-known/openid-configuration",
		"POST /oauth2/device/code",
		"POST /oauth2/token",
	]);
	expect(http.unmatched).toHaveLength(0);
});

test("P10 rejects HTTP and userinfo authorization endpoints before device requests", async () => {
	for (const [field, endpoint] of [
		["token_endpoint", "http://auth.x.ai/oauth2/token"],
		["token_endpoint", "https://attacker:secret@auth.x.ai/oauth2/token"],
		["device_authorization_endpoint", "http://auth.x.ai/oauth2/device/code"],
		[
			"device_authorization_endpoint",
			"https://attacker:secret@auth.x.ai/oauth2/device/code",
		],
	] as const) {
		const fixture = loginOptions();
		const http = new FakeHttp((request) => {
			if (request.url === GROK_AUTH_DISCOVERY_URL)
				return response(200, {
					issuer: "https://auth.x.ai",
					token_endpoint:
						field === "token_endpoint" ? endpoint : TOKEN_ENDPOINT,
					...(field === "device_authorization_endpoint"
						? { device_authorization_endpoint: endpoint }
						: {}),
				});
			return undefined;
		});
		const result = await loginGrok({ ...fixture, http });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("invalid endpoint was accepted");
		expect(result.error).toEqual({
			kind: "provider_login",
			message: "Grok returned an invalid sign-in endpoint.",
		});
		expect(http.requests).toHaveLength(1);
		expect(http.unmatched).toHaveLength(0);
	}
});

test("P10 rejects line breaks in the displayed verification URI", async () => {
	const fixture = loginOptions();
	const progress: string[] = [];
	const http = new FakeHttp((request) => {
		if (request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				token_endpoint: TOKEN_ENDPOINT,
				device_authorization_endpoint: DEVICE_ENDPOINT,
			});
		if (request.url === DEVICE_ENDPOINT)
			return deviceResponse({
				verification_uri_complete: "https://grok.com/activate\nlogin elsewhere",
			});
		return undefined;
	});
	const result = await loginGrok({
		...fixture,
		http,
		progress(line) {
			progress.push(line);
		},
	});
	expect(result).toEqual({
		ok: false,
		error: {
			kind: "provider_login",
			message: "Grok returned an invalid device sign-in response.",
		},
	});
	expect(progress).toEqual([]);
	expect(http.requests).toHaveLength(2);
	expect(http.unmatched).toHaveLength(0);
});

test("P10 interval zero waits one second and expired_token reports the retry instruction", async () => {
	const fixture = loginOptions();
	const http = new FakeHttp((request) => {
		if (request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				token_endpoint: TOKEN_ENDPOINT,
				device_authorization_endpoint: DEVICE_ENDPOINT,
			});
		if (request.url === DEVICE_ENDPOINT) return deviceResponse({ interval: 0 });
		if (request.url === TOKEN_ENDPOINT)
			return response(400, { error: "expired_token" });
		return undefined;
	});
	const result = await loginGrok({ ...fixture, http });
	expect(result).toEqual({
		ok: false,
		error: {
			kind: "provider_login",
			message:
				"Grok sign-in code expired; run `kogen provider login grok` again.",
		},
	});
	expect(fixture.clock.sleeps).toEqual([1000]);
	expect(http.unmatched).toHaveLength(0);
});

test("P10 expiry bounds the first poll even when the interval is longer", async () => {
	const fixture = loginOptions();
	const http = new FakeHttp((request) => {
		if (request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				device_authorization_endpoint: DEVICE_ENDPOINT,
				token_endpoint: TOKEN_ENDPOINT,
			});
		if (request.url === DEVICE_ENDPOINT)
			return deviceResponse({ expires_in: 3, interval: 5 });
		return undefined;
	});
	const result = await loginGrok({ ...fixture, http });
	expect(result).toEqual({
		ok: false,
		error: {
			kind: "provider_login",
			message:
				"Grok sign-in code expired; run `kogen provider login grok` again.",
		},
	});
	expect(fixture.clock.sleeps).toEqual([3000]);
	expect(http.requests).toHaveLength(2);
	expect(http.unmatched).toHaveLength(0);
});

test("P10 access_denied maps to the single cancellation outcome", async () => {
	const fixture = loginOptions();
	const http = new FakeHttp((request) => {
		if (request.url === GROK_AUTH_DISCOVERY_URL)
			return response(200, {
				issuer: "https://auth.x.ai",
				token_endpoint: TOKEN_ENDPOINT,
				device_authorization_endpoint: DEVICE_ENDPOINT,
			});
		if (request.url === DEVICE_ENDPOINT) return deviceResponse();
		if (request.url === TOKEN_ENDPOINT)
			return response(400, { error: "access_denied" });
		return undefined;
	});
	const result = await loginGrok({ ...fixture, http });
	expect(result).toEqual({
		ok: false,
		error: { kind: "provider_login", message: "Grok sign-in was cancelled." },
	});
	expect(http.unmatched).toHaveLength(0);
});

interface LockRow {
	ownerBytes: Uint8Array | null;
	modifiedAt: number;
}

class MemoryRefreshLocks implements GrokRefreshLockPort {
	readonly rows = new Map<string, LockRow>();
	removeCount = 0;

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
	): Promise<Result<GrokRefreshLockObservation>> {
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
		expected: GrokRefreshLockObservation,
	): Promise<Result<boolean>> {
		const key = this.key(root, path);
		const row = this.rows.get(key);
		if (
			row === undefined ||
			row.modifiedAt !== expected.directoryModifiedAtUnixMilliseconds ||
			!sameBytes(row.ownerBytes, expected.ownerBytes)
		)
			return ok(false);
		this.removeCount += 1;
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

function refreshOptions(
	overrides: Partial<GrokRefreshOptions> = {},
): GrokRefreshOptions & {
	credentials: MemoryCredentials;
	filesystem: MemoryFileSystem;
	locks: MemoryRefreshLocks;
	clock: RefreshClock;
	http: FakeHttp;
} {
	const credentials = new MemoryCredentials();
	credentials.put(credential());
	const filesystem = new MemoryFileSystem();
	const locks = new MemoryRefreshLocks();
	const clock = new RefreshClock();
	const http = new FakeHttp(() => undefined);
	return {
		credentials,
		filesystem,
		locks,
		clock,
		http,
		random: new TestRandom(),
		homeDirectory: HOME,
		label: "default",
		...overrides,
	} as GrokRefreshOptions & {
		credentials: MemoryCredentials;
		filesystem: MemoryFileSystem;
		locks: MemoryRefreshLocks;
		clock: RefreshClock;
		http: FakeHttp;
	};
}

test("refresh takes over a stale Grok lock and persists rotated tokens before return", async () => {
	const credentials = new MemoryCredentials();
	credentials.put(credential());
	const locks = new MemoryRefreshLocks();
	const oldOwner = bytes(
		`123 ${NOW_MS - GROK_REFRESH_LOCK_STALE_MILLISECONDS - 1} AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
	);
	locks.rows.set(`${KOGEN_ROOT}\0locks/grok-default.lock`, {
		ownerBytes: oldOwner,
		modifiedAt: NOW_MS - GROK_REFRESH_LOCK_STALE_MILLISECONDS - 1,
	});
	const filesystem = new MemoryFileSystem();
	const http = new FakeHttp((request) => {
		if (request.url !== TOKEN_ENDPOINT) return undefined;
		const form = parsedForm(request);
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("client_id")).toBe(GROK_CLIENT_ID);
		expect(form.get("refresh_token")).toBe("old-refresh");
		return response(200, {
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_in: 3600,
		});
	});
	const fixture = refreshOptions({ credentials, locks, filesystem, http });
	const result = await refreshGrokCredential(fixture);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Grok refresh failed");
	expect(result.value).toEqual({
		credential: credential({
			access_token: "rotated-access",
			refresh_token: "rotated-refresh",
			expires_at: Math.floor(NOW_MS / 1000) + 3600,
		}),
		refreshed: true,
	});
	expect(credentials.stored()?.refresh_token).toBe("rotated-refresh");
	expect(locks.removeCount).toBe(1);
	expect(locks.rows.size).toBe(0);
	expect(http.unmatched).toHaveLength(0);
});

test("concurrent Grok refreshes reread rotated credentials and send one refresh grant", async () => {
	let releaseRefresh = () => {};
	let notifyEntered = () => {};
	const http = new FakeHttp(async (request) => {
		if (request.url !== TOKEN_ENDPOINT) return undefined;
		notifyEntered();
		await new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		return response(200, {
			access_token: "once-rotated",
			refresh_token: "once-rotated-refresh",
			expires_in: 3600,
		});
	});
	const entered = new Promise<void>((resolve) => {
		notifyEntered = resolve;
	});
	const fixture = refreshOptions({ http });
	const first = refreshGrokCredential(fixture);
	await entered;
	const second = refreshGrokCredential(fixture);
	await new Promise((resolve) => setTimeout(resolve, 40));
	releaseRefresh();
	const results = await Promise.all([first, second]);
	expect(results.every((result) => result.ok)).toBe(true);
	if (!results[0]?.ok || !results[1]?.ok)
		throw new Error("concurrent Grok refresh failed");
	expect(http.requests).toHaveLength(1);
	expect(fixture.credentials.writeCount).toBe(1);
	expect(results[0].value.credential.access_token).toBe("once-rotated");
	expect(results[1].value.credential.access_token).toBe("once-rotated");
	expect(results[0].value.refreshed).toBe(true);
	expect(results[1].value.refreshed).toBe(false);
	expect(http.unmatched).toHaveLength(0);
});

test("401 refresh is skipped when the saved access token already rotated", async () => {
	const fixture = refreshOptions();
	fixture.credentials.put(
		credential({
			access_token: "current-access",
			expires_at: Math.floor(NOW_MS / 1000) + 3600,
		}),
	);
	const result = await refreshGrokCredential(fixture, {
		kind: "unauthorized",
		rejectedAccessToken: "old-access",
	});
	expect(result).toEqual({
		ok: true,
		value: {
			credential: credential({
				access_token: "current-access",
				expires_at: Math.floor(NOW_MS / 1000) + 3600,
			}),
			refreshed: false,
		},
	});
	expect(fixture.http.requests).toHaveLength(0);
});

test("P10 logout removes only local credentials and marks the profile signed out", async () => {
	const credentials = new MemoryCredentials();
	credentials.put(credential({ expires_at: 1_900_000_000 }));
	const filesystem = new MemoryFileSystem();
	filesystem.seed("profiles.json", {
		grok: {
			default: {
				email: "grok@example.test",
				expires_at: 1_900_000_000,
				signed_in: true,
			},
		},
	});
	const result = await logoutGrok({
		credentials,
		filesystem,
		homeDirectory: HOME,
		label: "default",
	});
	expect(result).toEqual({
		ok: true,
		value: { localCredentialRemoved: true },
	});
	expect(credentials.stored()).toBeNull();
	const profiles = JSON.parse(
		decoder.decode(filesystem.get("profiles.json") ?? bytes("{}")),
	) as {
		grok: {
			default: { email: string | null; expires_at: number; signed_in: boolean };
		};
	};
	expect(profiles.grok.default).toEqual({
		email: "grok@example.test",
		expires_at: 1_900_000_000,
		signed_in: false,
	});
});

test("P10 logout records a signed-out profile when no credential exists", async () => {
	const credentials = new MemoryCredentials();
	const filesystem = new MemoryFileSystem();
	const result = await logoutGrok({
		credentials,
		filesystem,
		homeDirectory: HOME,
		label: "default",
	});
	expect(result).toEqual({
		ok: true,
		value: { localCredentialRemoved: false },
	});
	const profiles = JSON.parse(
		decoder.decode(filesystem.get("profiles.json") ?? bytes("{}")),
	) as {
		grok: {
			default: {
				email: string | null;
				expires_at: number | null;
				signed_in: boolean;
			};
		};
	};
	expect(profiles.grok.default).toEqual({
		email: null,
		expires_at: null,
		signed_in: false,
	});
});
