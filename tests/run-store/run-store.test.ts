import { expect, test } from "bun:test";
import {
	FILESYSTEM_PUBLISH_ACTION,
	FILESYSTEM_PUBLISH_HOST_OPERATION,
} from "../../packages/core/src/fs/publish";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
	FileSystemStatus,
} from "../../packages/core/src/fs/read";
import {
	appendRequestAttempt,
	decodeJsonLines,
	encodeJsonLine,
	makeRequestAttemptRecord,
	redactSensitiveText,
} from "../../packages/core/src/run/journal";
import {
	appendRunEventBeforeSnapshot,
	applyRunEventToRecord,
	createJournalEvent,
	epochMilliseconds,
	parseRunRecord,
	persistLandingPreparedBeforeCas,
	type RunRecord,
	validateRunRecord,
	writeRunSnapshot,
} from "../../packages/core/src/run/store";
import {
	appendTranscriptText,
	writeSafeCandidateDiff,
	writeSafeLog,
} from "../../packages/core/src/run/transcript";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryFileSystemHost implements FileSystemHostRequest {
	readonly files = new Map<string, Uint8Array>();
	readonly modes = new Map<string, number>();
	readonly operations: string[] = [];
	failNextAppend = false;
	failNextAtomicBefore = false;
	failNextAtomicAfter = false;

	async request(operation: number, payload: Uint8Array): Promise<Uint8Array> {
		if (operation === FILESYSTEM_PUBLISH_HOST_OPERATION)
			return this.publish(payload);
		if (operation === FILESYSTEM_HOST_OPERATION) return this.read(payload);
		throw new Error(`unexpected host operation ${operation}`);
	}

	private publish(payload: Uint8Array): Uint8Array {
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const action = payload[0];
		const rootLength = view.getUint32(4, false);
		const pathLength = view.getUint32(8, false);
		const bytesLength = view.getUint32(12, false);
		const root = decoder.decode(payload.subarray(16, 16 + rootLength));
		const path = decoder.decode(
			payload.subarray(16 + rootLength, 16 + rootLength + pathLength),
		);
		const value = payload.subarray(16 + rootLength + pathLength);
		if (value.byteLength !== bytesLength) throw new Error("bad fixture frame");
		const key = `${root}/${path}`;
		if (action === FILESYSTEM_PUBLISH_ACTION.append) {
			this.operations.push(`append:${path}`);
			if (this.failNextAppend) {
				this.failNextAppend = false;
				return Uint8Array.of(FileSystemStatus.io);
			}
			const previous = this.files.get(key) ?? new Uint8Array();
			const appended = new Uint8Array(previous.byteLength + value.byteLength);
			appended.set(previous);
			appended.set(value, previous.byteLength);
			this.files.set(key, appended);
			this.modes.set(key, 0o600);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action !== FILESYSTEM_PUBLISH_ACTION.atomicWrite)
			throw new Error(`unexpected publish action ${action}`);
		this.operations.push(`atomic:${path}`);
		if (this.failNextAtomicBefore) {
			this.failNextAtomicBefore = false;
			return Uint8Array.of(FileSystemStatus.io);
		}
		this.files.set(key, value.slice());
		this.modes.set(key, view.getUint16(2, false));
		if (this.failNextAtomicAfter) {
			this.failNextAtomicAfter = false;
			return Uint8Array.of(FileSystemStatus.io);
		}
		return Uint8Array.of(FileSystemStatus.ok);
	}

	private read(payload: Uint8Array): Uint8Array {
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const rootLength = view.getUint32(9, false);
		const pathLength = view.getUint32(13, false);
		const root = decoder.decode(payload.subarray(17, 17 + rootLength));
		const path = decoder.decode(
			payload.subarray(17 + rootLength, 17 + rootLength + pathLength),
		);
		this.operations.push(`read:${path}`);
		const value = this.files.get(`${root}/${path}`);
		if (!value) return Uint8Array.of(FileSystemStatus.notFound);
		const result = new Uint8Array(value.byteLength + 1);
		result.set(value, 1);
		return result;
	}
}

