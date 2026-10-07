import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	AcceptanceAdapter,
	AcceptanceLedgerRow,
	AdapterLog,
	AdapterRunResult,
} from "../adapters/interface";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../fs/read";
import { isValidIntentSlug } from "../intent/parse";

export type AcceptanceItemStatus = "pass" | "fail";

export type AcceptanceFailureClass =
	| "tool_missing"
	| "acceptance_compile_failed"
	| "no_tagged_tests"
	| "ledger_invalid"
	| "tree_mutated"
	| "acceptance_timeout"
	| "suite";

export type AcceptanceFailureScope = "environment" | "candidate";

export interface AcceptanceFailure {
	readonly classification: AcceptanceFailureClass;
	readonly scope: AcceptanceFailureScope;
	readonly message: string;
}

export interface AcceptanceItemResult {
	readonly id: string;
	readonly status: AcceptanceItemStatus;
	readonly rows: readonly AcceptanceLedgerRow[];
}

export type LedgerReportState = "missing" | "empty" | "valid" | "malformed";

export interface AcceptanceLedgerResult {
	readonly reportState: LedgerReportState;
	readonly rows: readonly AcceptanceLedgerRow[];
	readonly items: readonly AcceptanceItemResult[];
	readonly unknownTags: readonly string[];
	readonly failures: readonly AcceptanceFailure[];
	readonly treeBefore: string;
	readonly treeAfter: string;
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
}

export interface EvaluateAcceptanceLedgerInput {
	readonly slug: string;
	readonly itemIds: readonly string[];
	readonly run: AdapterRunResult;
	/** null means the report path was absent; malformedRead covers an unreadable oversized report. */
	readonly report: Uint8Array | null;
	readonly malformedRead?: boolean;
	readonly treeBefore: string;
	readonly treeAfter: string;
	readonly adapterUnavailable?: (log: AdapterLog) => boolean;
}

export interface AcceptanceTreeSnapshot {
	snapshot(): Promise<Result<string>>;
}

export interface RunAcceptanceLedgerRequest {
	readonly adapter: AcceptanceAdapter;
	readonly process: Pick<ProcessPort, "run">;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "removeFile">;
	readonly tree: AcceptanceTreeSnapshot;
	readonly workdir: string;
	readonly slug: string;
	readonly itemIds: readonly string[];
	readonly reportDirectory: string;
	readonly reportFilename: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMilliseconds: number;
}

const MAX_LEDGER_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const ITEM_ID_PATTERN = /^A[1-9][0-9]*$/u;
const ROW_STATUSES = new Set([
	"passed",
	"failed",
	"skipped",
	"excluded",
	"invalid",
]);

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function failure(
	classification: AcceptanceFailureClass,
	message: string,
): AcceptanceFailure {
	return {
		classification,
		scope: classification === "tool_missing" ? "environment" : "candidate",
		message,
	};
}

function parseRow(value: unknown): AcceptanceLedgerRow | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (
		keys.length !== 3 ||
		!Object.hasOwn(record, "tag") ||
		!Object.hasOwn(record, "test") ||
		!Object.hasOwn(record, "status") ||
		typeof record.tag !== "string" ||
		record.tag.length === 0 ||
		typeof record.test !== "string" ||
		record.test.length === 0 ||
		typeof record.status !== "string" ||
		!ROW_STATUSES.has(record.status)
	)
		return null;
	return {
		tag: record.tag,
		test: record.test,
		status: record.status as AcceptanceLedgerRow["status"],
	};
}

function parseReport(
	bytes: Uint8Array | null,
	malformedRead: boolean,
): {
	readonly state: LedgerReportState;
	readonly rows: readonly AcceptanceLedgerRow[];
} {
	if (malformedRead) return { state: "malformed", rows: [] };
	if (bytes === null) return { state: "missing", rows: [] };
	if (bytes.byteLength === 0) return { state: "empty", rows: [] };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { state: "malformed", rows: [] };
	}
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return { state: "empty", rows: [] };
	const rows: AcceptanceLedgerRow[] = [];
	for (const line of lines) {
		if (line.length === 0) return { state: "malformed", rows: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return { state: "malformed", rows: [] };
		}
		const row = parseRow(parsed);
		if (row === null) return { state: "malformed", rows: [] };
		rows.push(row);
	}
	return rows.length === 0
		? { state: "empty", rows: [] }
		: { state: "valid", rows };
}

