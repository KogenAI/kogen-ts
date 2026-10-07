export const MAX_SSE_BODY_BYTES = 16 * 1024 * 1024;

export interface SseFrame {
	readonly data: string;
	readonly event: string | null;
}

export type SseFramingErrorCode =
	| "body_too_large"
	| "invalid_utf8"
	| "stream_closed";

export class SseFramingError extends Error {
	constructor(
		readonly code: SseFramingErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SseFramingError";
	}
}

/**
 * Incrementally frames an SSE response body.
 *
 * The byte limit covers the complete body, including comments and fields that
 * are ignored by framing. UTF-8 is decoded incrementally and malformed input
 * fails closed instead of inserting replacement characters into JSON data.
 */
export class SseFramer {
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private bytesReadValue = 0;
	private line = "";
	private dataLines: string[] = [];
	private eventName: string | null = null;
	private swallowLf = false;
	private finished = false;
	private failure: SseFramingError | null = null;

	get bytesRead(): number {
		return this.bytesReadValue;
	}

	push(chunk: Uint8Array): SseFrame[] {
		this.ensureOpen();
		if (chunk.byteLength > MAX_SSE_BODY_BYTES - this.bytesReadValue) {
			throw this.fail(
				"body_too_large",
				`SSE response body exceeds ${MAX_SSE_BODY_BYTES} bytes`,
			);
		}
		this.bytesReadValue += chunk.byteLength;

		let decoded: string;
		try {
			decoded = this.decoder.decode(chunk, { stream: true });
		} catch (cause) {
			throw this.fail("invalid_utf8", "SSE response body is not valid UTF-8", {
				cause,
			});
		}
		return this.consume(decoded);
	}

	finish(): SseFrame[] {
		this.ensureOpen();
		let decoded: string;
		try {
			decoded = this.decoder.decode();
		} catch (cause) {
			throw this.fail("invalid_utf8", "SSE response body is not valid UTF-8", {
				cause,
			});
		}

		const frames = this.consume(decoded);
		this.swallowLf = false;
		if (this.line.length > 0) {
			this.consumeLine();
		}
		this.emitFrame(frames);
		this.finished = true;
		return frames;
	}

	private consume(text: string): SseFrame[] {
		const frames: SseFrame[] = [];
		for (const character of text) {
			if (this.swallowLf) {
				this.swallowLf = false;
				if (character === "\n") continue;
			}

			if (character === "\r") {
				this.consumeLine(frames);
				this.swallowLf = true;
			} else if (character === "\n") {
				this.consumeLine(frames);
			} else {
				this.line += character;
			}
		}
		return frames;
	}

	private consumeLine(frames?: SseFrame[]): void {
		const line = this.line;
		this.line = "";

		if (line.length === 0) {
			if (frames) this.emitFrame(frames);
			else this.resetFrame();
			return;
		}
		if (line.startsWith(":")) return;

		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		if (field === "data") {
			this.dataLines.push(value);
		} else if (field === "event") {
			this.eventName = value.length > 0 ? value : null;
		}
	}

	private emitFrame(frames: SseFrame[]): void {
		if (this.dataLines.length > 0) {
			const data = this.dataLines.join("\n");
			if (data.length > 0 && data !== "[DONE]") {
				frames.push({ data, event: this.eventName });
			}
		}
		this.resetFrame();
	}

	private resetFrame(): void {
		this.dataLines.length = 0;
		this.eventName = null;
	}

	private ensureOpen(): void {
		if (this.failure) throw this.failure;
		if (this.finished) {
			throw new SseFramingError(
				"stream_closed",
				"SSE stream is already finished",
			);
		}
	}

	private fail(
		code: SseFramingErrorCode,
		message: string,
		options?: ErrorOptions,
	): SseFramingError {
		const error = new SseFramingError(code, message, options);
		this.failure = error;
		return error;
	}
}
