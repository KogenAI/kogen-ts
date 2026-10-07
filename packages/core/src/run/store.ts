import type { PortError, Result } from "../contracts/errors";
import {
	appendFileBytes,
	type BytePathPublishRequest,
	publishFileAtomically,
} from "../fs/publish";
import type { FileSystemHostRequest } from "../fs/read";
import {
	encodeJsonLine,
	type JournalEvent,
	type JsonValue,
	sanitizeJournalEvent,
} from "./journal";

export type RunStatus = "running" | "landed" | "failed" | "parked" | "stopped";

export interface LandingRecord {
	readonly approval_commit: string;
	readonly run_id: string;
	readonly expected_parent: string;
	readonly final_tree: string;
	readonly candidate_commit: string;
}

export interface RecoveryRecord {
	readonly workspace: string;
	readonly base: string;
	readonly tree: string | null;
	readonly ref: string | null;
	readonly archive: string | null;
	readonly verification: "unverified";
}

export interface RunRecord {
	readonly schema: 2;
	readonly run_id: string;
	readonly slug: string;
	readonly approval_sha256: string;
	readonly approval_commit: string;
	readonly target_branch: string;
	readonly status: RunStatus;
	readonly landing: LandingRecord | null;
	readonly owner_pid: number;
	readonly owner_started_ms: number;
	readonly started_ms: number;
	readonly recovery: readonly RecoveryRecord[];
	readonly cleanup_pending: boolean;
}

export type RunStoreFailure = Readonly<{
	stage: "encode" | "snapshot";
	error: PortError;
	snapshotState: "not_attempted" | "unknown";
}>;

export type RunEventPersistenceFailure = Readonly<{
	stage: "encode" | "append" | "snapshot";
	error: PortError;
	eventState: "not_attempted" | "unknown" | "durable";
	snapshotState: "not_attempted" | "unknown";
}>;

export type RunEventPersistence =
	| {
			readonly ok: true;
			readonly value: {
				readonly record: RunRecord;
				readonly event: JournalEvent;
			};
	  }
	| { readonly ok: false; readonly error: RunEventPersistenceFailure };

export type LandingCasPersistence<T> =
	| { readonly ok: false; readonly error: RunEventPersistenceFailure }
	| {
			readonly ok: true;
			readonly record: RunRecord;
			readonly casResult: T;
	  };

const encoder = new TextEncoder();
const SHA1_OR_SHA256 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{32}$/;
const RUN_RECORD_KEYS = [
	"schema",
	"run_id",
	"slug",
	"approval_sha256",
	"approval_commit",
	"target_branch",
	"status",
	"landing",
	"owner_pid",
	"owner_started_ms",
	"started_ms",
	"recovery",
	"cleanup_pending",
] as const;
const LANDING_KEYS = [
	"approval_commit",
	"run_id",
	"expected_parent",
	"final_tree",
	"candidate_commit",
] as const;
const RECOVERY_KEYS = [
	"workspace",
	"base",
	"tree",
	"ref",
	"archive",
	"verification",
] as const;
const pathDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function portError(
	code: PortError["code"],
	message: string,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable: code === "io" || code === "unavailable",
		...(cause === undefined ? {} : { cause }),
	};
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value)
	);
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGitObjectId(value: unknown): value is string {
	return typeof value === "string" && SHA1_OR_SHA256.test(value);
}

function validateLanding(
	value: unknown,
	runId: string,
	approvalCommit: string,
): value is LandingRecord {
	if (!isObject(value) || !exactKeys(value, LANDING_KEYS)) return false;
	return (
		isGitObjectId(value.approval_commit) &&
		value.approval_commit === approvalCommit &&
		value.run_id === runId &&
		isGitObjectId(value.expected_parent) &&
		isGitObjectId(value.final_tree) &&
		isGitObjectId(value.candidate_commit)
	);
}

function validateRecovery(value: unknown): value is RecoveryRecord {
	if (!isObject(value) || !exactKeys(value, RECOVERY_KEYS)) return false;
	const hasRefTree = isGitObjectId(value.tree) && isNonEmptyText(value.ref);
	const hasArchive =
		value.tree === null && value.ref === null && isNonEmptyText(value.archive);
	return (
		isNonEmptyText(value.workspace) &&
		isGitObjectId(value.base) &&
		(value.tree === null || isGitObjectId(value.tree)) &&
		(value.ref === null || isNonEmptyText(value.ref)) &&
		(value.archive === null || isNonEmptyText(value.archive)) &&
		value.verification === "unverified" &&
		((hasRefTree && value.archive === null) || hasArchive)
	);
}