const initialRun: RunRecord = {
	schema: 2,
	run_id: "a".repeat(32),
	slug: "greet",
	approval_sha256: "b".repeat(64),
	approval_commit: "c".repeat(40),
	target_branch: "main",
	status: "running",
	landing: null,
	owner_pid: 321,
	owner_started_ms: 1_780_000_000_000,
	started_ms: 1_780_000_000_001,
	recovery: [],
	cleanup_pending: false,
};

function decodeSnapshot(host: MemoryFileSystemHost): RunRecord {
	const bytes = host.files.get("/runs/run-a/run.json");
	if (!bytes) throw new Error("run.json was not written");
	const parsed = parseRunRecord(bytes);
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

test("schema 2 includes draft recovery and cleanup fields with exact defaults", () => {
	expect(validateRunRecord(initialRun)).toBe(true);
	const host = new MemoryFileSystemHost();
	return writeRunSnapshot(host, "/runs/run-a", initialRun).then((result) => {
		expect(result.ok).toBe(true);
		expect(decodeSnapshot(host)).toEqual(initialRun);
		expect(host.modes.get("/runs/run-a/run.json")).toBe(0o600);
		expect(() => encodeJsonLine({ token_count: 4.5 })).toThrow("safe integers");
		expect(decodeJsonLines(encoder.encode('{"event":"partial"}')).ok).toBe(
			false,
		);
	});
});

test("recovery and cleanup-pending events update schema-2 snapshot fields", () => {
	const recoveryEvent = createJournalEvent(
		"recovery_preserved",
		{
			workspace: "run-a-R1",
			base: "1".repeat(40),
			tree: "2".repeat(40),
			ref: `refs/kogen/candidates/${initialRun.run_id}/recovery-run-a-R1`,
			archive: null,
			verification: "unverified",
		},
		() => 1_780_000_000_050,
	);
	const preserved = applyRunEventToRecord(initialRun, recoveryEvent);
	expect(preserved.recovery).toEqual([
		{
			workspace: "run-a-R1",
			base: "1".repeat(40),
			tree: "2".repeat(40),
			ref: `refs/kogen/candidates/${initialRun.run_id}/recovery-run-a-R1`,
			archive: null,
			verification: "unverified",
		},
	]);
	const failed = applyRunEventToRecord(
		preserved,
		createJournalEvent(
			"cleanup_failure",
			{ detail: "workspace retained; retry required" },
			() => 1_780_000_000_100,
		),
	);
	expect(failed.cleanup_pending).toBe(true);
	expect(validateRunRecord(failed)).toBe(true);
});

test("event append is durable before the atomic run snapshot update", async () => {
	const host = new MemoryFileSystemHost();
	await writeRunSnapshot(host, "/runs/run-a", initialRun);
	host.operations.length = 0;
	const event = createJournalEvent(
		"plan",
		{ difficulty: "easy", wall_ms: 125 },
		() => 1_780_000_000_125,
	);
	const result = await appendRunEventBeforeSnapshot(
		host,
		"/runs/run-a",
		initialRun,
		event,
	);
	expect(result.ok).toBe(true);
	expect(host.operations).toEqual(["append:events.jsonl", "atomic:run.json"]);
	const events = host.files.get("/runs/run-a/events.jsonl");
	if (!events) throw new Error("events.jsonl was not appended");
	expect(decodeJsonLines(events)).toEqual({ ok: true, value: [event] });
	expect(decodeSnapshot(host)).toEqual(initialRun);
	if (result.ok) expect(result.value.record).toEqual(initialRun);
});

test("append failure leaves the snapshot untouched", async () => {
	const host = new MemoryFileSystemHost();
	await writeRunSnapshot(host, "/runs/run-a", initialRun);
	const oldSnapshot = host.files.get("/runs/run-a/run.json")?.slice();
	host.failNextAppend = true;
	const event = createJournalEvent(
		"finished",
		{ status: "failed" },
		() => 1_780_000_000_200,
	);
	const result = await appendRunEventBeforeSnapshot(
		host,
		"/runs/run-a",
		initialRun,
		event,
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.stage).toBe("append");
		expect(result.error.eventState).toBe("unknown");
		expect(result.error.snapshotState).toBe("not_attempted");
	}
	expect(host.files.has("/runs/run-a/events.jsonl")).toBe(false);
	expect(host.files.get("/runs/run-a/run.json")).toEqual(oldSnapshot);
});

