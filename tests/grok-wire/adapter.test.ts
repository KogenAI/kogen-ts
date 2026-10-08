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
	type ModelRole,
	type RoleValue,
	resolveRoles,
} from "../../packages/core/src/project/roles";
import type { AccountsDocument } from "../../packages/core/src/provider/accounts/format";
import { resolveAccountSelection } from "../../packages/core/src/provider/accounts/select";
import {
	GROK_CLIENT_ID,
	GROK_CREDENTIAL_KEY,
	type GrokCredential,
} from "../../packages/core/src/provider/auth/grok/login";
import type { GrokRefreshLockPort } from "../../packages/core/src/provider/auth/grok/refresh";
import {
	createGrokAttemptSender,
	GROK_RESPONSES_ENDPOINT,
	mapGrokHttpFailure,
} from "../../packages/core/src/provider/grok/adapter";
import { HttpDeadlineError } from "../../packages/core/src/provider/http/deadline";
import { StickyRoutingContext } from "../../packages/core/src/provider/http/routing";
import { HttpTransport } from "../../packages/core/src/provider/http/transport";
import { respondWithRetry } from "../../packages/core/src/provider/retry/respond";
import {
	type CreateSessionInput,
	createSession,
	type SessionState,
	stepSession,
} from "../../packages/core/src/provider/session/transition";
import {
	encodeSessionRequest,
	hasAppendedInputPrefix,
} from "../../packages/core/src/provider/session/wire";
import { MAX_SSE_BODY_BYTES } from "../../packages/core/src/provider/sse/framing";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const toolSchemas = [
	{
		type: "function",
		name: "write",
		description: "Write an approved file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
		strict: false,
	},
] as const;

const authorization = {
	builder: ["write"],
	planner: [],
	shaper: ["write"],
	auditor: [],
	reviewer: [],
	context: [],
} as const;

function sessionInput(
	overrides: Partial<CreateSessionInput> = {},
): CreateSessionInput {
	return {
		runDirectory: "/tmp/kogen-grok/run-54",
		provider: "grok",
		authMode: "owned",
		role: "builder",
		model: "grok-4.6",
		effort: "high",
		stage: "build",
		attempt: "builder",
		rung: "R1",
		roleInstructions: "You are Kogen's builder.",
		genericInstructions: "Use the approved Kogen provider protocol.",
		toolSchemas,
		toolSchemaVersion: "grok-wire-tools-v1",
		promptVersion: "grok-wire-prompt-v1",
		adapterVersion: "grok-wire-responses-v1",
		roleToolAuthorization: authorization,
		initialItems: [
			{
				kind: "message",
				bytes: encoder.encode(
					'{"role":"user","content":[{"type":"input_text","text":"implement the request"}]}',
				),
			},
		],
		...overrides,
	};
}

function session(overrides: Partial<CreateSessionInput> = {}): SessionState {
	return createSession(sessionInput(overrides));
}

function messageItem(text: string): Record<string, unknown> {
	return {
		id: "msg_assistant_1",
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	};
}

function sseResponse(
	output: readonly Record<string, unknown>[] = [messageItem("done")],
	usage: unknown = {
		input_tokens: 120,
		input_tokens_details: { cached_tokens: 60 },
		cache_write_tokens: 10,
		output_tokens: 15,
		output_tokens_details: { reasoning_tokens: 5 },
	},
): HttpResponse {
	const data = JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_grok_1",
			status: "completed",
			output,
			usage,
		},
	});
	return {
		status: 200,
		headers: { "content-type": "text/event-stream" },
		body: chunks([
			encoder.encode(`event: response.completed\r\ndata: ${data}\r\n\r\n`),
		]),
	};
}

function chunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) yield value;
		},
	};
}

function httpResponse(status: number, text = ""): HttpResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: chunks(text.length === 0 ? [] : [encoder.encode(text)]),
	};
}

function ok<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

