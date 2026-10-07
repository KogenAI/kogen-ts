import { expect, test } from "bun:test";
import {
	assembleResponses,
	type ResponseAssembly,
	type ResponseFailureClass,
} from "../../packages/core/src/provider/sse/assemble";
import {
	type SseFrame,
	SseFramer,
} from "../../packages/core/src/provider/sse/framing";

function frame(value: unknown, event?: string): SseFrame {
	return {
		data: typeof value === "string" ? value : JSON.stringify(value),
		event: event ?? null,
	};
}

function completed(
	output: unknown[] = [],
	usage: unknown = null,
	patch: Record<string, unknown> = {},
): SseFrame {
	return frame({
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			output,
			usage,
			...patch,
		},
	});
}

function expectFailure(
	result: ResponseAssembly,
	classification: ResponseFailureClass,
) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected response assembly failure");
	expect(result.class).toBe(classification);
	return result;
}

test("completed.output is authoritative and retains exact item JSON slices", () => {
	const collected = frame({
		type: "response.output_item.done",
		item: {
			type: "function_call",
			status: "completed",
			call_id: "call_wrong",
			name: "shell",
			arguments: "{}",
		},
	});
	const itemJson =
		'{ "type": "function_call", "status": "completed", "call_id": "call_right", "name": "shell", "arguments": "{\\"cmd\\":\\"true\\"}" }';
	const done = frame(
		`{"type":"response.completed","response":{"id":"resp_ok","status":"completed","output":[${itemJson}],"usage":{"input_tokens":50,"output_tokens":30,"input_tokens_details":{"cached_tokens":40},"cache_write_tokens":7,"output_tokens_details":{"reasoning_tokens":10}}}}`,
	);

	const result = assembleResponses([collected, done]);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.id).toBe("resp_ok");
	expect(result.raw_item_json).toEqual([itemJson]);
	expect(result.tool_calls).toEqual([
		{ id: "call_right", name: "shell", arguments: { cmd: "true" } },
	]);
	expect(result.usage).toEqual({
		input: 10,
		cached_input: 40,
		cache_write: 7,
		output: 30,
		reasoning: 10,
	});
});

test("assembles mixed SSE framing, a completed function call, and a final EOF frame", () => {
	const item = {
		type: "function_call",
		status: "completed",
		call_id: "call_sse_1",
		name: "shell",
		arguments: JSON.stringify({
			cmd: "printf 'Hello, Almir!\\n' > lib/greet.txt",
		}),
	};
	const encoder = new TextEncoder();
	const framer = new SseFramer();
	const bytes = [
		": keep-alive comment\r\n\r\n",
		`event: response.output_item.done\r\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\r\n\r\n`,
		"data: [DONE]\n\n",
		`data:{"type":"response.completed","response":{"id":"resp_sse","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5}}}`,
	].join("");
	const frames = [...framer.push(encoder.encode(bytes)), ...framer.finish()];
	const result = assembleResponses(frames);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.tool_calls).toEqual([
		{
			id: "call_sse_1",
			name: "shell",
			arguments: { cmd: "printf 'Hello, Almir!\\n' > lib/greet.txt" },
		},
	]);
});

test("falls back to output_item.done arrival order when completed.output is empty", () => {
	const first = {
		type: "message",
		content: [{ type: "output_text", text: "Hello" }],
	};
	const second = {
		type: "message",
		content: [
			{ type: "refusal", refusal: "ignored" },
			{ type: "output_text", text: ", world" },
		],
	};
	const result = assembleResponses([
		frame({ type: "response.output_item.done", item: first }),
		frame({ type: "response.output_item.done", item: second }),
		completed(),
	]);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.raw_items).toEqual([first, second]);
	expect(result.text).toBe("Hello, world");
});

test("a stream failure wins over a completed response and withholds all tool calls", () => {
	const proposal = {
		type: "function_call",
		status: "completed",
		call_id: "call_partial",
		name: "shell",
		arguments: { cmd: "touch should-not-run" },
	};
	const result = assembleResponses([
		frame({ type: "response.output_item.done", item: proposal }),
		completed([proposal]),
		frame({
			type: "response.failed",
			response: { status: "failed", error: { message: "overload" } },
		}),
	]);
	const failed = expectFailure(result, "overload");
	expect(failed.raw_items).toEqual([proposal]);
	expect("tool_calls" in failed).toBe(false);
});

