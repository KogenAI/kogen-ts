import type { AcceptanceLedgerRow } from "../../../core/src/adapters/interface";
import {
	isBuildVerificationLandable,
	observeBuildAudit,
} from "../../../core/src/build/audit";
import {
	type BuildSelectionCandidate,
	selectBestBuildCandidate,
} from "../../../core/src/build/select";
import type {
	GateFinding,
	GateFindingIdentity,
} from "../../../core/src/gate/findings";
import {
	type AcceptanceFailure,
	type AcceptanceItemResult,
	type AcceptanceLedgerResult,
	evaluateAcceptanceLedger,
} from "../../../core/src/gate/ledger";
import {
	type GateAcceptanceResult,
	type GateCheckBaseline,
	type GateCheckResult,
	type GateCheckStatus,
	type GateVerificationResult,
	isCheckExcused,
} from "../../../core/src/gate/verify";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

type Item = {
	readonly kind: string;
	readonly passed: boolean;
	readonly demoted: false;
};
type Candidate = {
	readonly passed: number;
	readonly blocking: number;
	readonly diff: number;
};
interface RowsInput {
	readonly id: string;
	readonly kind: string;
	readonly report: string;
	readonly runnerDown: boolean;
	readonly exit0: boolean;
	readonly mutated: boolean;
	readonly failed: number;
	readonly rows: number;
}

interface State {
	readonly baselines: Map<string, GateCheckBaseline>;
	readonly checks: Map<string, GateCheckResult>;
	readonly excused: Map<string, boolean>;
	readonly items: Map<string, Item>;
	readonly offers: Map<string, Candidate>;
	ledger: string;
	lastLedger: AcceptanceLedgerResult | null;
	verdict: string;
	landable: boolean;
	winner: string;
	policy: string;
	last: string;
}

const CHECK_NAMES = new Set(["c1", "c2"]);
const ITEM_NAMES = new Set(["A1", "A2"]);
const RUNG_NAMES = new Set(["1", "2", "3"]);
const MAX_DIAGNOSTIC_ROWS = 1_000;
const MAX_DIAGNOSTIC_ITEMS = 1_000;
const MAX_DIAGNOSTIC_DIFF_LINES = 10_000;
const CHECK_STATUSES = new Set([
	"green",
	"red",
	"unavailable",
	"timeout",
	"mutating",
]);
const encoder = new TextEncoder();

function fail(message: string): never {
	throw new XspecProtocolError("invalid_event", message);
}

function exact(
	value: Record<string, unknown>,
	keys: readonly string[],
	name: string,
): void {
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail(`${name} does not match the frozen field schema`);
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") fail(`${key} must be a string`);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean") fail(`${key} must be a boolean`);
	return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (!Number.isSafeInteger(field)) fail(`${key} must be a safe integer`);
	return field as number;
}

function emptyState(): State {
	return {
		baselines: new Map(),
		checks: new Map(),
		excused: new Map(),
		items: new Map(),
		offers: new Map(),
		ledger: "",
		lastLedger: null,
		verdict: "",
		landable: false,
		winner: "",
		policy: "green",
		last: "ok",
	};
}

function observe(state: State) {
	return {
		last: state.last,
		ledger: state.ledger,
		verdict: state.verdict,
		landable: state.landable,
		winner: state.winner,
		policy: state.policy,
		excused: Object.fromEntries(state.excused),
		items: Object.fromEntries(state.items),
	};
}

function knownCheck(name: string): boolean {
	return CHECK_NAMES.has(name);
}

function knownStatus(status: string): status is GateCheckStatus {
	return CHECK_STATUSES.has(status);
}

function exitForStatus(status: GateCheckStatus): number | null {
	if (status === "green") return 0;
	if (status === "unavailable") return null;
	if (status === "timeout") return 124;
	return 1;
}

function finding(identity: GateFindingIdentity, step = "check"): GateFinding {
	return {
		...identity,
		step,
		line: 1,
		column: 1,
		severity: "error",
		message: "diagnostic finding",
		excused: false,
	};
}

function identity(symbol: string): GateFindingIdentity {
	return { path: "fixture.ts", rule: "diagnostic/failure", symbol };
}

function emptyLedger(): AcceptanceLedgerResult {
	return {
		reportState: "empty",
		rows: [],
		items: [],
		unknownTags: [],
		failures: [],
		treeBefore: "fixture-tree",
		treeAfter: "fixture-tree",
		exitStatus: 0,
		timedOut: false,
	};
}