function validateItems(
	slug: string,
	itemIds: readonly string[],
): PortError | null {
	if (!isValidIntentSlug(slug))
		return portError("invalid_input", "Acceptance slug is invalid.");
	const seen = new Set<string>();
	for (const id of itemIds) {
		if (!ITEM_ID_PATTERN.test(id))
			return portError(
				"invalid_input",
				`Acceptance item id is invalid: ${id}.`,
			);
		if (seen.has(id))
			return portError(
				"invalid_input",
				`Acceptance item id is duplicated: ${id}.`,
			);
		seen.add(id);
	}
	return null;
}

function buildItems(
	slug: string,
	itemIds: readonly string[],
	rows: readonly AcceptanceLedgerRow[],
): {
	readonly items: readonly AcceptanceItemResult[];
	readonly unknownTags: readonly string[];
} {
	const known = new Set(itemIds.map((id) => `${slug}/${id}`));
	const rowsByItem = new Map<string, AcceptanceLedgerRow[]>();
	const unknown = new Set<string>();
	for (const row of rows) {
		if (!known.has(row.tag)) {
			unknown.add(row.tag);
			continue;
		}
		const values = rowsByItem.get(row.tag);
		if (values === undefined) rowsByItem.set(row.tag, [row]);
		else values.push(row);
	}
	const items = itemIds.map((id): AcceptanceItemResult => {
		const itemRows = rowsByItem.get(`${slug}/${id}`) ?? [];
		return {
			id,
			status:
				itemRows.length > 0 && itemRows.every((row) => row.status === "passed")
					? "pass"
					: "fail",
			rows: itemRows,
		};
	});
	return { items, unknownTags: [...unknown].sort(compareUtf8) };
}

function compareUtf8(left: string, right: string): number {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	const limit = Math.min(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < limit; index += 1) {
		const leftByte = leftBytes[index] ?? 0;
		const rightByte = rightBytes[index] ?? 0;
		if (leftByte !== rightByte) return leftByte - rightByte;
	}
	return leftBytes.byteLength - rightBytes.byteLength;
}

/** Classify one runner/report observation according to §2.4.1. */
export function evaluateAcceptanceLedger(
	input: EvaluateAcceptanceLedgerInput,
): Result<AcceptanceLedgerResult> {
	const invalid = validateItems(input.slug, input.itemIds);
	if (invalid !== null) return { ok: false, error: invalid };
	if (input.treeBefore.length === 0 || input.treeAfter.length === 0)
		return {
			ok: false,
			error: portError("invalid_input", "Acceptance tree identity is empty."),
		};

	const parsed = parseReport(input.report, input.malformedRead ?? false);
	const { items, unknownTags } = buildItems(
		input.slug,
		input.itemIds,
		parsed.rows,
	);
	const failures: AcceptanceFailure[] = [];
	if (input.treeBefore !== input.treeAfter)
		failures.push(
			failure("tree_mutated", "Acceptance runner changed the verified tree."),
		);
	const unavailable =
		input.run.exitStatus === null ||
		input.run.exitStatus === 126 ||
		input.run.exitStatus === 127 ||
		(input.adapterUnavailable?.(input.run.log) ?? false);
	if (input.run.timedOut) {
		failures.push(
			failure("acceptance_timeout", "Acceptance runner timed out."),
		);
	} else if (
		parsed.state === "missing" ||
		parsed.state === "empty" ||
		parsed.state === "malformed"
	) {
		if (unavailable) {
			failures.push(
				failure(
					"tool_missing",
					"Acceptance runner was unavailable before producing a usable ledger.",
				),
			);
		} else if (parsed.state === "empty" && input.run.exitStatus !== 0) {
			failures.push(
				failure(
					"acceptance_compile_failed",
					"Acceptance runner exited non-zero without any test rows.",
				),
			);
		} else if (parsed.state === "empty") {
			failures.push(
				failure("no_tagged_tests", "Acceptance runner produced no test rows."),
			);
		} else {
			failures.push(
				failure(
					"ledger_invalid",
					parsed.state === "missing"
						? "Acceptance runner did not create a ledger report."
						: "Acceptance ledger contains a malformed JSONL row.",
				),
			);
		}
	}

	if (parsed.state === "valid") {
		const allItemsPass = items.every((item) => item.status === "pass");
		if (unknownTags.length > 0)
			failures.push(
				failure(
					"suite",
					`Acceptance ledger contains unknown tags: ${unknownTags.join(", ")}.`,
				),
			);
		if (input.run.exitStatus !== 0 && allItemsPass)
			failures.push(
				failure(
					"suite",
					"Acceptance runner exited non-zero although every approved item passed.",
				),
			);
	}

	return {
		ok: true,
		value: {
			reportState: parsed.state,
			rows: parsed.rows,
			items,
			unknownTags,
			failures,
			treeBefore: input.treeBefore,
			treeAfter: input.treeAfter,
			exitStatus: input.run.exitStatus,
			timedOut: input.run.timedOut,
		},
	};
}

