import {
	decodeProtocolRequest,
	dispatchProtocolRequest,
	XspecProtocolError,
	type XspecSlice,
	type XspecSliceName,
} from "./protocol";
import { createApproveSlice } from "./slices/approve";
import { createIntentSlice } from "./slices/intent";
import { createQueueSlice } from "./slices/queue";
import { createSessionSlice } from "./slices/session";
import { createStatusSlice } from "./slices/status";
import { createStreamSlice } from "./slices/stream";

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const DECODER = new TextDecoder("utf-8", { fatal: true });

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

async function* inputLines(): AsyncGenerator<Uint8Array> {
	let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
	for await (const chunk of process.stdin) {
		pending = concatBytes(pending, new Uint8Array(chunk));
		if (pending.byteLength > MAX_LINE_BYTES && !pending.includes(0x0a))
			throw new XspecProtocolError(
				"invalid_request",
				"request line exceeds the 2 MiB protocol limit",
			);
		let start = 0;
		for (let index = 0; index < pending.byteLength; index += 1) {
			if (pending[index] !== 0x0a) continue;
			const line = pending.slice(start, index);
			if (line.byteLength > MAX_LINE_BYTES)
				throw new XspecProtocolError(
					"invalid_request",
					"request line exceeds the 2 MiB protocol limit",
				);
			yield line;
			start = index + 1;
		}
		pending = pending.slice(start);
	}
	if (pending.byteLength > 0) {
		if (pending.byteLength > MAX_LINE_BYTES)
			throw new XspecProtocolError(
				"invalid_request",
				"request line exceeds the 2 MiB protocol limit",
			);
		yield pending;
	}
}

function selectedSlice(): XspecSliceName {
	const fromArguments = process.argv
		.slice(1)
		.find((value) =>
			["approve", "intent", "queue", "status", "stream", "session"].includes(
				value,
			),
		);
	const fromEnvironment = process.env.XSPEC_SLICE?.split("/").at(-1);
	const selected = fromArguments ?? fromEnvironment;
	if (
		selected !== "approve" &&
		selected !== "intent" &&
		selected !== "queue" &&
		selected !== "status" &&
		selected !== "stream" &&
		selected !== "session"
	)
		throw new XspecProtocolError(
			"invalid_request",
			"select one xspec slice: approve, intent, queue, status, stream, or session",
		);
	return selected;
}

async function createSlice(name: XspecSliceName): Promise<XspecSlice> {
	switch (name) {
		case "approve":
			return createApproveSlice();
		case "intent":
			return createIntentSlice();
		case "queue":
			return createQueueSlice();
		case "status":
			return createStatusSlice();
		case "stream":
			return createStreamSlice();
		case "session":
			return createSessionSlice();
	}
}

async function run(): Promise<void> {
	const name = selectedSlice();
	const slice = await createSlice(name);
	try {
		for await (const bytes of inputLines()) {
			let line: string;
			try {
				line = DECODER.decode(bytes);
			} catch {
				throw new XspecProtocolError(
					"invalid_utf8",
					"request line is not valid UTF-8",
				);
			}
			const request = decodeProtocolRequest(line);
			const observation = await dispatchProtocolRequest(slice, request);
			const encoded = JSON.stringify(observation);
			if (encoded === undefined)
				throw new XspecProtocolError(
					"invalid_event",
					"slice returned an unserializable observation",
				);
			process.stdout.write(`${encoded}\n`);
		}
	} finally {
		await slice.close?.();
	}
}

run().catch((cause: unknown) => {
	if (cause instanceof XspecProtocolError)
		process.stderr.write(`kogen-xspec ${cause.code}: ${cause.message}\n`);
	else
		process.stderr.write(
			"kogen-xspec slice_failure: " +
				(cause instanceof Error ? cause.message : "unknown slice failure") +
				"\n",
		);
	process.exitCode = 70;
});