function notFound<Value>(): Result<Value> {
	return {
		ok: false,
		error: { code: "not_found", message: "Not found.", retryable: false },
	};
}

class FixedClock implements ClockPort {
	private monotonic = 0;
	readonly sleeps: number[] = [];

	monotonicMilliseconds(): number {
		this.monotonic += 1;
		return this.monotonic;
	}

	unixMilliseconds(): number {
		return 1_700_000_000_000;
	}

	async sleep(milliseconds: number): Promise<void> {
		this.sleeps.push(milliseconds);
	}
}

class SequenceRandom implements RandomPort {
	private next = 1;
	readonly sizes: number[] = [];

	async bytes(length: number): Promise<Result<Uint8Array>> {
		this.sizes.push(length);
		const value = new Uint8Array(length);
		value.fill(this.next & 0xff);
		this.next += 1;
		return ok(value);
	}
}

class MemoryCredentials implements CredentialPort {
	private readonly values = new Map<string, Uint8Array>();
	reads = 0;

	constructor(credential: GrokCredential | null = freshCredential()) {
		if (credential !== null)
			this.values.set(
				this.key({ ...GROK_CREDENTIAL_KEY, account: "default" }),
				encoder.encode(JSON.stringify(credential)),
			);
	}

	async read(key: CredentialKey): Promise<Result<Uint8Array>> {
		this.reads += 1;
		const value = this.values.get(this.key(key));
		return value === undefined ? notFound() : ok(value.slice());
	}

	async write(key: CredentialKey, value: Uint8Array): Promise<Result<void>> {
		this.values.set(this.key(key), value.slice());
		return ok(undefined);
	}

	async remove(key: CredentialKey): Promise<Result<void>> {
		this.values.delete(this.key(key));
		return ok(undefined);
	}

	private key(key: CredentialKey): string {
		return `${key.provider}/${key.account}/${key.name}`;
	}
}

class MemoryFileSystem implements FileSystemPort {
	private readonly values = new Map<string, Uint8Array>();

	async readFile(request: FileReadRequest): Promise<Result<Uint8Array>> {
		const value = this.values.get(`${request.root}/${request.path}`);
		return value === undefined ? notFound() : ok(value.slice());
	}

	async writeFileAtomically(request: FileWriteRequest): Promise<Result<void>> {
		this.values.set(`${request.root}/${request.path}`, request.bytes.slice());
		return ok(undefined);
	}

	async removeFile(root: string, path: string): Promise<Result<void>> {
		this.values.delete(`${root}/${path}`);
		return ok(undefined);
	}
}

class ImmediateRefreshLock implements GrokRefreshLockPort {
	async tryCreateDirectory(): Promise<Result<"created" | "exists">> {
		return ok("created");
	}

	async writeOwner(): Promise<Result<void>> {
		return ok(undefined);
	}

	async observe(): Promise<
		Result<{
			ownerBytes: Uint8Array | null;
			directoryModifiedAtUnixMilliseconds: number;
		}>
	> {
		return ok({ ownerBytes: null, directoryModifiedAtUnixMilliseconds: 0 });
	}

	async removeIfUnchanged(): Promise<Result<boolean>> {
		return ok(true);
	}

	async releaseIfOwner(): Promise<Result<boolean>> {
		return ok(true);
	}
}

type HttpResponder = (request: HttpRequest) => Promise<Result<HttpResponse>>;

class FakeHttp implements HttpPort {
	readonly requests: HttpRequest[] = [];

	constructor(private readonly respond: HttpResponder) {}

	async request(request: HttpRequest): Promise<Result<HttpResponse>> {
		this.requests.push({
			...request,
			headers: { ...request.headers },
			...(request.body === undefined ? {} : { body: request.body.slice() }),
		});
		return this.respond(request);
	}
}