function safeReportFilename(value: string): boolean {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/[\0\r\n]/u.test(value)
	)
		return false;
	return value
		.split("/")
		.every(
			(component) =>
				component.length > 0 &&
				component !== "." &&
				component !== ".." &&
				component !== ".git",
		);
}

function reportPathIsContained(directory: string, filename: string): boolean {
	const root = resolve(directory);
	const path = resolve(root, filename);
	const fromRoot = relative(root, path);
	return (
		fromRoot.length > 0 &&
		fromRoot !== ".." &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot)
	);
}

/**
 * Run an adapter against the captured tree, remove stale report bytes first,
 * then parse the new JSONL report and compare the post-run tree identity.
 */
export async function runAcceptanceLedger(
	request: RunAcceptanceLedgerRequest,
): Promise<Result<AcceptanceLedgerResult>> {
	const invalidItems = validateItems(request.slug, request.itemIds);
	if (invalidItems !== null) return { ok: false, error: invalidItems };
	if (
		!isAbsolute(request.workdir) ||
		!isAbsolute(request.reportDirectory) ||
		!safeReportFilename(request.reportFilename) ||
		!reportPathIsContained(request.reportDirectory, request.reportFilename) ||
		pathIsWithin(request.workdir, request.reportDirectory)
	)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Acceptance ledger report path must be a safe file under its run directory.",
			),
		};
	const reportPath = join(request.reportDirectory, request.reportFilename);
	const staleReport = await request.filesystem.readFile({
		root: request.reportDirectory,
		path: request.reportFilename,
		maxBytes: MAX_LEDGER_BYTES,
	});
	if (staleReport.ok) {
		const removed = await request.filesystem.removeFile(
			request.reportDirectory,
			request.reportFilename,
		);
		if (!removed.ok) return removed;
	} else if (staleReport.error.code !== "not_found") {
		if (staleReport.error.code !== "invalid_input")
			return { ok: false, error: staleReport.error };
		const removed = await request.filesystem.removeFile(
			request.reportDirectory,
			request.reportFilename,
		);
		if (!removed.ok) return removed;
	}

	const before = await request.tree.snapshot();
	if (!before.ok) return before;
	let run: Result<AdapterRunResult>;
	try {
		run = await request.adapter.run({
			process: request.process,
			workdir: request.workdir,
			slug: request.slug,
			reportPath,
			environment: request.environment,
			timeoutMilliseconds: request.timeoutMilliseconds,
		});
	} catch (cause) {
		run = {
			ok: false,
			error: portError(
				"unavailable",
				cause instanceof Error
					? `Acceptance process could not be supervised: ${cause.message}`
					: "Acceptance process could not be supervised.",
				true,
			),
		};
	}
	const after = await request.tree.snapshot();
	if (!after.ok) return after;

	const report = await request.filesystem.readFile({
		root: request.reportDirectory,
		path: request.reportFilename,
		maxBytes: MAX_LEDGER_BYTES,
	});
	let reportBytes: Uint8Array | null = null;
	let malformedRead = false;
	if (report.ok) reportBytes = report.value;
	else if (report.error.code === "not_found") reportBytes = null;
	else if (report.error.code === "invalid_input") malformedRead = true;
	else return { ok: false, error: report.error };

	let runResult: AdapterRunResult;
	if (run.ok) runResult = run.value;
	else {
		const message = new TextEncoder().encode(run.error.message);
		runResult = {
			exitStatus: null,
			timedOut: run.error.code === "timeout",
			log: { stdout: new Uint8Array(), stderr: message },
		};
	}
	let adapterUnavailable: ((log: AdapterLog) => boolean) | undefined;
	if (request.adapter.unavailable !== undefined)
		adapterUnavailable = request.adapter.unavailable.bind(request.adapter);
	return evaluateAcceptanceLedger({
		slug: request.slug,
		itemIds: request.itemIds,
		run: runResult,
		report: reportBytes,
		...(malformedRead ? { malformedRead: true } : {}),
		treeBefore: before.value,
		treeAfter: after.value,
		...(adapterUnavailable === undefined ? {} : { adapterUnavailable }),
	});
}

function pathIsWithin(parent: string, candidate: string): boolean {
	const relativePath = relative(resolve(parent), resolve(candidate));
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`) &&
			!isAbsolute(relativePath))
	);
}
