import { expect, test } from "bun:test";
import {
	MAX_SSE_BODY_BYTES,
	type SseFrame,
	SseFramer,
	SseFramingError,
} from "../../packages/core/src/provider/sse/framing";

const encoder = new TextEncoder();

function frame(chunks: readonly Uint8Array[]): SseFrame[] {
	const framer = new SseFramer();
	const result: SseFrame[] = [];
	for (const chunk of chunks) result.push(...framer.push(chunk));
	result.push(...framer.finish());
	return result;
}

test("frames data lines across CRLF, CR and LF, ignoring comments and DONE", () => {
	const source =
		": keepalive\r\n" +
		"event: response.output_item.done\r\n" +
		"id: ignored\r\n" +
		'data: {"type":"item",\r\n' +
		'data: "text":"café 🧪"}\r\n' +
		"\r\n" +
		"data: [DONE]\r" +
		"\r" +
		"data: \r" +
		"\r" +
		'data: {"tail":"✓"}';

	expect(frame([encoder.encode(source)])).toEqual([
		{
			data: '{"type":"item",\n"text":"café 🧪"}',
			event: "response.output_item.done",
		},
		{ data: '{"tail":"✓"}', event: null },
	]);
});

test("every two-chunk byte boundary preserves framing and split UTF-8", () => {
	const bytes = encoder.encode(
		':comment\r\nevent: response.completed\r\ndata: {"text":"à🧪"}\r\n\r\ndata: [DONE]\r\rdata: {"eof":true}',
	);
	const expected: SseFrame[] = [
		{ data: '{"text":"à🧪"}', event: "response.completed" },
		{ data: '{"eof":true}', event: null },
	];

	for (let split = 0; split <= bytes.byteLength; split++) {
		expect(frame([bytes.subarray(0, split), bytes.subarray(split)])).toEqual(
			expected,
		);
	}
});

test("one-byte chunks preserve CRLF and multibyte characters", () => {
	const bytes = encoder.encode('data: "naïve 🛰"\r\n\r\n');
	const chunks = Array.from(bytes, (_byte, index) =>
		bytes.subarray(index, index + 1),
	);
	expect(frame(chunks)).toEqual([{ data: '"naïve 🛰"', event: null }]);
});

test("EOF flushes a final line and frame, including a final CR line ending", () => {
	const withoutTerminator = new SseFramer();
	expect(withoutTerminator.push(encoder.encode("data: final"))).toEqual([]);
	expect(withoutTerminator.finish()).toEqual([{ data: "final", event: null }]);

	const withCr = new SseFramer();
	expect(withCr.push(encoder.encode("data: final\r"))).toEqual([]);
	expect(withCr.finish()).toEqual([{ data: "final", event: null }]);
});

test("rejects malformed UTF-8 instead of replacing bytes", () => {
	const framer = new SseFramer();
	let caught: unknown;
	try {
		framer.push(Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff));
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SseFramingError);
	expect((caught as SseFramingError).code).toBe("invalid_utf8");
});

test("rejects incomplete UTF-8 at EOF", () => {
	const framer = new SseFramer();
	framer.push(Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2));
	let caught: unknown;
	try {
		framer.finish();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SseFramingError);
	expect((caught as SseFramingError).code).toBe("invalid_utf8");
});

test("accounts for the whole body and accepts exactly 16 MiB", () => {
	const framer = new SseFramer();
	const body = new Uint8Array(MAX_SSE_BODY_BYTES);
	body.fill(0x0a);
	expect(framer.push(body)).toEqual([]);
	expect(framer.bytesRead).toBe(MAX_SSE_BODY_BYTES);
	expect(framer.finish()).toEqual([]);
});

test("rejects a body byte beyond the 16 MiB limit", () => {
	const framer = new SseFramer();
	const body = new Uint8Array(MAX_SSE_BODY_BYTES);
	body.fill(0x0a);
	framer.push(body);
	let caught: unknown;
	try {
		framer.push(Uint8Array.of(0x0a));
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SseFramingError);
	expect((caught as SseFramingError).code).toBe("body_too_large");
	expect(framer.bytesRead).toBe(MAX_SSE_BODY_BYTES);
});