test("crash after journal append but before rename leaves a replayable landing", async () => {
	const host = new MemoryFileSystemHost();
	await writeRunSnapshot(host, "/runs/run-a", initialRun);
	const landing = {
		approval_commit: initialRun.approval_commit,
		run_id: initialRun.run_id,
		expected_parent: "d".repeat(40),
		final_tree: "e".repeat(40),
		candidate_commit: "f".repeat(40),
	};
	const event = createJournalEvent(
		"landing_prepared",
		{ landing },
		() => 1_780_000_000_300,
	);
	host.failNextAtomicBefore = true;
	const result = await appendRunEventBeforeSnapshot(
		host,
		"/runs/run-a",
		initialRun,
		event,
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.stage).toBe("snapshot");
		expect(result.error.eventState).toBe("durable");
		expect(result.error.snapshotState).toBe("unknown");
	}
	const eventsBytes = host.files.get("/runs/run-a/events.jsonl");
	if (!eventsBytes) throw new Error("append was not durable");
	const events = decodeJsonLines(eventsBytes);
	expect(events.ok).toBe(true);
	const stale = decodeSnapshot(host);
	expect(stale.landing).toBeNull();
	if (events.ok) {
		const recoveryEvent = events.value[0];
		if (
			!recoveryEvent ||
			typeof recoveryEvent !== "object" ||
			Array.isArray(recoveryEvent)
		)
			throw new Error("landing event was not parsed");
		const recovered = applyRunEventToRecord(
			stale,
			recoveryEvent as typeof event,
		);
		expect(recovered.landing).toEqual(landing);
	}
});

test("base CAS runs only after the landing record is durable", async () => {
	const host = new MemoryFileSystemHost();
	await writeRunSnapshot(host, "/runs/run-a", initialRun);
	const landing = {
		approval_commit: initialRun.approval_commit,
		run_id: initialRun.run_id,
		expected_parent: "d".repeat(40),
		final_tree: "e".repeat(40),
		candidate_commit: "f".repeat(40),
	};
	const event = createJournalEvent(
		"landing_prepared",
		{ landing },
		() => 1_780_000_000_350,
	);
	host.operations.length = 0;
	const result = await persistLandingPreparedBeforeCas(
		host,
		"/runs/run-a",
		initialRun,
		event,
		async (record) => {
			expect(decodeSnapshot(host).landing).toEqual(landing);
			expect(record.landing).toEqual(landing);
			host.operations.push("base-cas");
			return "updated";
		},
	);
	expect(result.ok).toBe(true);
	expect(host.operations).toEqual([
		"append:events.jsonl",
		"atomic:run.json",
		"base-cas",
	]);
	if (result.ok) expect(result.casResult).toBe("updated");
});

test("rename may be durable even when its acknowledgement is lost", async () => {
	const host = new MemoryFileSystemHost();
	await writeRunSnapshot(host, "/runs/run-a", initialRun);
	const event = createJournalEvent(
		"finished",
		{ status: "landed" },
		() => 1_780_000_000_400,
	);
	host.failNextAtomicAfter = true;
	const result = await appendRunEventBeforeSnapshot(
		host,
		"/runs/run-a",
		initialRun,
		event,
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.error.stage).toBe("snapshot");
		expect(result.error.eventState).toBe("durable");
		expect(result.error.snapshotState).toBe("unknown");
	}
	expect(decodeSnapshot(host).status).toBe("landed");
});