function freshCredential(
	overrides: Partial<GrokCredential> = {},
): GrokCredential {
	return {
		access_token: "access-old",
		refresh_token: "refresh-old",
		expires_at: 1_800_000_000,
		scopes: ["grok-cli:access", "api:access"],
		email: "grok@example.test",
		client_id: GROK_CLIENT_ID,
		token_endpoint: "https://auth.x.ai/oauth2/token",
		...overrides,
	};
}

function options(
	http: HttpPort,
	overrides: Partial<Parameters<typeof createGrokAttemptSender>[0]> = {},
) {
	return {
		version: "0.1-test",
		label: "default",
		homeDirectory: "/tmp/kogen-test-home",
		http,
		credentials: new MemoryCredentials(),
		filesystem: new MemoryFileSystem(),
		locks: new ImmediateRefreshLock(),
		random: new SequenceRandom(),
		clock: new FixedClock(),
		...overrides,
	};
}

test("P10 Grok wire sends the exact proxy, request headers, model and shared Responses body", async () => {
	const http = new FakeHttp(async () => ok(sseResponse()));
	const fixture = options(http);
	const state = session();
	const request = encodeSessionRequest(state);
	const sender = createGrokAttemptSender(fixture);
	const result = await sender({ request, session: state, attempt: 1 });

	expect(result.ok).toBe(true);
	expect(http.requests).toHaveLength(1);
	const sent = http.requests[0];
	if (sent === undefined) throw new Error("Missing Grok HTTP request.");
	expect(sent.method).toBe("POST");
	expect(sent.url).toBe(GROK_RESPONSES_ENDPOINT);
	expect(sent.firstByteTimeoutMilliseconds).toBe(120_000);
	expect(sent.idleTimeoutMilliseconds).toBe(90_000);
	expect(sent.totalTimeoutMilliseconds).toBe(1_200_000);
	expect(sent.headers).toMatchObject({
		accept: "text/event-stream",
		"content-type": "application/json",
		authorization: "Bearer access-old",
		"x-xai-token-auth": "xai-grok-cli",
		"x-authenticateresponse": "authenticate-response",
		"x-grok-model-override": "grok-4.6",
		"x-grok-client-identifier": "kogen",
		"x-grok-client-mode": "headless",
		"x-grok-client-version": "0.1-test",
		"user-agent": "kogen/0.1-test",
		"x-grok-conv-id": state.cacheKey,
		"x-grok-session-id": state.cacheKey,
	});
	expect(sent.headers["x-grok-req-id"]).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
	);

	const body = JSON.parse(decoder.decode(sent.body)) as Record<string, unknown>;
	expect(body).toMatchObject({
		model: "grok-4.6",
		instructions: "Use the approved Kogen provider protocol.",
		reasoning: { effort: "high" },
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: state.cacheKey,
	});
	expect(body.reasoning).not.toHaveProperty("summary");
	expect(body).not.toHaveProperty("previous_response_id");
	expect(body).toHaveProperty("tools", toolSchemas);
	expect(body).toHaveProperty("input");
	if (!result.ok) throw new Error("Grok response did not complete.");
	expect(result.response.usage).toEqual({
		input: 60,
		cached_input: 60,
		cache_write: 10,
		output: 15,
		reasoning: 5,
	});
});

test("Grok credential loading spends the response first-byte deadline", async () => {
	let now = 0;
	const clock: ClockPort = {
		monotonicMilliseconds: () => now,
		unixMilliseconds: () => 1_700_000_000_000,
		sleep: (_milliseconds, signal) =>
			new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	};
	const saved = new MemoryCredentials();
	const credentials: CredentialPort = {
		read: async (key) => {
			now = 120_001;
			return saved.read(key);
		},
		write: (key, value) => saved.write(key, value),
		remove: (key) => saved.remove(key),
	};
	let sends = 0;
	const http = new HttpTransport(clock, {
		fetch: async () => {
			sends += 1;
			return new Response("ok");
		},
	});
	const state = session();
	const result = await createGrokAttemptSender(
		options(http, { clock, credentials }),
	)({
		request: encodeSessionRequest(state),
		session: state,
		attempt: 1,
	});
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.class).toBe("timeout");
	expect(sends).toBe(0);
});

