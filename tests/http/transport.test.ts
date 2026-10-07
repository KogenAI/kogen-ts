import { expect, test } from "bun:test";
import type { ClockPort } from "../../packages/core/src/contracts/clock";
import type { HttpRequest } from "../../packages/core/src/contracts/ports";
import {
	createHttpDeadline,
	HttpDeadlineError,
} from "../../packages/core/src/provider/http/deadline";
import { StickyRoutingContext } from "../../packages/core/src/provider/http/routing";
import {
	type FetchPort,
	HttpTransport,
	HttpTransportError,
	resolveProviderEndpoint,
} from "../../packages/core/src/provider/http/transport";

interface PendingSleep {
	readonly id: number;
	readonly due: number;
	readonly resolve: () => void;
	readonly reject: (cause: unknown) => void;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: (() => void) | undefined;
}

class FakeClock implements ClockPort {
	private now = 0;
	private nextId = 0;
	private readonly pending = new Map<number, PendingSleep>();

	monotonicMilliseconds(): number {
		return this.now;
	}

	unixMilliseconds(): number {
		return 1_800_000_000_000 + this.now;
	}

	sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			const id = ++this.nextId;
			const onAbort = signal
				? () => {
						this.pending.delete(id);
						reject(signal.reason);
					}
				: undefined;
			const entry: PendingSleep = {
				id,
				due: this.now + milliseconds,
				resolve,
				reject,
				signal,
				onAbort,
			};
			this.pending.set(id, entry);
			if (signal && onAbort)
				signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	advanceBy(milliseconds: number): void {
		this.now += milliseconds;
		for (const entry of [...this.pending.values()].sort(
			(a, b) => a.due - b.due,
		)) {
			if (entry.due > this.now) continue;
			this.pending.delete(entry.id);
			if (entry.signal && entry.onAbort)
				entry.signal.removeEventListener("abort", entry.onAbort);
			entry.resolve();
		}
	}
}

const encoder = new TextEncoder();

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
	return {
		method: "POST",
		url: "https://provider.invalid/v1/responses",
		headers: { accept: "text/event-stream" },
		firstByteTimeoutMilliseconds: 5,
		idleTimeoutMilliseconds: 7,
		totalTimeoutMilliseconds: 20,
		...overrides,
	};
}

function fetchResponse(
	status: number,
	body: ReadableStream<Uint8Array>,
): Response {
	return new Response(body, {
		status,
		headers: { "x-request-id": "req_test" },
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test("first-byte clock can start before auth and expires after the exact boundary", async () => {
	const clock = new FakeClock();
	const limits = {
		firstByteTimeoutMilliseconds: 5,
		idleTimeoutMilliseconds: 7,
		totalTimeoutMilliseconds: 20,
	};
	const deadline = createHttpDeadline(clock, limits);
	clock.advanceBy(5);
	await flushMicrotasks();
	expect(deadline.error).toBeNull();
	clock.advanceBy(1);
	await flushMicrotasks();
	expect(deadline.error?.kind).toBe("first_byte_timeout");

	let fetchCalls = 0;
	const transport = new HttpTransport(clock, {
		fetch: async () => {
			fetchCalls += 1;
			throw new Error("must not connect after the auth deadline");
		},
	});
	const result = await transport.request(request(), deadline.signal);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.cause).toBeInstanceOf(HttpDeadlineError);
	expect(fetchCalls).toBe(0);
	deadline.complete();
});

test("slow response headers are bounded and abort the fetch", async () => {
	const clock = new FakeClock();
	let init: RequestInit | undefined;
	const fetcher: FetchPort = (_input, requestInit) => {
		init = requestInit;
		return new Promise(() => {});
	};
	const transport = new HttpTransport(clock, { fetch: fetcher });
	const pending = transport.request(request());
	await flushMicrotasks();
	clock.advanceBy(6);
	await flushMicrotasks();
	const result = await pending;
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.code).toBe("timeout");
		expect((result.error.cause as HttpDeadlineError).kind).toBe(
			"first_byte_timeout",
		);
	}
	expect(init?.signal?.aborted).toBe(true);
});

