import type { ClockPort } from "../../contracts/clock";
import type { PortError, Result } from "../../contracts/errors";
import type {
	HttpPort,
	HttpRequest,
	HttpResponse,
} from "../../contracts/ports";
import {
	createHttpDeadline,
	type HttpDeadline,
	HttpDeadlineError,
	type HttpDeadlineKind,
	type HttpDeadlineLimits,
	httpDeadlineForSignal,
} from "./deadline";

export const HTTP_DEADLINE_DEFAULTS: HttpDeadlineLimits = Object.freeze({
	firstByteTimeoutMilliseconds: 120_000,
	idleTimeoutMilliseconds: 90_000,
	totalTimeoutMilliseconds: 1_200_000,
});

/** Error responses are read only up to this many bytes, then their stream is cancelled. */
export const MAX_HTTP_ERROR_BODY_BYTES = 64 * 1024;

export type FetchPort = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export type HttpTransportFailureKind = HttpDeadlineKind | "transport";

export class HttpTransportError extends Error {
	constructor(
		readonly kind: HttpTransportFailureKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HttpTransportError";
	}
}

export interface HttpTransportOptions {
	readonly fetch?: FetchPort;
	readonly maxErrorBodyBytes?: number;
}

type ReadChunkResult = Awaited<
	ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

/**
 * Streaming Fetch-backed HTTP effect port. The optional fetch function is the
 * endpoint seam used by hermetic tests; production defaults to global fetch.
 */
export class HttpTransport implements HttpPort {
	private readonly fetcher: FetchPort;
	private readonly maxErrorBodyBytes: number;

	constructor(
		private readonly clock: ClockPort,
		options: HttpTransportOptions = {},
	) {
		this.fetcher =
			options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.maxErrorBodyBytes =
			options.maxErrorBodyBytes ?? MAX_HTTP_ERROR_BODY_BYTES;
		if (
			!Number.isSafeInteger(this.maxErrorBodyBytes) ||
			this.maxErrorBodyBytes < 0
		)
			throw new RangeError(
				"maxErrorBodyBytes must be a non-negative safe integer.",
			);
	}

	async request(
		request: HttpRequest,
		signal?: AbortSignal,
	): Promise<Result<HttpResponse>> {
		const invalid = validateRequest(request);
		if (invalid)
			return {
				ok: false,
				error: {
					code: "invalid_input",
					message: invalid,
					retryable: false,
				},
			};

		let deadline: HttpDeadline;
		const attached = httpDeadlineForSignal(signal);
		try {
			if (attached) {
				if (!sameLimits(attached.limits, request))
					throw new TypeError(
						"HTTP request limits do not match its prestarted deadline.",
					);
				deadline = attached;
			} else {
				deadline = createHttpDeadline(this.clock, request, signal);
			}
			deadline.throwIfUnavailable();
		} catch (cause) {
			if (cause instanceof HttpDeadlineError) attached?.complete();
			if (cause instanceof TypeError)
				return {
					ok: false,
					error: {
						code: "invalid_input",
						message: cause.message,
						retryable: false,
					},
				};
			return { ok: false, error: toPortError(cause) };
		}

		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
		try {
			const url = new URL(request.url);
			const headers = new Headers(request.headers);
			const requestBody = request.body?.slice();
			const response = await raceWithAbort(
				this.fetcher(url, {
					method: request.method,
					headers,
					...(requestBody === undefined
						? {}
						: { body: requestBody as BodyInit }),
					signal: deadline.signal,
					redirect: "error",
				}),
				deadline.signal,
			);
			deadline.throwIfUnavailable();
			const responseHeaders = collectHeaders(response.headers);
			reader = response.body?.getReader() ?? null;

			if (response.status < 200 || response.status >= 300) {
				const bytes = reader
					? await readBoundedErrorBody(reader, deadline, this.maxErrorBodyBytes)
					: new Uint8Array();
				if (reader) releaseReader(reader);
				reader = null;
				deadline.complete();
				return {
					ok: true,
					value: {
						status: response.status,
						headers: responseHeaders,
						body: oneChunk(bytes),
					},
				};
			}

			if (!reader) {
				deadline.complete();
				return {
					ok: true,
					value: {
						status: response.status,
						headers: responseHeaders,
						body: emptyBody(),
					},
				};
			}

			let firstChunk: Uint8Array | null = null;
			while (firstChunk === null) {
				const part = await readChunk(reader, deadline);
				if (part.done) {
					releaseReader(reader);
					reader = null;
					deadline.complete();
					return {
						ok: true,
						value: {
							status: response.status,
							headers: responseHeaders,
							body: emptyBody(),
						},
					};
				}
				if (part.value.byteLength === 0) continue;
				deadline.markBodyByte();
				firstChunk = part.value;
			}

			const responseBody = streamReader(reader, firstChunk, deadline);
			reader = null;
			return {
				ok: true,
				value: {
					status: response.status,
					headers: responseHeaders,
					body: responseBody,
				},
			};
		} catch (cause) {
			if (reader) cancelReader(reader, cause);
			deadline.complete();
			const failure = deadline.error ?? normalizeFailure(cause);
			return { ok: false, error: toPortError(failure) };
		}
	}
}

/** Apply the frozen KOGEN_PROVIDER_URL seam without reading ambient env here. */
export function resolveProviderEndpoint(
	productionEndpoint: string,
	testEndpointOverride?: string,
): string {
	const value = testEndpointOverride ?? productionEndpoint;
	let url: URL;
	try {
		url = new URL(value);
	} catch (cause) {
		throw new TypeError("Provider endpoint must be an absolute URL.", {
			cause,
		});
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username.length > 0 ||
		url.password.length > 0
	)
		throw new TypeError("Provider endpoint must use HTTP(S) without userinfo.");
	return url.toString();
}