test("Grok-pass4 starts a fresh conversation with the effective Grok shaper and sends no ChatGPT request", async () => {
	const projectRoles = new Map<ModelRole, RoleValue>([
		["shaper", { model: "grok-shaper-test", effort: "xhigh" }],
	]);
	const checkout = "/tmp/kogen-grok/project";
	const selection = resolveAccountSelection({
		checkout,
		accounts: {
			grok: { projects: [{ path: checkout, account: "default" }] },
			selection: { projects: [{ path: checkout, provider: "grok" }] },
		} satisfies AccountsDocument,
	});
	expect(selection.ok).toBe(true);
	if (!selection.ok) throw new Error("Grok account selection did not resolve.");
	const resolved = resolveRoles({
		provider: selection.value.provider,
		project: projectRoles,
	});
	expect(resolved.ok).toBe(true);
	if (!resolved.ok) throw new Error("Grok roles did not resolve.");
	const shaper = resolved.value.roles.shaper;
	const primary = session({
		provider: "grok",
		role: "shaper",
		model: shaper.effective.model,
		effort: shaper.effective.effort,
		stage: "shape",
		attempt: "primary",
		rung: "shape",
	});
	const fallback = stepSession(primary, {
		type: "start_conversation",
		stage: "shape",
		attempt: "fallback",
		rung: "shape",
		role: "fallback_shaper",
		model: resolved.value.fallbackShaper.effective.model,
		effort: resolved.value.fallbackShaper.effective.effort,
		initialItems: [
			{
				kind: "message",
				bytes: encoder.encode(
					'{"role":"user","content":[{"type":"input_text","text":"last failure: invalid frontmatter"}]}',
				),
			},
		],
	});

	expect(resolved.value.fallbackShaper.effective).toEqual(shaper.effective);
	expect(fallback.role).toBe("fallback_shaper");
	expect(fallback.effectiveRole).toBe("shaper");
	expect(fallback.provider).toBe("grok");
	expect(fallback.model).toBe("grok-shaper-test");
	expect(fallback.effort).toBe("xhigh");
	expect(fallback.cacheKey).toBe(primary.cacheKey);
	expect(fallback.threadId).not.toBe(primary.threadId);

	const http = new FakeHttp(async () => ok(sseResponse()));
	const fixture = options(http);
	const result = await respondWithRetry({
		session: fallback,
		resolvedRole: shaper,
		mode: "shape",
		clock: fixture.clock,
		random: fixture.random,
		sendAttempt: createGrokAttemptSender(fixture),
	});
	expect(result.kind).toBe("completed");
	expect(http.requests.map((request) => request.url)).toEqual([
		GROK_RESPONSES_ENDPOINT,
	]);
	expect(http.requests[0]?.headers["x-grok-model-override"]).toBe(
		"grok-shaper-test",
	);
});

test("Grok omits both sticky headers when a conversation has no cache key", () => {
	const routing = new StickyRoutingContext("grok", {
		cacheKey: "",
		threadId: "conversation-without-affinity",
	});
	expect(routing.headers()).toEqual({});
});