export function validateRunRecord(value: unknown): value is RunRecord {
	if (!isObject(value) || !exactKeys(value, RUN_RECORD_KEYS)) return false;
	if (
		value.schema !== 2 ||
		typeof value.run_id !== "string" ||
		!RUN_ID.test(value.run_id) ||
		!isNonEmptyText(value.slug) ||
		typeof value.approval_sha256 !== "string" ||
		!SHA256.test(value.approval_sha256) ||
		!isGitObjectId(value.approval_commit) ||
		!isNonEmptyText(value.target_branch) ||
		!(
			value.status === "running" ||
			value.status === "landed" ||
			value.status === "failed" ||
			value.status === "parked" ||
			value.status === "stopped"
		) ||
		!(
			value.landing === null ||
			validateLanding(value.landing, value.run_id, value.approval_commit)
		) ||
		!Number.isSafeInteger(value.owner_pid) ||
		(value.owner_pid as number) < 0 ||
		!isTimestamp(value.owner_started_ms) ||
		!isTimestamp(value.started_ms) ||
		!Array.isArray(value.recovery) ||
		!value.recovery.every(validateRecovery) ||
		typeof value.cleanup_pending !== "boolean"
	)
		return false;
	return true;
}

function makeSnapshotLine(record: RunRecord): Uint8Array {
	if (!validateRunRecord(record))
		throw new TypeError("Run snapshot does not match the schema-2 record.");
	const exact: JsonValue = {
		schema: 2,
		run_id: record.run_id,
		slug: record.slug,
		approval_sha256: record.approval_sha256,
		approval_commit: record.approval_commit,
		target_branch: record.target_branch,
		status: record.status,
		landing:
			record.landing === null
				? null
				: {
						approval_commit: record.landing.approval_commit,
						run_id: record.landing.run_id,
						expected_parent: record.landing.expected_parent,
						final_tree: record.landing.final_tree,
						candidate_commit: record.landing.candidate_commit,
					},
		owner_pid: record.owner_pid,
		owner_started_ms: record.owner_started_ms,
		started_ms: record.started_ms,
		recovery: record.recovery.map((entry) => ({
			workspace: entry.workspace,
			base: entry.base,
			tree: entry.tree,
			ref: entry.ref,
			archive: entry.archive,
			verification: entry.verification,
		})),
		cleanup_pending: record.cleanup_pending,
	};
	return encodeJsonLine(exact);
}

function pathRequest(
	runDirectory: string,
	path: string,
	bytes: Uint8Array,
): BytePathPublishRequest {
	const rootBytes = encoder.encode(runDirectory);
	const pathBytes = encoder.encode(path);
	if (
		!runDirectory.startsWith("/") ||
		runDirectory.includes("\0") ||
		pathDecoder.decode(rootBytes) !== runDirectory ||
		pathDecoder.decode(pathBytes) !== path
	)
		throw new TypeError("Run path is not a valid absolute Unicode path.");
	return {
		root: rootBytes,
		path: pathBytes,
		bytes,
	};
}

export function epochMilliseconds(now: () => number = Date.now): number {
	const timestamp = now();
	if (!isTimestamp(timestamp))
		throw new RangeError(
			"Clock must return epoch milliseconds as a safe integer.",
		);
	return timestamp;
}

export function createJournalEvent<
	T extends Readonly<Record<string, JsonValue>>,
>(event: string, fields: T, now: () => number = Date.now): JournalEvent {
	if (
		!isNonEmptyText(event) ||
		Object.hasOwn(fields, "event") ||
		Object.hasOwn(fields, "ts")
	)
		throw new TypeError("Journal event name or fields are invalid.");
	return sanitizeJournalEvent({
		...fields,
		event,
		ts: epochMilliseconds(now),
	} as JournalEvent);
}

export function applyRunEventToRecord(
	record: RunRecord,
	event: JournalEvent,
): RunRecord {
	if (!validateRunRecord(record))
		throw new TypeError("Current run record is invalid.");
	if (
		!Number.isSafeInteger(event.ts) ||
		event.ts < 0 ||
		!isNonEmptyText(event.event)
	)
		throw new TypeError(
			"Journal event requires an epoch-millisecond timestamp.",
		);
	let next: RunRecord = record;
	switch (event.event) {
		case "landing_prepared": {
			if (
				!validateLanding(event.landing, record.run_id, record.approval_commit)
			)
				throw new TypeError(
					"landing_prepared must contain the matching landing record.",
				);
			next = { ...record, landing: event.landing };
			break;
		}
		case "finished":
		case "reconciled": {
			const status = event.status;
			if (
				status !== "landed" &&
				status !== "failed" &&
				status !== "parked" &&
				status !== "stopped"
			)
				throw new TypeError(`${event.event} must contain a terminal status.`);
			next = { ...record, status };
			break;
		}
		case "recovery_preserved": {
			const recovery: RecoveryRecord = {
				workspace: event.workspace as string,
				base: event.base as string,
				tree: (event.tree ?? null) as string | null,
				ref: (event.ref ?? null) as string | null,
				archive: (event.archive ?? null) as string | null,
				verification: event.verification as "unverified",
			};
			if (!validateRecovery(recovery))
				throw new TypeError(
					"recovery_preserved fields do not form a durable record.",
				);
			const existing = record.recovery.find(
				(entry) =>
					entry.ref === recovery.ref && entry.archive === recovery.archive,
			);
			if (existing) {
				if (
					existing.workspace !== recovery.workspace ||
					existing.base !== recovery.base ||
					existing.tree !== recovery.tree
				)
					throw new TypeError(
						"A create-only recovery identity cannot be changed.",
					);
			} else {
				next = { ...record, recovery: [...record.recovery, recovery] };
			}
			break;
		}
		case "cleanup_failure":
			next = { ...record, cleanup_pending: true };
			break;
	}
	if (!validateRunRecord(next))
		throw new TypeError("Event produced an invalid run snapshot.");
	return next;
}

