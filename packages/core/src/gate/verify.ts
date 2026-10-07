import { isAbsolute } from "node:path";
import type {
	AcceptanceAdapter,
	AdapterLog,
	AdapterRunResult,
} from "../adapters/interface";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../contracts/ports";
import type { CheckSpec } from "../project/schema";
import {
	type GateCommandObservation,
	type GateRawLog,
	type GateTreePort,
	type GateTreeSnapshot,
	persistGateRawLog,
	runFixes,
	runGateCommand,
} from "./checks";
import {
	type BaselineFinding,
	countDistinctFindingIdentities,
	findingIdentityKey,
	findingTool,
	type GateFinding,
	type GateFindingIdentity,
	parseGateFindings,
} from "./findings";
import {
	type AcceptanceFailure,
	type AcceptanceItemResult,
	type AcceptanceLedgerResult,
	runAcceptanceLedger,
} from "./ledger";

export type GateCheckStatus =
	| "green"
	| "red"
	| "unavailable"
	| "timeout"
	| "mutating";

export interface GateCheckBaseline {
	readonly name: string;
	readonly status: GateCheckStatus;
	readonly exitStatus: number | null;
	readonly findings: readonly BaselineFinding[];
}

export interface GateFixResult {
	readonly name: string;
	readonly command: GateCommandObservation;
	readonly findings: readonly GateFinding[];
	readonly failed: boolean;
}

export interface GateCheckResult {
	readonly name: string;
	readonly argv: readonly string[];
	readonly timeoutMilliseconds: number;
	readonly baselineStatus: GateCheckStatus | null;
	readonly status: GateCheckStatus;
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
	readonly excused: boolean;
	readonly changedPaths: readonly string[];
	readonly findings: readonly GateFinding[];
	readonly log: GateRawLog;
	readonly treeBefore: string;
	readonly treeAfter: string;
	readonly restoredTree: string | null;
}

export interface GateAcceptanceResult {
	readonly ledger: AcceptanceLedgerResult;
	readonly items: readonly AcceptanceItemResult[];
	readonly failures: readonly AcceptanceFailure[];
	readonly findings: readonly GateFinding[];
	readonly log: GateRawLog;
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
}

export interface GateCounts {
	readonly errors: number;
	readonly warnings: number;
	readonly byTool: Readonly<Record<string, number>>;
}

export interface GateVerificationResult {
	readonly status: "green" | "red";
	readonly fixes: readonly GateFixResult[];
	readonly checks: readonly GateCheckResult[];
	readonly acceptance: GateAcceptanceResult;
	/** Full, untruncated current findings, including findings from excused checks. */
	readonly findings: readonly GateFinding[];
	readonly rawLogs: readonly GateRawLog[];
	readonly failureCount: number;
	readonly counts: GateCounts;
	readonly findingsPath: string;
}