function checkResult(
	name: string,
	status: GateCheckStatus,
	excused: boolean,
	findings: readonly GateFinding[],
	baselineStatus: GateCheckStatus | null,
): GateCheckResult {
	return {
		name,
		argv: ["fixture-check", name],
		timeoutMilliseconds: 1_000,
		baselineStatus,
		status,
		exitStatus: exitForStatus(status),
		timedOut: status === "timeout",
		excused,
		changedPaths: [],
		findings,
		log: {
			step: name,
			stdoutPath: "fixture/stdout.log",
			stderrPath: "fixture/stderr.log",
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
		},
		treeBefore: "fixture-tree",
		treeAfter: "fixture-tree",
		restoredTree: null,
	};
}

function acceptanceResult(
	items: readonly AcceptanceItemResult[],
	findings: readonly GateFinding[],
	failures: readonly AcceptanceFailure[],
	ledger: AcceptanceLedgerResult,
): GateAcceptanceResult {
	return {
		ledger,
		items,
		failures,
		findings,
		log: {
			step: "acceptance",
			stdoutPath: "fixture/acceptance-stdout.log",
			stderrPath: "fixture/acceptance-stderr.log",
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
		},
		exitStatus: ledger.exitStatus,
		timedOut: ledger.timedOut,
	};
}

function currentVerification(state: State): GateVerificationResult {
	const acceptanceItems = [...state.items].map(([id, item]) => ({
		id,
		status: item.passed ? ("pass" as const) : ("fail" as const),
		rows: [] as readonly AcceptanceLedgerRow[],
	}));
	const failures: AcceptanceFailure[] = [];
	const acceptanceFindings: GateFinding[] = [];
	for (const [id, item] of state.items) {
		if (item.passed) continue;
		const rowFinding = finding(identity(`acceptance-${id}`), "acceptance");
		acceptanceFindings.push(rowFinding);
		failures.push({
			classification: "suite",
			scope: "candidate",
			message: `Acceptance item ${id} failed.`,
		});
	}
	const ledger = state.lastLedger ?? {
		...emptyLedger(),
		items: acceptanceItems,
		failures,
	};
	const acceptance = acceptanceResult(
		acceptanceItems,
		acceptanceFindings,
		failures,
		ledger,
	);
	const checks = [...state.checks.values()];
	const redCheck = checks.some(
		(check) => check.status !== "green" && !check.excused,
	);
	const redItem = acceptanceItems.some((item) => item.status !== "pass");
	const status = redCheck || redItem || failures.length > 0 ? "red" : "green";
	const findings = [
		...checks.flatMap((check) => check.findings),
		...acceptanceFindings,
	];
	return {
		status,
		fixes: [],
		checks,
		acceptance,
		findings,
		rawLogs: [],
		failureCount: findings.length,
		counts: { errors: findings.length, warnings: 0, byTool: {} },
		findingsPath: "fixture/gate-findings.json",
	};
}

function runRows(value: Record<string, unknown>): RowsInput {
	const keys = [
		"id",
		"kind",
		"report",
		"runnerDown",
		"exit0",
		"mutated",
		"failed",
		"rows",
	];
	exact(value, keys, "Rows");
	const id = stringField(value, "id");
	const kind = stringField(value, "kind");
	const report = stringField(value, "report");
	const runnerDown = booleanField(value, "runnerDown");
	const exit0 = booleanField(value, "exit0");
	const mutated = booleanField(value, "mutated");
	const failed = integerField(value, "failed");
	const rows = integerField(value, "rows");
	if (
		Math.abs(failed) > MAX_DIAGNOSTIC_ROWS ||
		Math.abs(rows) > MAX_DIAGNOSTIC_ROWS
	)
		fail("Rows exceeds the diagnostic fixture bounds");
	return { id, kind, report, runnerDown, exit0, mutated, failed, rows };
}