export async function writeRunSnapshot(
	host: FileSystemHostRequest,
	runDirectory: string,
	record: RunRecord,
): Promise<Result<void, RunStoreFailure>> {
	let line: Uint8Array;
	let request: BytePathPublishRequest;
	try {
		line = makeSnapshotLine(record);
		request = pathRequest(runDirectory, "run.json", line);
	} catch (cause) {
		return {
			ok: false,
			error: {
				stage: "encode",
				error: portError("invalid_input", "Run snapshot is invalid.", cause),
				snapshotState: "not_attempted",
			},
		};
	}
	const published = await publishFileAtomically(host, request, 0o600);
	if (!published.ok)
		return {
			ok: false,
			error: {
				stage: "snapshot",
				error: published.error,
				snapshotState: "unknown",
			},
		};
	return { ok: true, value: undefined };
}

export async function appendRunEventBeforeSnapshot(
	host: FileSystemHostRequest,
	runDirectory: string,
	current: RunRecord,
	event: JournalEvent,
): Promise<RunEventPersistence> {
	let next: RunRecord;
	let safeEvent: JournalEvent;
	let eventLine: Uint8Array;
	let snapshotLine: Uint8Array;
	let eventRequest: BytePathPublishRequest;
	let snapshotRequest: BytePathPublishRequest;
	try {
		safeEvent = sanitizeJournalEvent(event);
		next = applyRunEventToRecord(current, safeEvent);
		eventLine = encodeJsonLine(safeEvent);
		snapshotLine = makeSnapshotLine(next);
		eventRequest = pathRequest(runDirectory, "events.jsonl", eventLine);
		snapshotRequest = pathRequest(runDirectory, "run.json", snapshotLine);
	} catch (cause) {
		return {
			ok: false,
			error: {
				stage: "encode",
				error: portError(
					"invalid_input",
					"Run event or resulting snapshot is invalid.",
					cause,
				),
				eventState: "not_attempted",
				snapshotState: "not_attempted",
			},
		};
	}
	const appended = await appendFileBytes(host, eventRequest);
	if (!appended.ok)
		return {
			ok: false,
			error: {
				stage: "append",
				error: appended.error,
				eventState: "unknown",
				snapshotState: "not_attempted",
			},
		};
	const snapshot = await publishFileAtomically(host, snapshotRequest, 0o600);
	if (!snapshot.ok)
		return {
			ok: false,
			error: {
				stage: "snapshot",
				error: snapshot.error,
				eventState: "durable",
				snapshotState: "unknown",
			},
		};
	return { ok: true, value: { record: next, event: safeEvent } };
}

/** The callback runs only after landing_prepared is appended and run.json is replaced. */
export async function persistLandingPreparedBeforeCas<T>(
	host: FileSystemHostRequest,
	runDirectory: string,
	current: RunRecord,
	event: JournalEvent,
	baseCas: (record: RunRecord) => Promise<T>,
): Promise<LandingCasPersistence<T>> {
	if (event.event !== "landing_prepared")
		throw new TypeError("Base CAS requires a landing_prepared event.");
	const persisted = await appendRunEventBeforeSnapshot(
		host,
		runDirectory,
		current,
		event,
	);
	if (!persisted.ok) return persisted;
	const casResult = await baseCas(persisted.value.record);
	return { ok: true, record: persisted.value.record, casResult };
}

export function parseRunRecord(bytes: Uint8Array): Result<RunRecord> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return {
			ok: false,
			error: portError("invalid_input", "run.json is not valid UTF-8."),
		};
	}
	if (text.endsWith("\n")) text = text.slice(0, -1);
	if (text.includes("\n"))
		return {
			ok: false,
			error: portError("invalid_input", "run.json has multiple lines."),
		};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: portError("invalid_input", "run.json is invalid JSON."),
		};
	}
	if (!validateRunRecord(value))
		return {
			ok: false,
			error: portError("invalid_input", "run.json does not match schema 2."),
		};
	return { ok: true, value };
}