test("slow body after headers is covered by the first-byte clock", async () => {
	const clock = new FakeClock();
	const stream = new ReadableStream<Uint8Array>({ start() {} });
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(200, stream),
	});
	const pending = transport.request(request());
	await flushMicrotasks();
	clock.advanceBy(6);
	await flushMicrotasks();
	const result = await pending;
	expect(result.ok).toBe(false);
	if (!result.ok)
		expect((result.error.cause as HttpDeadlineError).kind).toBe(
			"first_byte_timeout",
		);
});

test("an SSE comment is a body byte and starts the idle clock", async () => {
	const clock = new FakeClock();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": keepalive\n\n"));
			controller.close();
		},
	});
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(200, stream),
	});
	const result = await transport.request(request());
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.status).toBe(200);
	const chunks: Uint8Array[] = [];
	for await (const chunk of result.value.body) chunks.push(chunk);
	expect(chunks).toEqual([encoder.encode(": keepalive\n\n")]);
});

test("an idle gap after the first chunk is a stall and aborts the stream", async () => {
	const clock = new FakeClock();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": first\n\n"));
		},
		cancel() {
			cancelled = true;
		},
	});
	let init: RequestInit | undefined;
	const transport = new HttpTransport(clock, {
		fetch: async (_input, requestInit) => {
			init = requestInit;
			return fetchResponse(200, stream);
		},
	});
	const result = await transport.request(request());
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	const iterator = result.value.body[Symbol.asyncIterator]();
	expect((await iterator.next()).value).toEqual(encoder.encode(": first\n\n"));
	const pending = iterator.next();
	await flushMicrotasks();
	clock.advanceBy(8);
	await flushMicrotasks();
	await expect(pending).rejects.toMatchObject({ kind: "idle_stall" });
	expect(init?.signal?.aborted).toBe(true);
	await flushMicrotasks();
	expect(cancelled).toBe(true);
});

test("the total attempt cap wins even when chunks keep arriving", async () => {
	const clock = new FakeClock();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
			value.enqueue(encoder.encode("first"));
		},
	});
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(200, stream),
	});
	const result = await transport.request(request());
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	const iterator = result.value.body[Symbol.asyncIterator]();
	await iterator.next();
	let pending = iterator.next();
	clock.advanceBy(6);
	controller?.enqueue(encoder.encode("second"));
	await flushMicrotasks();
	expect((await pending).value).toEqual(encoder.encode("second"));
	pending = iterator.next();
	clock.advanceBy(6);
	controller?.enqueue(encoder.encode("third"));
	await flushMicrotasks();
	expect((await pending).value).toEqual(encoder.encode("third"));
	pending = iterator.next();
	clock.advanceBy(7);
	await flushMicrotasks();
	clock.advanceBy(2);
	await flushMicrotasks();
	await expect(pending).rejects.toMatchObject({ kind: "total_timeout" });
});

test("explicit cancellation interrupts a pending first body read", async () => {
	const clock = new FakeClock();
	const parent = new AbortController();
	const stream = new ReadableStream<Uint8Array>({ start() {} });
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(200, stream),
	});
	const pending = transport.request(request(), parent.signal);
	await flushMicrotasks();
	parent.abort("caller stopped");
	await flushMicrotasks();
	const result = await pending;
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.code).toBe("cancelled");
		expect((result.error.cause as HttpDeadlineError).kind).toBe("cancelled");
	}
});

test("caller cancellation after the first byte stops the streamed response", async () => {
	const clock = new FakeClock();
	const parent = new AbortController();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("first"));
		},
	});
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(200, stream),
	});
	const result = await transport.request(request(), parent.signal);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	const iterator = result.value.body[Symbol.asyncIterator]();
	expect((await iterator.next()).value).toEqual(encoder.encode("first"));
	const pending = iterator.next();
	await flushMicrotasks();
	parent.abort("caller stopped the active stream");
	await flushMicrotasks();
	await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
});

test("non-success response bodies are exposed only up to the configured byte cap", async () => {
	const clock = new FakeClock();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode("provider error body longer than cap"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const transport = new HttpTransport(clock, {
		fetch: async () => fetchResponse(429, stream),
		maxErrorBodyBytes: 12,
	});
	const result = await transport.request(request());
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.status).toBe(429);
	const bytes: number[] = [];
	for await (const chunk of result.value.body) bytes.push(...chunk);
	expect(bytes).toEqual([...encoder.encode("provider err")]);
	await flushMicrotasks();
	expect(cancelled).toBe(true);
});