test("a 401 refresh replay gets a fresh request UUID and resends identical body bytes", async () => {
	let responsesCalls = 0;
	const http = new FakeHttp(async (request) => {
		if (request.url === "https://auth.x.ai/oauth2/token")
			return ok(
				httpResponse(
					200,
					JSON.stringify({
						access_token: "access-new",
						refresh_token: "refresh-new",
						expires_in: 3600,
					}),
				),
			);
		responsesCalls += 1;
		return responsesCalls === 1
			? ok(httpResponse(401, '{"error":"expired"}'))
			: ok(sseResponse());
	});
	const fixture = options(http);
	const state = session();
	const sender = createGrokAttemptSender(fixture);
	const result = await sender({
		request: encodeSessionRequest(state),
		session: state,
		attempt: 1,
	});
	const responseRequests = http.requests.filter(
		(request) => request.url === GROK_RESPONSES_ENDPOINT,
	);
	const authRequests = http.requests.filter(
		(request) => request.url === "https://auth.x.ai/oauth2/token",
	);
	expect(result.ok).toBe(true);
	expect(responseRequests).toHaveLength(2);
	expect(authRequests).toHaveLength(1);
	expect(responseRequests[0]?.headers.authorization).toBe("Bearer access-old");
	expect(responseRequests[1]?.headers.authorization).toBe("Bearer access-new");
	expect(responseRequests[0]?.headers["x-grok-req-id"]).not.toBe(
		responseRequests[1]?.headers["x-grok-req-id"],
	);
	expect(responseRequests[0]?.body).toEqual(responseRequests[1]?.body);
	expect(
		http.requests.every((request) => !request.url.includes("openai.com")),
	).toBe(true);
});

test("Grok overload retries stay on Grok and partial failures use shared append and nullable usage rules", async () => {
	const partial = messageItem("partial answer");
	const failedEvent = JSON.stringify({
		type: "error",
		error: { message: "connection reset" },
		response: {
			output: [partial],
			usage: {
				input_tokens: 20,
				input_tokens_details: { cached_tokens: 5 },
				output_tokens: 3,
			},
		},
	});
	let grokCalls = 0;
	const http = new FakeHttp(async () => {
		grokCalls += 1;
		if (grokCalls === 1)
			return ok({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: chunks([
					encoder.encode(`event: error\ndata: ${failedEvent}\n\n`),
				]),
			});
		if (grokCalls < 4) return ok(httpResponse(503, "server overloaded"));
		return ok(sseResponse([messageItem("final")], null));
	});
	const fixture = options(http);
	const state = session();
	const roles = resolveRoles({ provider: "grok" });
	if (!roles.ok) throw new Error("Grok roles did not resolve.");
	const result = await respondWithRetry({
		session: state,
		resolvedRole: roles.value.roles.builder,
		mode: "shape",
		clock: fixture.clock,
		random: fixture.random,
		sendAttempt: createGrokAttemptSender(fixture),
	});
	expect(result.kind).toBe("completed");
	expect(http.requests).toHaveLength(4);
	expect(
		http.requests.every((request) => request.url === GROK_RESPONSES_ENDPOINT),
	).toBe(true);
	expect(
		new Set(http.requests.map((request) => request.headers["x-grok-req-id"]))
			.size,
	).toBe(4);
	if (result.kind !== "completed")
		throw new Error("Grok retry did not complete.");
	expect(result.attempts[0]?.result).toBe("transport");
	expect(result.attempts[0]?.usage).toEqual({
		input: 15,
		cached_input: 5,
		cache_write: null,
		output: 3,
		reasoning: null,
	});
	expect(result.response.usage).toBeNull();
	expect(result.response.text).toBe("partial answerfinal");
	const firstRequest = http.requests[0];
	const continuedRequest = http.requests[1];
	if (firstRequest?.body === undefined || continuedRequest?.body === undefined)
		throw new Error("Grok retry request body is missing.");
	expect(hasAppendedInputPrefix(firstRequest.body, continuedRequest.body)).toBe(
		true,
	);
	expect(decoder.decode(continuedRequest.body)).toContain(
		"The response stream was interrupted.",
	);
});

test("Grok adapter rejects a ChatGPT session before credentials or HTTP are touched", async () => {
	const http = new FakeHttp(async () => ok(sseResponse()));
	const credentials = new MemoryCredentials();
	const sender = createGrokAttemptSender(options(http, { credentials }));
	const chatgpt = session({
		provider: "chatgpt",
		model: "gpt-6-luna",
		effort: "max",
	});
	const result = await sender({
		request: encodeSessionRequest(chatgpt),
		session: chatgpt,
		attempt: 1,
	});
	expect(result).toMatchObject({
		ok: false,
		error: {
			class: "unsupported",
			message: "Grok request adapter received a non-Grok session.",
		},
	});
	expect(credentials.reads).toBe(0);
	expect(http.requests).toEqual([]);
});