export interface VerifyGateRequest {
	readonly process: Pick<ProcessPort, "run">;
	readonly filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>;
	readonly tree: GateTreePort;
	readonly workdir: string;
	readonly runDirectory: string;
	readonly runId: string;
	readonly slug: string;
	readonly itemIds: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly fixes: readonly CheckSpec[];
	readonly checks: readonly CheckSpec[];
	readonly baselines: readonly GateCheckBaseline[];
	readonly acceptance: {
		readonly adapter: AcceptanceAdapter;
		readonly reportDirectory: string;
		readonly reportFilename: string;
		readonly timeoutMilliseconds: number;
	};
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function isValidRunId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function classifyCheck(
	command: GateCommandObservation,
	mutated: boolean,
): GateCheckStatus {
	if (command.timedOut) return "timeout";
	if (mutated) return "mutating";
	if (
		command.exitStatus === null ||
		command.exitStatus === 126 ||
		command.exitStatus === 127 ||
		command.error?.code === "unavailable"
	)
		return "unavailable";
	return command.exitStatus === 0 ? "green" : "red";
}

function findingSet(
	findings: readonly GateFindingIdentity[] | readonly BaselineFinding[],
): ReadonlySet<string> {
	return new Set(findings.map(findingIdentityKey));
}

/** Apply the frozen §3.7.2 base-relative exception predicate. */
export function isCheckExcused(
	baseline: GateCheckBaseline | undefined,
	current: {
		readonly status: GateCheckStatus;
		readonly exitStatus: number | null;
		readonly findings: readonly GateFindingIdentity[];
	},
): boolean {
	if (baseline === undefined || baseline.status === "green") return false;
	if (baseline.status !== current.status) return false;
	const baseIds = findingSet(baseline.findings);
	const currentIds = findingSet(current.findings);
	if (baseIds.size > 0 && currentIds.size > 0) {
		for (const identity of currentIds) {
			if (!baseIds.has(identity)) return false;
		}
		return true;
	}
	return baseline.exitStatus === current.exitStatus;
}

function failedFix(command: GateCommandObservation): boolean {
	return (
		command.exitStatus !== 0 || command.timedOut || command.error !== undefined
	);
}

function syntheticFinding(
	step: string,
	rule: string,
	message: string,
	path = "<gate>",
	symbol = "",
): GateFinding {
	return {
		step,
		path,
		line: 1,
		column: 1,
		severity: "error",
		rule,
		symbol,
		message,
		excused: false,
	};
}

function exitMessage(command: GateCommandObservation): string {
	if (command.error !== undefined) return command.error.message;
	if (command.timedOut) return "command timed out";
	return `command exited with status ${String(command.exitStatus)}`;
}

function unionFindings(
	...groups: readonly (readonly GateFinding[])[]
): readonly GateFinding[] {
	return groups.flat();
}

function gateFailureCount(
	fixes: readonly GateFixResult[],
	checks: readonly GateCheckResult[],
	acceptance: GateAcceptanceResult,
): number {
	const identities = new Set<string>();
	let anonymousFailures = 0;
	for (const fix of fixes) {
		if (!fix.failed) continue;
		const nonExcused = fix.findings;
		if (nonExcused.length === 0) anonymousFailures += 1;
		else for (const key of findingSet(nonExcused)) identities.add(key);
	}
	for (const check of checks) {
		if (check.status === "green" || check.excused) continue;
		if (check.findings.length === 0) anonymousFailures += 1;
		else for (const key of findingSet(check.findings)) identities.add(key);
	}
	for (const finding of acceptance.findings) {
		if (finding.severity === "error")
			identities.add(findingIdentityKey(finding));
	}
	if (
		acceptance.findings.length === 0 &&
		(acceptance.failures.length > 0 ||
			acceptance.items.some((item) => item.status !== "pass"))
	)
		anonymousFailures += Math.max(
			1,
			acceptance.items.filter((item) => item.status !== "pass").length,
		);
	return identities.size + anonymousFailures;
}

function gateCounts(
	findings: readonly GateFinding[],
	fixes: readonly GateFixResult[],
	checks: readonly GateCheckResult[],
	acceptance: GateAcceptanceResult,
): GateCounts {
	let errors = 0;
	let warnings = 0;
	const byTool = new Map<string, number>();
	const activeFindings = findings.filter((finding) => !finding.excused);
	for (const finding of activeFindings) {
		// A failing approved item is reported on its own `acceptance A<n>` line;
		// it contributes to progress identity count but not the error total.
		if (finding.step === "acceptance" && finding.rule === "acceptance")
			continue;
		if (finding.severity === "error") errors += 1;
		else warnings += 1;
		const tool = findingTool(finding.rule);
		byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
	}
	const hasActiveError = (step: string): boolean =>
		activeFindings.some(
			(finding) => finding.step === step && finding.severity === "error",
		);
	for (const fix of fixes) {
		if (!fix.failed || hasActiveError(fix.command.step)) continue;
		errors += 1;
		byTool.set(`fix/${fix.name}`, (byTool.get(`fix/${fix.name}`) ?? 0) + 1);
	}
	for (const check of checks) {
		if (check.excused) {
			warnings += 1;
			continue;
		}
		if (check.status === "green" || hasActiveError(check.name)) continue;
		errors += 1;
		byTool.set(check.name, (byTool.get(check.name) ?? 0) + 1);
	}
	const acceptanceHasError = activeFindings.some(
		(finding) => finding.step === "acceptance" && finding.severity === "error",
	);
	if (
		!acceptanceHasError &&
		(acceptance.failures.length > 0 ||
			acceptance.items.some((item) => item.status !== "pass"))
	) {
		errors += 1;
		byTool.set("acceptance", (byTool.get("acceptance") ?? 0) + 1);
	}
	const record: Record<string, number> = Object.create(null);
	for (const [tool, count] of [...byTool].sort(([a], [b]) => compareUtf8(a, b)))
		record[tool] = count;
	return { errors, warnings, byTool: record };
}

function compareUtf8(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
		const difference = (a[i] ?? 0) - (b[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function findingsDocument(
	runId: string,
	findings: readonly GateFinding[],
): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ run_id: runId, findings }));
}

