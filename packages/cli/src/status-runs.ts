import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentityObservation } from "../../core/src/queue/lock";
import type { JournalEvent } from "../../core/src/run/journal";
import { parseRunRecord, type RunRecord } from "../../core/src/run/store";
import type { StatusRun } from "../../core/src/status/derive";

export type OwnerInspector = (
	pid: number,
) => Promise<ProcessIdentityObservation>;

/** A failed inspection is unknown, never evidence that a live Build died. */
export async function inspectOwnerPid(
	pid: number,
): Promise<ProcessIdentityObservation> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
	try {
		process.kill(pid, 0);
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "ESRCH"
			? { kind: "dead" }
			: { kind: "unknown" };
	}
	try {
		const child = Bun.spawnSync({
			cmd: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
			stdout: "pipe",
			stderr: "ignore",
			env: { PATH: "/usr/bin:/bin", TZ: "UTC", LANG: "C" },
		});
		if (child.exitCode !== 0) return { kind: "unknown" };
		const startedMs = Date.parse(
			`${new TextDecoder().decode(child.stdout).trim()} UTC`,
		);
		return Number.isSafeInteger(startedMs)
			? { kind: "alive", startedMs }
			: { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

function validEvent(value: unknown): value is JournalEvent {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"event" in value &&
		typeof value.event === "string" &&
		"ts" in value &&
		Number.isSafeInteger(value.ts)
	);
}

export function parseStatusJournal(bytes: Uint8Array): {
	events: JournalEvent[];
	incompleteTail: boolean;
} {
	const events: JournalEvent[] = [];
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		content = new TextDecoder().decode(bytes);
	}
	const complete = content.endsWith("\n");
	const lines = content.split("\n");
	// A row is committed only by its terminating newline, even if its JSON parses.
	lines.pop();
	let incompleteTail = !complete && content.length > 0;
	for (const line of lines) {
		try {
			const value: unknown = JSON.parse(line);
			if (!validEvent(value)) throw new Error("Invalid journal event");
			events.push(value);
		} catch {
			incompleteTail = true;
			break;
		}
	}
	return { events, incompleteTail };
}

function ownerLiveness(
	record: RunRecord,
	observation: ProcessIdentityObservation,
): StatusRun["ownerLiveness"] {
	if (observation.kind === "dead") return "dead";
	if (observation.kind === "unknown") return "unknown";
	// ps reports whole seconds while the snapshot stores milliseconds.
	return Math.abs(observation.startedMs - record.owner_started_ms) < 1000
		? "live"
		: "dead";
}

/** Frozen v1.2 fixtures omit the v1.3 default recovery fields. */
function parseStatusRunRecord(bytes: Uint8Array) {
	const current = parseRunRecord(bytes);
	if (current.ok) return current;
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return current;
		const row = value as Record<string, unknown>;
		if (row.schema !== 2 || ("recovery" in row && "cleanup_pending" in row))
			return current;
		return parseRunRecord(
			new TextEncoder().encode(
				JSON.stringify({
					...row,
					...("recovery" in row ? {} : { recovery: [] }),
					...("cleanup_pending" in row ? {} : { cleanup_pending: false }),
				}),
			),
		);
	} catch {
		return current;
	}
}

export async function readStatusRuns(
	stateRoot: string,
	inspect: OwnerInspector = inspectOwnerPid,
): Promise<StatusRun[]> {
	const root = join(stateRoot, "runs");
	if (!existsSync(root)) return [];
	const runs: StatusRun[] = [];
	for (const runId of readdirSync(root)) {
		if (!/^[0-9a-f]{32}$/u.test(runId)) continue;
		const directory = join(root, runId);
		let snapshot: Uint8Array;
		try {
			snapshot = readFileSync(join(directory, "run.json"));
		} catch {
			continue;
		}
		const parsed = parseStatusRunRecord(snapshot);
		if (!parsed.ok || parsed.value.run_id !== runId) continue;
		let journal: Uint8Array;
		try {
			journal = readFileSync(join(directory, "events.jsonl"));
		} catch {
			journal = new Uint8Array();
		}
		const { events, incompleteTail } = parseStatusJournal(journal);
		const observation =
			parsed.value.status === "running"
				? await inspect(parsed.value.owner_pid)
				: { kind: "unknown" as const };
		runs.push({
			record: parsed.value,
			events,
			journalPath: directory,
			ownerLiveness: ownerLiveness(parsed.value, observation),
			journalIncompleteTail: incompleteTail,
			...(existsSync(join(directory, "candidate.diff"))
				? { candidateDiffPath: join(directory, "candidate.diff") }
				: {}),
		});
	}
	return runs;
}