test("request attempt records redact routing secrets and retain null usage", async () => {
	const secret = "sk-live-12345678901234567890";
	const host = new MemoryFileSystemHost();
	const result = await appendRequestAttempt(host, "/runs/run-a", {
		attempt_id: "req-1",
		stage: "build",
		rung: "R1",
		provider: "chatgpt",
		adapter: "responses",
		model: "gpt-6-luna",
		effort: "max",
		endpoint_url: `https://private-user:${secret}@api.example.invalid/v1/responses?api_key=${secret}`,
		header_names: ["Authorization", "Content-Type", "thread-id"],
		cache_key: "cache-key-1",
		thread_id: "thread-1",
		conversation_id: "thread-1",
		request_bytes: 923,
		prefix_sha256: "1".repeat(64),
		started_ms: 1_780_000_000_500,
		ended_ms: 1_780_000_000_625,
		cut_after_ms: null,
		resumed: false,
		tokens: {
			input: null,
			cached_input: null,
			cache_write: null,
			output: null,
			reasoning: null,
		},
	});
	expect(result.ok).toBe(true);
	const transcript = host.files.get("/runs/run-a/transcript.jsonl");
	if (!transcript) throw new Error("request metadata was not appended");
	const rendered = decoder.decode(transcript);
	expect(rendered).not.toContain(secret);
	expect(rendered).not.toContain("private-user");
	expect(rendered).not.toContain("api_key=");
	expect(rendered).not.toContain("Bearer ");
	if (result.ok) {
		expect(result.value.endpoint).toEqual({
			host: "api.example.invalid",
			path: "/v1/responses",
		});
		expect(result.value.tokens).toEqual({
			input: null,
			cached_input: null,
			cache_write: null,
			output: null,
			reasoning: null,
		});
		expect(result.value.started_ms).toBe(1_780_000_000_500);
		expect(result.value.ended_ms - result.value.started_ms).toBe(125);
	}
	expect(() =>
		makeRequestAttemptRecord({
			attempt_id: "req-2",
			stage: "build",
			rung: null,
			provider: "chatgpt",
			adapter: "responses",
			model: "gpt-6-luna",
			effort: "max",
			endpoint_url: "https://api.example.invalid/v1",
			header_names: [],
			cache_key: null,
			thread_id: null,
			conversation_id: null,
			request_bytes: 0,
			prefix_sha256: null,
			started_ms: 1_780_000_000_700,
			ended_ms: 1_780_000_000_600,
			cut_after_ms: null,
			resumed: false,
			tokens: {
				input: null,
				cached_input: null,
				cache_write: null,
				output: null,
				reasoning: null,
			},
		}),
	).toThrow("ordered epoch milliseconds");
});

test("transcript, log, and diff writers redact secret material", async () => {
	const secret = "ghp_0123456789abcdefghijABCDEFGHIJ";
	const host = new MemoryFileSystemHost();
	const transcript = await appendTranscriptText(host, "/runs/run-a", {
		kind: "assistant_text",
		stage: "shape",
		rung: null,
		turn: 1,
		ts: 1_780_000_000_800,
		text: `Authorization: Bearer ${secret}\nSuggested output`,
	});
	const log = await writeSafeLog(
		host,
		"/runs/run-a",
		"test.log",
		encoder.encode(`TOKEN=${secret}\noutput`),
	);
	const diff = await writeSafeCandidateDiff(
		host,
		"/runs/run-a",
		"candidate.diff",
		encoder.encode(`+api_key=${secret}\n+safe change`),
	);
	expect(transcript.ok && log.ok && diff.ok).toBe(true);
	for (const path of [
		"/runs/run-a/transcript.jsonl",
		"/runs/run-a/logs/test.log",
		"/runs/run-a/candidate.diff",
	]) {
		const bytes = host.files.get(path);
		if (!bytes) throw new Error(`${path} was not written`);
		expect(decoder.decode(bytes)).not.toContain(secret);
		expect(host.modes.get(path)).toBe(0o600);
	}
	expect(redactSensitiveText("plain text")).toBe("plain text");
});

test("timestamps are epoch milliseconds and unsafe numbers are rejected", () => {
	const expected = 1_780_000_000_999;
	expect(epochMilliseconds(() => expected)).toBe(expected);
	expect(() => epochMilliseconds(() => 12.5)).toThrow("safe integer");
	expect(() => epochMilliseconds(() => Number.MAX_SAFE_INTEGER + 1)).toThrow(
		"safe integer",
	);
});