async function restoreTree(
	tree: GateTreePort,
	checkpoint: GateTreeSnapshot,
): Promise<Result<string>> {
	const restored = await tree.restore(checkpoint);
	if (!restored.ok) return restored;
	const current = await tree.snapshot();
	if (!current.ok) return current;
	if (current.value.identity !== checkpoint.identity)
		return {
			ok: false,
			error: portError(
				"conflict",
				"Verification workspace did not return to the captured tree after restoration.",
				true,
			),
		};
	return { ok: true, value: current.value.identity };
}

function acceptanceAdapterWithLogCapture(
	adapter: AcceptanceAdapter,
	capture: {
		run?: AdapterRunResult;
		error?: PortError;
	},
): AcceptanceAdapter {
	return {
		name: adapter.name,
		sourcePath: (slug) => adapter.sourcePath(slug),
		candidatePath: (slug) => adapter.candidatePath(slug),
		stage: (request) => adapter.stage(request),
		async run(request) {
			try {
				const result = await adapter.run(request);
				if (result.ok) capture.run = result.value;
				else capture.error = result.error;
				return result;
			} catch (cause) {
				capture.error = portError(
					"unavailable",
					cause instanceof Error
						? `Acceptance runner failed: ${cause.message}`
						: "Acceptance runner failed.",
					true,
				);
				return { ok: false, error: capture.error };
			}
		},
		...(adapter.unavailable === undefined
			? {}
			: {
					unavailable: (log: AdapterLog) => adapter.unavailable?.(log) ?? false,
				}),
	};
}

function acceptanceFindings(
	slug: string,
	adapter: AcceptanceAdapter,
	ledger: AcceptanceLedgerResult,
	logFindings: readonly GateFinding[],
): readonly GateFinding[] {
	const findings = [...logFindings];
	for (const item of ledger.items) {
		if (item.status === "pass") continue;
		let candidatePath = "<acceptance>";
		try {
			candidatePath = adapter.candidatePath(slug);
		} catch {
			// The ledger already validates the slug; keep a bounded placeholder if an adapter is faulty.
		}
		const failedRows = item.rows.filter((row) => row.status !== "passed");
		const rowMessage = failedRows
			.map((row) => `${row.test}: ${row.status}`)
			.join("; ");
		findings.push(
			syntheticFinding(
				"acceptance",
				"acceptance",
				rowMessage.length > 0
					? rowMessage
					: "approved acceptance item did not pass",
				candidatePath,
				`${slug}/${item.id}`,
			),
		);
	}
	if (
		findings.length === 0 &&
		ledger.failures.length > 0 &&
		ledger.items.every((item) => item.status === "pass")
	) {
		let candidatePath = "<acceptance>";
		try {
			candidatePath = adapter.candidatePath(slug);
		} catch {
			// Keep the deterministic fallback path.
		}
		for (const failure of ledger.failures)
			findings.push(
				syntheticFinding(
					"acceptance",
					`acceptance/${failure.classification}`,
					failure.message,
					candidatePath,
				),
			);
	}
	return findings;
}

function acceptanceOk(ledger: AcceptanceLedgerResult): boolean {
	return (
		ledger.failures.length === 0 &&
		ledger.exitStatus === 0 &&
		ledger.items.length > 0 &&
		ledger.items.every((item) => item.status === "pass")
	);
}