test("error event classes follow usage limit, overload, then transport precedence", () => {
	const errors = [
		{ detail: "RATE_LIMIT reached", classification: "usage_limit" },
		{ detail: "overload", classification: "overload" },
		{ detail: "unknown provider failure", classification: "transport" },
	] as const;
	for (const { detail, classification } of errors) {
		const result = assembleResponses([
			frame({ type: "error", error: { message: detail } }),
		]);
		expectFailure(result, classification);
	}

	const topLevelErrorWins = assembleResponses([
		frame({
			type: "response.completed",
			response: { id: "resp_1", status: "completed", output: [] },
			error: { message: "usage_limit" },
		}),
	]);
	expectFailure(topLevelErrorWins, "usage_limit");
});

test("malformed data wins over completion and partial items remain available", () => {
	const partial = {
		type: "message",
		content: [{ type: "output_text", text: "before cut" }],
	};
	const result = assembleResponses([
		frame({ type: "response.output_item.done", item: partial }),
		completed(),
		frame("{not-json"),
	]);
	const failed = expectFailure(result, "malformed");
	expect(failed.raw_items).toEqual([partial]);
});

test("a provider failure wins over malformed frames, regardless of frame order", () => {
	const failure = frame({
		type: "response.failed",
		response: { error: { message: "overload" } },
	});
	const malformed = frame("not-json");
	expectFailure(assembleResponses([malformed, failure]), "overload");
	expectFailure(assembleResponses([failure, malformed]), "overload");
});

test("missing and duplicate completed events are malformed", () => {
	const partial = {
		type: "message",
		content: [{ type: "output_text", text: "partial" }],
	};
	const missing = assembleResponses([
		frame({ type: "response.output_item.done", item: partial }),
	]);
	expect(expectFailure(missing, "malformed").raw_items).toEqual([partial]);

	const duplicate = assembleResponses([completed(), completed()]);
	expectFailure(duplicate, "malformed");
});

test("response.incomplete retains partial output and usage but is never executable", () => {
	const partial = {
		type: "function_call",
		status: "completed",
		call_id: "call_partial",
		name: "shell",
		arguments: { cmd: "touch should-not-run" },
	};
	const result = assembleResponses([
		frame({ type: "response.output_item.done", item: partial }),
		frame({
			type: "response.incomplete",
			response: {
				id: "resp_cut",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [partial],
				usage: {
					input_tokens: 8,
					output_tokens: 3,
					input_tokens_details: { cached_tokens: 2 },
				},
			},
		}),
	]);
	const failed = expectFailure(result, "incomplete");
	expect(failed.message).toBe(
		"Model response incomplete (max_output_tokens); no tool calls were executed.",
	);
	expect(failed.raw_items).toEqual([partial]);
	expect(failed.usage).toEqual({
		input: 6,
		cached_input: 2,
		cache_write: null,
		output: 3,
		reasoning: null,
	});
});

test("malformed function arguments and required fields reject the whole response", () => {
	for (const item of [
		{
			type: "function_call",
			status: "completed",
			call_id: "c1",
			name: "shell",
			arguments: "{bad",
		},
		{
			type: "function_call",
			status: "completed",
			call_id: "c2",
			name: "shell",
			arguments: [],
		},
		{
			type: "function_call",
			status: "completed",
			call_id: "",
			name: "shell",
			arguments: {},
		},
		{
			type: "function_call",
			status: "completed",
			name: "shell",
			arguments: {},
		},
	]) {
		const result = assembleResponses([completed([item])]);
		expectFailure(result, "malformed");
	}
});

test("invalid usage makes a completed response malformed and exposes no calls", () => {
	const item = {
		type: "function_call",
		status: "completed",
		call_id: "call_1",
		name: "shell",
		arguments: {},
	};
	const failed = expectFailure(
		assembleResponses([
			completed([item], {
				input_tokens: 2,
				input_tokens_details: { cached_tokens: 3 },
			}),
		]),
		"malformed",
	);
	expect(failed.raw_items).toEqual([item]);
	expect(failed.usage).toBeNull();
});

test("in-progress function items are retained but not returned for execution", () => {
	const inProgress = {
		type: "function_call",
		status: "in_progress",
		call_id: "call_open",
		name: "shell",
		arguments: '{"cmd":"not yet complete"}',
	};
	const result = assembleResponses([completed([inProgress])]);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.raw_items).toEqual([inProgress]);
	expect(result.tool_calls).toEqual([]);
});