async function applyRows(
	state: State,
	value: Record<string, unknown>,
): Promise<void> {
	const decoded = runRows(value);
	if (
		!ITEM_NAMES.has(decoded.id) ||
		(decoded.kind !== "change" && decoded.kind !== "keep")
	) {
		state.last = "bad_item";
		return;
	}
	if (!["ok", "empty", "malformed", "missing"].includes(decoded.report)) {
		state.last = "bad_report";
		return;
	}
	let report: Uint8Array | null;
	if (decoded.report === "missing") report = null;
	else if (decoded.report === "empty") report = new Uint8Array();
	else if (decoded.report === "malformed")
		report = encoder.encode("{not-json\n");
	else {
		const count = Math.max(1, decoded.rows);
		const rows: AcceptanceLedgerRow[] = [];
		for (let index = 0; index < count; index += 1) {
			rows.push({
				tag: `fixture/${decoded.id}`,
				test: `case-${index + 1}`,
				status:
					index < decoded.failed || decoded.rows < 1 ? "failed" : "passed",
			});
		}
		report = encoder.encode(
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}
	const result = evaluateAcceptanceLedger({
		slug: "fixture",
		itemIds: [decoded.id],
		run: {
			exitStatus: decoded.exit0 ? 0 : 1,
			timedOut: false,
			log: { stdout: new Uint8Array(), stderr: new Uint8Array() },
		},
		report,
		treeBefore: "fixture-tree",
		treeAfter: decoded.mutated ? "mutated-tree" : "fixture-tree",
		adapterUnavailable: () => decoded.runnerDown,
	});
	if (!result.ok) {
		state.last = "ledger_invalid";
		return;
	}
	const currentItem = result.value.items[0];
	if (currentItem !== undefined)
		state.items.set(decoded.id, {
			kind: decoded.kind,
			passed: currentItem.status === "pass",
			demoted: false,
		});
	state.lastLedger = result.value;
	const classification = result.value.failures[0]?.classification;
	state.ledger =
		classification ?? currentItem?.status ?? result.value.reportState;
	state.last = "ok";
}

function baseline(state: State, value: Record<string, unknown>): void {
	exact(value, ["name", "status"], "Baseline");
	const name = stringField(value, "name");
	const statusValue = stringField(value, "status");
	if (!knownCheck(name)) {
		state.last = "unknown_check";
		return;
	}
	if (!knownStatus(statusValue)) {
		state.last = "bad_status";
		return;
	}
	const baseFindings =
		statusValue === "green"
			? []
			: [identity(`${name}-baseline`)].map((item) => ({
					...item,
					message: "baseline finding",
				}));
	const baselineValue: GateCheckBaseline = {
		name,
		status: statusValue,
		exitStatus: exitForStatus(statusValue),
		findings: baseFindings,
	};
	state.baselines.set(name, baselineValue);
	const existing = state.checks.get(name);
	if (existing !== undefined) {
		const excused = isCheckExcused(baselineValue, {
			status: existing.status,
			exitStatus: existing.exitStatus,
			findings: existing.findings,
		});
		state.excused.set(name, excused);
		state.checks.set(name, {
			...existing,
			baselineStatus: statusValue,
			excused,
		});
	}
	state.verdict = "";
	state.landable = false;
	state.last = "ok";
}

function now(state: State, value: Record<string, unknown>): void {
	exact(value, ["name", "status", "hasIds", "subset", "sameExit"], "Now");
	const name = stringField(value, "name");
	const statusValue = stringField(value, "status");
	const hasIds = booleanField(value, "hasIds");
	const subset = booleanField(value, "subset");
	const sameExit = booleanField(value, "sameExit");
	if (!knownCheck(name)) {
		state.last = "unknown_check";
		return;
	}
	if (!knownStatus(statusValue)) {
		state.last = "bad_status";
		return;
	}
	const baselineValue = state.baselines.get(name);
	const baselineExit = baselineValue?.exitStatus ?? 1;
	const status = statusValue as GateCheckStatus;
	const currentFindings = hasIds
		? [finding(identity(subset ? `${name}-baseline` : `${name}-new`))]
		: [];
	const exitStatus = sameExit
		? baselineExit
		: baselineExit === null
			? 0
			: baselineExit + 1;
	const excused = isCheckExcused(baselineValue, {
		status,
		exitStatus,
		findings: currentFindings,
	});
	state.excused.set(name, excused);
	state.checks.set(
		name,
		checkResult(
			name,
			status,
			excused,
			currentFindings,
			baselineValue?.status ?? null,
		),
	);
	state.verdict = "";
	state.landable = false;
	state.last = "ok";
}

function demote(state: State, value: Record<string, unknown>): void {
	exact(value, ["id", "verdict"], "Demote");
	const id = stringField(value, "id");
	const verdict = stringField(value, "verdict");
	if (!state.items.has(id)) {
		state.last = "unknown_item";
		return;
	}
	if (!["valid", "over_strict", "contradicts", "garbled"].includes(verdict)) {
		state.last = "bad_verdict";
		return;
	}
	const items = [...state.items].map(([itemId, item]) => ({
		id: itemId,
		status: item.passed ? ("pass" as const) : ("fail" as const),
		rows: [],
	}));
	const rawVerdict = verdict === "garbled" ? "garbled" : verdict;
	observeBuildAudit(currentVerification(state), {
		items: items
			.filter((item) => item.status !== "pass")
			.map((item) => ({
				id: item.id,
				verdict: item.id === id ? rawVerdict : "valid",
				reason: "diagnostic advice",
			})),
	});
	state.last = "ok";
}

function score(state: State, value: Record<string, unknown>): void {
	exact(value, ["policy"], "Score");
	const policy = stringField(value, "policy");
	if (policy !== "green" && policy !== "green-or-advisory") {
		state.last = "bad_policy";
		return;
	}
	const verification = currentVerification(state);
	const ids = [...state.items.keys()];
	const changeIds = [...state.items]
		.filter(([, item]) => item.kind === "change")
		.map(([id]) => id);
	const empty = state.checks.size === 0 && state.items.size === 0;
	state.policy = policy;
	state.verdict = empty
		? "none"
		: verification.status === "green" && state.items.size > 0
			? "green"
			: "unverified";
	state.landable = isBuildVerificationLandable({
		verification,
		landPolicy: policy,
		approvedItemIds: ids,
		approvedChangeItemIds: changeIds,
	});
	state.last = "ok";
}

function diffBytes(lines: number): Uint8Array {
	const body = Array.from(
		{ length: lines },
		(_, index) => `+line-${index + 1}`,
	).join("\n");
	const patch = `diff --git a/fixture b/fixture\n--- a/fixture\n+++ b/fixture\n@@ -0,0 +1,${lines} @@\n${body}${lines === 0 ? "" : "\n"}`;
	return encoder.encode(patch);
}

function selectorVerification(
	passed: number,
	blocking: number,
): GateVerificationResult {
	const items: AcceptanceItemResult[] = Array.from(
		{ length: passed },
		(_, index) => ({
			id: `A${index + 1}`,
			status: "pass" as const,
			rows: [],
		}),
	);
	const blockers = Array.from({ length: blocking }, (_, index) =>
		checkResult(
			`blocking-${index + 1}`,
			"red",
			false,
			[finding(identity(`blocking-${index + 1}`))],
			null,
		),
	);
	const ledger = { ...emptyLedger(), reportState: "valid" as const, items };
	const acceptance = acceptanceResult(items, [], [], ledger);
	const flatFindings = blockers.flatMap((check) => check.findings);
	return {
		status: blocking > 0 ? "red" : "green",
		fixes: [],
		checks: blockers,
		acceptance,
		findings: flatFindings,
		rawLogs: [],
		failureCount: blocking,
		counts: { errors: blocking, warnings: 0, byTool: {} },
		findingsPath: "fixture/gate-findings.json",
	};
}

function offer(state: State, value: Record<string, unknown>): void {
	exact(value, ["rung", "passed", "blocking", "diff"], "Offer");
	const rung = stringField(value, "rung");
	const passed = integerField(value, "passed");
	const blocking = integerField(value, "blocking");
	const diff = integerField(value, "diff");
	if (!RUNG_NAMES.has(rung) || passed < 0 || blocking < 0 || diff < 0) {
		state.last = "bad_offer";
		return;
	}
	if (
		passed > MAX_DIAGNOSTIC_ITEMS ||
		blocking > MAX_DIAGNOSTIC_ITEMS ||
		diff > MAX_DIAGNOSTIC_DIFF_LINES
	)
		fail("Offer exceeds the diagnostic fixture bounds");
	state.offers.set(rung, { passed, blocking, diff });
	state.last = "ok";
}

function pick(state: State): void {
	if (state.offers.size === 0) {
		state.last = "no_candidate";
		return;
	}
	const candidates: BuildSelectionCandidate<string>[] = [...state.offers].map(
		([rung, value]) => ({
			candidate: rung,
			ordinal: Number(rung),
			verification: selectorVerification(value.passed, value.blocking),
			diff: diffBytes(value.diff),
		}),
	);
	const winner = selectBestBuildCandidate(candidates);
	state.winner = winner?.candidate ?? "";
	state.last = winner === null ? "no_candidate" : "ok";
}

export function createGateSlice(): XspecSlice {
	let state = emptyState();
	return {
		async reset() {
			state = emptyState();
			return observe(state);
		},
		async apply(event) {
			const decoded = decodeSliceEvent(event);
			if (decoded.tag === "Init") {
				if (decoded.value !== undefined) fail("Init accepts no value");
				state = emptyState();
				return observe(state);
			}
			if (
				decoded.tag === "Baseline" ||
				decoded.tag === "Now" ||
				decoded.tag === "Rows" ||
				decoded.tag === "Demote" ||
				decoded.tag === "Score" ||
				decoded.tag === "Offer"
			) {
				if (decoded.value === undefined)
					fail(`${decoded.tag} requires its value object`);
				if (decoded.tag === "Baseline") baseline(state, decoded.value);
				else if (decoded.tag === "Now") now(state, decoded.value);
				else if (decoded.tag === "Rows") await applyRows(state, decoded.value);
				else if (decoded.tag === "Demote") demote(state, decoded.value);
				else if (decoded.tag === "Score") score(state, decoded.value);
				else offer(state, decoded.value);
			} else if (decoded.tag === "Pick") {
				if (decoded.value !== undefined) fail("Pick accepts no value");
				pick(state);
			} else {
				fail(`Unsupported gate event ${decoded.tag}`);
			}
			return observe(state);
		},
	};
}