/** Run fixes, then every configured check, then acceptance, preserving the post-fix tree. */
export async function verifyGate(
	request: VerifyGateRequest,
): Promise<Result<GateVerificationResult>> {
	if (
		!isAbsolute(request.workdir) ||
		!isAbsolute(request.runDirectory) ||
		!isValidRunId(request.runId)
	)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Gate run paths or run id are invalid.",
			),
		};
	const fixesRun = await runFixes({
		process: request.process,
		filesystem: request.filesystem,
		workdir: request.workdir,
		runDirectory: request.runDirectory,
		environment: request.environment,
		fixes: request.fixes,
		nextLogIndex: 1,
	});
	if (!fixesRun.ok) return fixesRun;
	let nextLogIndex = fixesRun.value.nextLogIndex;
	const fixResults: GateFixResult[] = [];
	const allFindings: GateFinding[] = [];
	const rawLogs: GateRawLog[] = [];
	for (let index = 0; index < fixesRun.value.commands.length; index += 1) {
		const command = fixesRun.value.commands[index];
		if (command === undefined) continue;
		const name =
			request.fixes[index]?.name ?? command.step.slice("fix/".length);
		const parsed = parseGateFindings(
			command.log.stdout,
			command.log.stderr,
			command.step,
		);
		const failed = failedFix(command);
		const findings =
			failed && parsed.length === 0
				? [syntheticFinding(command.step, `fix/${name}`, exitMessage(command))]
				: parsed;
		const result: GateFixResult = { name, command, findings, failed };
		fixResults.push(result);
		allFindings.push(...findings);
		rawLogs.push(command.log);
	}

	const verificationTree = await request.tree.snapshot();
	if (!verificationTree.ok) return verificationTree;
	if (verificationTree.value.identity.length === 0)
		return {
			ok: false,
			error: portError("invalid_input", "Verification tree identity is empty."),
		};

	const checkResults: GateCheckResult[] = [];
	for (const check of request.checks) {
		let before = await request.tree.snapshot();
		if (!before.ok) return before;
		if (before.value.identity !== verificationTree.value.identity) {
			const aligned = await restoreTree(request.tree, verificationTree.value);
			if (!aligned.ok) return aligned;
			before = await request.tree.snapshot();
			if (!before.ok) return before;
		}
		const command = await runGateCommand({
			process: request.process,
			filesystem: request.filesystem,
			workdir: request.workdir,
			runDirectory: request.runDirectory,
			environment: request.environment,
			step: check.name,
			index: nextLogIndex,
			argv: check.argv,
			timeoutMilliseconds: check.timeoutMs,
		});
		if (!command.ok) return command;
		nextLogIndex += 1;
		const after = await request.tree.snapshot();
		if (!after.ok) return after;
		const mutated = before.value.identity !== after.value.identity;
		let changedPaths: readonly string[] = [];
		if (mutated) {
			const paths = await request.tree.changedPaths(before.value, after.value);
			if (!paths.ok) return paths;
			changedPaths = paths.value;
		}
		const status = classifyCheck(command.value, mutated);
		const parsed = parseGateFindings(
			command.value.log.stdout,
			command.value.log.stderr,
			check.name,
		);
		const baseline = request.baselines.find((item) => item.name === check.name);
		const excused = isCheckExcused(baseline, {
			status,
			exitStatus: command.value.exitStatus,
			findings: parsed,
		});
		const findings = parsed.map((finding) => ({ ...finding, excused }));
		let restoredTree: string | null = null;
		if (after.value.identity !== verificationTree.value.identity) {
			const restored = await restoreTree(request.tree, verificationTree.value);
			if (!restored.ok) return restored;
			restoredTree = restored.value;
		}
		const result: GateCheckResult = {
			name: check.name,
			argv: [...check.argv],
			timeoutMilliseconds: check.timeoutMs,
			baselineStatus: baseline?.status ?? null,
			status,
			exitStatus: command.value.exitStatus,
			timedOut: command.value.timedOut,
			excused,
			changedPaths,
			findings,
			log: command.value.log,
			treeBefore: before.value.identity,
			treeAfter: after.value.identity,
			restoredTree,
		};
		checkResults.push(result);
		allFindings.push(...findings);
		rawLogs.push(command.value.log);
	}

	const acceptanceBefore = await request.tree.snapshot();
	if (!acceptanceBefore.ok) return acceptanceBefore;
	if (acceptanceBefore.value.identity !== verificationTree.value.identity) {
		const aligned = await restoreTree(request.tree, verificationTree.value);
		if (!aligned.ok) return aligned;
	}
	const capture: { run?: AdapterRunResult; error?: PortError } = {};
	const adapter = acceptanceAdapterWithLogCapture(
		request.acceptance.adapter,
		capture,
	);
	const ledgerTree = {
		async snapshot(): Promise<Result<string>> {
			const snapshot = await request.tree.snapshot();
			return snapshot.ok
				? { ok: true, value: snapshot.value.identity }
				: snapshot;
		},
	};
	const ledger = await runAcceptanceLedger({
		adapter,
		process: request.process,
		filesystem: request.filesystem,
		tree: ledgerTree,
		workdir: request.workdir,
		slug: request.slug,
		itemIds: request.itemIds,
		reportDirectory: request.acceptance.reportDirectory,
		reportFilename: request.acceptance.reportFilename,
		environment: request.environment,
		timeoutMilliseconds: request.acceptance.timeoutMilliseconds,
	});
	if (!ledger.ok) return ledger;
	const acceptanceLog = capture.run?.log ?? {
		stdout: new Uint8Array(),
		stderr: new TextEncoder().encode(
			capture.error?.message ?? "Acceptance runner produced no process result.",
		),
	};
	const persistedAcceptanceLog = await persistGateRawLog(
		request.filesystem,
		request.runDirectory,
		nextLogIndex,
		"acceptance",
		acceptanceLog,
	);
	if (!persistedAcceptanceLog.ok) return persistedAcceptanceLog;
	const afterAcceptance = await request.tree.snapshot();
	if (!afterAcceptance.ok) return afterAcceptance;
	const acceptanceMutated =
		acceptanceBefore.value.identity !== afterAcceptance.value.identity ||
		ledger.value.treeBefore !== ledger.value.treeAfter;
	if (
		afterAcceptance.value.identity !== verificationTree.value.identity ||
		acceptanceMutated
	) {
		const restored = await restoreTree(request.tree, verificationTree.value);
		if (!restored.ok) return restored;
	}
	const acceptanceLogFindings = parseGateFindings(
		persistedAcceptanceLog.value.stdout,
		persistedAcceptanceLog.value.stderr,
		"acceptance",
	);
	const acceptanceCurrentFindings = acceptanceFindings(
		request.slug,
		request.acceptance.adapter,
		ledger.value,
		acceptanceLogFindings,
	);
	const acceptance: GateAcceptanceResult = {
		ledger: ledger.value,
		items: ledger.value.items,
		failures: ledger.value.failures,
		findings: acceptanceCurrentFindings,
		log: persistedAcceptanceLog.value,
		exitStatus: capture.run?.exitStatus ?? ledger.value.exitStatus,
		timedOut: capture.run?.timedOut ?? ledger.value.timedOut,
	};
	allFindings.push(...acceptanceCurrentFindings);
	rawLogs.push(persistedAcceptanceLog.value);
	const findings = unionFindings(allFindings);
	const failureCount = gateFailureCount(fixResults, checkResults, acceptance);
	const status =
		fixResults.some((fix) => fix.failed) ||
		checkResults.some((check) => check.status !== "green" && !check.excused) ||
		!acceptanceOk(ledger.value)
			? "red"
			: "green";
	const counts = gateCounts(findings, fixResults, checkResults, acceptance);
	const findingsFilename = `gate-findings-${request.runId}.json`;
	const findingsPath = `${request.runDirectory.replace(/\/$/u, "")}/${findingsFilename}`;
	const savedFindings = await request.filesystem.writeFileAtomically({
		root: request.runDirectory,
		path: findingsFilename,
		bytes: findingsDocument(request.runId, findings),
		mode: 0o600,
	});
	if (!savedFindings.ok) return savedFindings;
	return {
		ok: true,
		value: {
			status,
			fixes: fixResults,
			checks: checkResults,
			acceptance,
			findings,
			rawLogs,
			failureCount,
			counts,
			findingsPath,
		},
	};
}

export function countVerificationFailures(
	result: Pick<GateVerificationResult, "fixes" | "checks" | "acceptance">,
): number {
	return gateFailureCount(result.fixes, result.checks, result.acceptance);
}

export function checkResultFindingCount(result: GateCheckResult): number {
	return countDistinctFindingIdentities(result.findings);
}