test("routing context keeps affinity across retries and updates only the thread", () => {
	const routing = new StickyRoutingContext("chatgpt", {
		cacheKey: "run-affinity-1",
		threadId: "thread-stage-1",
	});
	const first = routing.applyTo({ Authorization: "Bearer fake" });
	const retry = routing.applyTo({ authorization: "Bearer fake" });
	expect(first["session-id"]).toBe("run-affinity-1");
	expect(first["thread-id"]).toBe("thread-stage-1");
	expect(retry["session-id"]).toBe(first["session-id"]);
	expect(retry["thread-id"]).toBe(first["thread-id"]);
	expect(() => routing.applyTo({ "session-id": "different-affinity" })).toThrow(
		"conflicts with sticky routing",
	);

	routing.startConversation("thread-stage-2");
	expect(routing.headers()).toEqual({
		"session-id": "run-affinity-1",
		"thread-id": "thread-stage-2",
	});
	expect(routing.snapshot()).toEqual({
		cacheKey: "run-affinity-1",
		threadId: "thread-stage-2",
	});
});

test("transport sends the same sticky headers on repeated request attempts", async () => {
	const clock = new FakeClock();
	const routing = new StickyRoutingContext("chatgpt", {
		cacheKey: "persistent-affinity",
		threadId: "persistent-thread",
	});
	const observed: Readonly<Record<string, string>>[] = [];
	const transport = new HttpTransport(clock, {
		fetch: async (_input, init) => {
			observed.push(Object.fromEntries(new Headers(init?.headers).entries()));
			return fetchResponse(
				200,
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data"));
						controller.close();
					},
				}),
			);
		},
	});
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await transport.request(
			request({
				headers: routing.applyTo({ "content-type": "application/json" }),
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			for await (const _chunk of result.value.body) {
				// Consume the stream so each attempt releases its deadline.
			}
		}
	}
	expect(observed).toHaveLength(2);
	for (const headers of observed) {
		expect(headers["session-id"]).toBe("persistent-affinity");
		expect(headers["thread-id"]).toBe("persistent-thread");
	}
});

test("Grok and Lite keep their distinct sticky header names", () => {
	const grok = new StickyRoutingContext("grok", {
		cacheKey: "affinity-grok",
		threadId: "conversation-grok",
	});
	expect(grok.headers()).toEqual({
		"x-grok-conv-id": "affinity-grok",
		"x-grok-session-id": "affinity-grok",
	});
	const lite = new StickyRoutingContext(
		"chatgpt",
		{
			cacheKey: "affinity-lite",
			threadId: "conversation-lite",
			protocolSessionId: "protocol-lite",
		},
		"lite",
	);
	expect(lite.headers()).toEqual({
		session_id: "protocol-lite",
		"thread-id": "conversation-lite",
	});
});

test("endpoint override accepts local HTTP test endpoints and rejects unsafe URLs", () => {
	expect(
		resolveProviderEndpoint(
			"https://api.openai.com/v1/responses",
			"http://127.0.0.1:4321/v1/responses",
		),
	).toBe("http://127.0.0.1:4321/v1/responses");
	expect(() =>
		resolveProviderEndpoint("https://provider.invalid", "file:///tmp/x"),
	).toThrow("HTTP(S)");
	expect(() =>
		resolveProviderEndpoint(
			"https://provider.invalid",
			"https://user:pass@provider.invalid",
		),
	).toThrow("userinfo");
});

test("transport failures keep a typed cause without exposing endpoint secrets", async () => {
	const clock = new FakeClock();
	const transport = new HttpTransport(clock, {
		fetch: async () => {
			throw new Error("socket details");
		},
	});
	const result = await transport.request(
		request({ url: "https://user:token@provider.invalid/secret" }),
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.message).toBe(
			"HTTP URL must use HTTP(S) without userinfo.",
		);
		expect(result.error.cause).toBeUndefined();
	}
});

test("fetch connection errors become retryable transport failures", async () => {
	const clock = new FakeClock();
	const transport = new HttpTransport(clock, {
		fetch: async () => {
			throw new Error("private socket detail");
		},
	});
	const result = await transport.request(request());
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.retryable).toBe(true);
		expect(result.error.cause).toBeInstanceOf(HttpTransportError);
		expect(result.error.message).toBe(
			"HTTP request or response stream failed.",
		);
	}
});