export function isHttpTransportError(
	value: unknown,
): value is HttpTransportError | HttpDeadlineError {
	return (
		value instanceof HttpTransportError || value instanceof HttpDeadlineError
	);
}

async function readBoundedErrorBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	deadline: HttpDeadline,
	maximumBytes: number,
): Promise<Uint8Array> {
	if (maximumBytes === 0) {
		cancelReader(reader);
		return new Uint8Array();
	}
	const retained = new Uint8Array(maximumBytes);
	let length = 0;
	while (length < maximumBytes) {
		const part = await readChunk(reader, deadline);
		if (part.done) break;
		if (part.value.byteLength === 0) continue;
		deadline.markBodyByte();
		const copied = Math.min(maximumBytes - length, part.value.byteLength);
		retained.set(part.value.subarray(0, copied), length);
		length += copied;
		if (length === maximumBytes) {
			cancelReader(reader);
			break;
		}
	}
	return retained.slice(0, length);
}

function streamReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	firstChunk: Uint8Array,
	deadline: HttpDeadline,
): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			let completed = false;
			try {
				yield firstChunk;
				while (true) {
					const part = await readChunk(reader, deadline);
					if (part.done) {
						completed = true;
						break;
					}
					if (part.value.byteLength === 0) continue;
					deadline.markBodyByte();
					yield part.value;
				}
			} finally {
				if (!completed) cancelReader(reader);
				releaseReader(reader);
				deadline.complete();
			}
		},
	};
}

async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	deadline: HttpDeadline,
): Promise<ReadChunkResult> {
	deadline.throwIfUnavailable();
	try {
		const part = await raceWithAbort(reader.read(), deadline.signal);
		deadline.throwIfUnavailable();
		return part;
	} catch (cause) {
		if (deadline.error) throw deadline.error;
		throw normalizeFailure(cause);
	}
}

function oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			if (bytes.byteLength > 0) yield bytes;
		},
	};
}

function emptyBody(): AsyncIterable<Uint8Array> {
	return oneChunk(new Uint8Array());
}

function collectHeaders(headers: Headers): Readonly<Record<string, string>> {
	const result = Object.create(null) as Record<string, string>;
	headers.forEach((value, name) => {
		result[name.toLowerCase()] = value;
	});
	return Object.freeze(result);
}

function validateRequest(request: HttpRequest): string | null {
	if (!request || typeof request !== "object")
		return "HTTP request is invalid.";
	if (
		!Number.isSafeInteger(request.firstByteTimeoutMilliseconds) ||
		request.firstByteTimeoutMilliseconds < 1 ||
		!Number.isSafeInteger(request.idleTimeoutMilliseconds) ||
		request.idleTimeoutMilliseconds < 1 ||
		!Number.isSafeInteger(request.totalTimeoutMilliseconds) ||
		request.totalTimeoutMilliseconds < 1
	)
		return "HTTP request deadline limits are invalid.";
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method))
		return "HTTP method is invalid.";
	try {
		const url = new URL(request.url);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username.length > 0 ||
			url.password.length > 0
		)
			return "HTTP URL must use HTTP(S) without userinfo.";
		const headers = new Headers(request.headers);
		for (const [name, value] of headers) {
			if (!name || value.includes("\r") || value.includes("\n"))
				return "HTTP headers are invalid.";
		}
	} catch {
		return "HTTP URL or headers are invalid.";
	}
	if (request.body !== undefined && !(request.body instanceof Uint8Array))
		return "HTTP request body must be bytes.";
	return null;
}

function sameLimits(
	left: HttpDeadlineLimits,
	right: HttpDeadlineLimits,
): boolean {
	return (
		left.firstByteTimeoutMilliseconds === right.firstByteTimeoutMilliseconds &&
		left.idleTimeoutMilliseconds === right.idleTimeoutMilliseconds &&
		left.totalTimeoutMilliseconds === right.totalTimeoutMilliseconds
	);
}

function normalizeFailure(
	cause: unknown,
): HttpTransportError | HttpDeadlineError {
	if (cause instanceof HttpDeadlineError || cause instanceof HttpTransportError)
		return cause;
	return new HttpTransportError(
		"transport",
		"HTTP request or response stream failed.",
		{ cause },
	);
}

function toPortError(cause: unknown): PortError {
	const failure = normalizeFailure(cause);
	if (failure instanceof HttpDeadlineError) {
		return {
			code: failure.kind === "cancelled" ? "cancelled" : "timeout",
			message: failure.message,
			retryable: failure.kind !== "cancelled",
			cause: failure,
		};
	}
	return {
		code: "unavailable",
		message: failure.message,
		retryable: true,
		cause: failure,
	};
}

function raceWithAbort<Value>(
	promise: Promise<Value>,
	signal: AbortSignal,
): Promise<Value> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(cause: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(cause);
			},
		);
	});
}

function abortReason(signal: AbortSignal): unknown {
	if (signal.reason instanceof Error) return signal.reason;
	return new HttpDeadlineError("cancelled", "HTTP request was cancelled.", {
		cause: signal.reason,
	});
}

function cancelReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	reason?: unknown,
): void {
	void reader.cancel(reason).catch(() => {
		// The request may already have closed the underlying stream.
	});
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		reader.releaseLock();
	} catch {
		// A pending read is cancelled before its lock is released.
	}
}