test("Grok HTTP failures use the frozen provider-specific class and sentence table", () => {
	expect(mapGrokHttpFailure(401, "")).toEqual({
		class: "login",
		message: "Grok rejected this session; run `kogen provider login grok`.",
	});
	expect(mapGrokHttpFailure(403, "")).toEqual({
		class: "login",
		message: "This Grok account cannot access the requested model.",
	});
	expect(mapGrokHttpFailure(400, "quota exceeded")).toEqual({
		class: "usage_limit",
		message: "Grok subscription usage limit reached.",
	});
	expect(mapGrokHttpFailure(429, "")).toEqual({
		class: "usage_limit",
		message: "Grok subscription usage limit reached.",
	});
	expect(mapGrokHttpFailure(400, "rate limit")).toEqual({
		class: "usage_limit",
		message: "Grok subscription usage limit reached.",
	});
	expect(mapGrokHttpFailure(500, "server_is_overloaded")).toEqual({
		class: "overload",
		message: "Grok service is temporarily overloaded.",
	});
	expect(mapGrokHttpFailure(503, "")).toEqual({
		class: "overload",
		message: "Grok service is temporarily overloaded.",
	});
	expect(mapGrokHttpFailure(418, "")).toEqual({
		class: "malformed",
		message: "Grok rejected the request (HTTP 418).",
	});
});

test("Grok deadline, stall, connect, malformed-stream, and size errors use their exact sentences", async () => {
	const state = session();
	const request = encodeSessionRequest(state);
	const httpFailures = [
		{
			kind: "first_byte_timeout" as const,
			class: "timeout",
			message: "Grok request timed out.",
		},
		{
			kind: "idle_stall" as const,
			class: "stall",
			message: "Provider stream sent nothing for 90 s after it started.",
		},
	];
	for (const expected of httpFailures) {
		const http = new FakeHttp(async () => ({
			ok: false,
			error: {
				code: "timeout",
				message: "Deadline elapsed.",
				retryable: true,
				cause: new HttpDeadlineError(expected.kind, "Deadline elapsed."),
			},
		}));
		const result = await createGrokAttemptSender(options(http))({
			request,
			session: state,
			attempt: 1,
		});
		expect(result).toMatchObject({
			ok: false,
			error: { class: expected.class, message: expected.message },
		});
	}
	const connectHttp = new FakeHttp(async () => ({
		ok: false,
		error: {
			code: "unavailable",
			message: "Connection failed.",
			retryable: true,
		},
	}));
	const connectResult = await createGrokAttemptSender(options(connectHttp))({
		request,
		session: state,
		attempt: 1,
	});
	expect(connectResult).toMatchObject({
		ok: false,
		error: {
			class: "transport",
			message: "Grok request could not connect.",
		},
	});

	const malformedHttp = new FakeHttp(async () =>
		ok({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: chunks([encoder.encode("data: not-json\\n\\n")]),
		}),
	);
	const malformedResult = await createGrokAttemptSender(options(malformedHttp))(
		{
			request,
			session: state,
			attempt: 1,
		},
	);
	expect(malformedResult).toMatchObject({
		ok: false,
		error: {
			class: "malformed",
			message: "Grok returned a malformed response stream.",
		},
	});

	const oversizedHttp = new FakeHttp(async () =>
		ok({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: chunks([new Uint8Array(MAX_SSE_BODY_BYTES + 1)]),
		}),
	);
	const oversizedResult = await createGrokAttemptSender(options(oversizedHttp))(
		{
			request,
			session: state,
			attempt: 1,
		},
	);
	expect(oversizedResult).toMatchObject({
		ok: false,
		error: {
			class: "malformed",
			message: "Grok response exceeded the size limit.",
		},
	});
});
