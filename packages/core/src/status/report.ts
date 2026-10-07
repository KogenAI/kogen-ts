import type { JournalEvent, TokenUsage } from "../run/journal";
import type {
	DerivedIntent,
	DerivedStatus,
	StatusAgent,
	StatusInput,
	StatusRun,
} from "./derive";

export interface StatusTokens {
	readonly input: number | null;
	readonly cached_input: number | null;
	readonly cache_write: number | null;
	readonly output: number | null;
	readonly reasoning: number | null;
}

export interface StatusRungReport {
	readonly rung: string;
	readonly model: string | null;
	readonly effort: string | null;
	readonly reason: string | null;
	readonly verdict: string | null;
	readonly diff_lines: number | null;
	readonly candidate_ref: string | null;
	readonly wall_ms: number | null;
	readonly tokens: StatusTokens;
}

export interface StatusModelStage {
	readonly stage: string | null;
	readonly rung: string | null;
	readonly model: string | null;
	readonly effort: string | null;
	readonly tokens: StatusTokens;
	readonly wall_ms: number | null;
	readonly prompt_cache_key: string | null;
}

export interface StatusAudit {
	readonly rung: string | null;
	readonly id: string;
	readonly verdict: string;
	readonly reason: string;
}

export interface StatusAcceptance {
	readonly id: string;
	readonly status: string;
	readonly demoted: boolean;
}

export interface StatusCheck {
	readonly name: string;
	readonly status: string;
	readonly excused: boolean;
}

export interface StatusFinding {
	readonly type: string;
	readonly path: string;
	readonly message: string;
}

export interface StatusFailure {
	readonly stage: string;
	readonly class: string;
	readonly reason: string;
	readonly detail: string;
}

export interface StatusCandidate {
	readonly rung: string;
	readonly ref: string;
	readonly diff_path: string;
	readonly verdict: string;
}

export interface StatusAgentReport {
	readonly id: string;
	readonly role: string;
	readonly build: string;
	readonly status: string;
	readonly elapsed_ms: number;
	readonly activity: string;
	readonly events: string;
}

/** Every §2.10 field is emitted, including nullable values for missing data. */
export interface StatusBuildReport {
	readonly slug: string;
	readonly status: string;
	readonly build_id: string | null;
	readonly journal: string | null;
	readonly verdict: string | null;
	readonly land_policy: string | null;
	readonly advisory_items: readonly string[];
	readonly approval: {
		readonly commit: string;
		readonly sha256: string;
	} | null;
	readonly approved_by: string | null;
	readonly base: {
		readonly branch: string | null;
		readonly sha: string | null;
	} | null;
	readonly candidate: string | null;
	readonly landed_sha: string | null;
	readonly priority: number;
	readonly blocks_on: readonly string[];
	readonly cache_hit_rate: number | null;
	readonly agents?: readonly StatusAgentReport[];
	readonly credential: {
		readonly source: string | null;
		readonly label: string | null;
	};
	readonly rungs: readonly StatusRungReport[];
	readonly best_candidate: StatusCandidate | null;
	readonly audit: readonly StatusAudit[];
	readonly acceptance: readonly StatusAcceptance[];
	readonly checks: readonly StatusCheck[];
	readonly model_stages: readonly StatusModelStage[];
	readonly findings: readonly StatusFinding[];
	readonly failures: readonly StatusFailure[];
	readonly sandbox: string | null;
	readonly budget: {
		readonly budget_ms: number | null;
		readonly used_ms: number | null;
		readonly paused_ms: number | null;
	};
}

interface TokenTotal {
	value: number;
	seen: boolean;
	unknown: boolean;
}

const TOKEN_FIELDS = [
	"input",
	"cached_input",
	"cache_write",
	"output",
	"reasoning",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function safeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function eventsOf(run: StatusRun | null): readonly JournalEvent[] {
	return run?.events ?? [];
}

function newTokenTotals(): Record<(typeof TOKEN_FIELDS)[number], TokenTotal> {
	return {
		input: { value: 0, seen: false, unknown: false },
		cached_input: { value: 0, seen: false, unknown: false },
		cache_write: { value: 0, seen: false, unknown: false },
		output: { value: 0, seen: false, unknown: false },
		reasoning: { value: 0, seen: false, unknown: false },
	};
}

function addUsage(
	totals: Record<(typeof TOKEN_FIELDS)[number], TokenTotal>,
	value: unknown,
): void {
	if (!isObject(value)) {
		for (const field of TOKEN_FIELDS) totals[field].unknown = true;
		return;
	}
	for (const field of TOKEN_FIELDS) {
		const total = totals[field];
		const count = safeInteger(value[field]);
		if (count === null) total.unknown = true;
		else {
			total.value += count;
			total.seen = true;
			if (!Number.isSafeInteger(total.value)) total.unknown = true;
		}
	}
}

function frozenUsage(
	totals: Record<(typeof TOKEN_FIELDS)[number], TokenTotal>,
): StatusTokens {
	const value = (field: (typeof TOKEN_FIELDS)[number]): number | null => {
		const total = totals[field];
		return total.seen && !total.unknown ? total.value : null;
	};
	return {
		input: value("input"),
		cached_input: value("cached_input"),
		cache_write: value("cache_write"),
		output: value("output"),
		reasoning: value("reasoning"),
	};
}

function statusTokens(value: unknown): StatusTokens {
	const count = (field: (typeof TOKEN_FIELDS)[number]): number | null =>
		isObject(value) ? safeInteger(value[field]) : null;
	return {
		input: count("input"),
		cached_input: count("cached_input"),
		cache_write: count("cache_write"),
		output: count("output"),
		reasoning: count("reasoning"),
	};
}

function usageFromEvent(event: JournalEvent): unknown {
	return event.tokens;
}

function cacheHitRate(events: readonly JournalEvent[]): number | null {
	let input = 0;
	let cached = 0;
	let measured = false;
	for (const event of events) {
		if (event.event !== "model_stage") continue;
		const tokens = event.tokens;
		if (!isObject(tokens)) return null;
		const requestInput = safeInteger(tokens.input);
		const requestCached = safeInteger(tokens.cached_input);
		if (requestInput === null || requestCached === null) return null;
		input += requestInput;
		cached += requestCached;
		if (!Number.isSafeInteger(input) || !Number.isSafeInteger(cached))
			return null;
		measured = true;
	}
	const denominator = input + cached;
	return measured && Number.isSafeInteger(denominator) && denominator > 0
		? cached / denominator
		: null;
}

interface MutableRung {
	rung: string;
	model: string | null;
	effort: string | null;
	reason: string | null;
	verdict: string | null;
	diffLines: number | null;
	candidateRef: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	tokens: Record<(typeof TOKEN_FIELDS)[number], TokenTotal>;
}

function newRung(rung: string): MutableRung {
	return {
		rung,
		model: null,
		effort: null,
		reason: null,
		verdict: null,
		diffLines: null,
		candidateRef: null,
		startedAt: null,
		finishedAt: null,
		tokens: newTokenTotals(),
	};
}

function runRungs(
	run: StatusRun | null,
	nowMs: number,
): readonly StatusRungReport[] {
	if (run === null) return [];
	const rungs = new Map<string, MutableRung>();
	for (const event of run.events) {
		const rung = text(event.rung);
		if (rung === null) continue;
		let row = rungs.get(rung);
		if (row === undefined) {
			row = newRung(rung);
			rungs.set(rung, row);
		}
		if (event.event === "rung_started") {
			row.model = text(event.model);
			row.effort = text(event.effort);
			row.startedAt = safeInteger(event.ts);
		} else if (event.event === "rung_finished") {
			row.reason = text(event.reason);
			row.verdict = text(event.verdict);
			row.diffLines = safeInteger(event.diff_lines);
			row.candidateRef = text(event.candidate_ref);
			row.finishedAt = safeInteger(event.ts);
		} else if (event.event === "model_stage") {
			addUsage(row.tokens, usageFromEvent(event));
		}
	}
	return [...rungs.values()].map((row) => {
		const end = row.finishedAt ?? (row.startedAt === null ? null : nowMs);
		const wall =
			row.startedAt === null || end === null
				? null
				: Math.max(0, end - row.startedAt);
		return {
			rung: row.rung,
			model: row.model,
			effort: row.effort,
			reason: row.reason,
			verdict: row.verdict,
			diff_lines: row.diffLines,
			candidate_ref: row.candidateRef,
			wall_ms: wall,
			tokens: frozenUsage(row.tokens),
		};
	});
}

function runModelStages(run: StatusRun | null): readonly StatusModelStage[] {
	return eventsOf(run)
		.filter((event) => event.event === "model_stage")
		.map((event) => ({
			stage: text(event.stage),
			rung: text(event.rung),
			model: text(event.model),
			effort: text(event.effort),
			tokens: statusTokens(usageFromEvent(event)),
			wall_ms: safeInteger(event.wall_ms),
			prompt_cache_key: text(event.prompt_cache_key),
		}));
}

function latestVerification(
	events: readonly JournalEvent[],
): JournalEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.event === "verification") return event;
	}
	return null;
}

function verificationAcceptance(
	event: JournalEvent | null,
): readonly StatusAcceptance[] {
	if (event === null || !Array.isArray(event.acceptance)) return [];
	return event.acceptance.filter(isObject).map((item) => ({
		id: text(item.id) ?? "",
		status: text(item.status) ?? "unknown",
		demoted: item.demoted === true,
	}));
}

function verificationChecks(
	event: JournalEvent | null,
): readonly StatusCheck[] {
	if (event === null || !Array.isArray(event.checks)) return [];
	return event.checks.filter(isObject).map((item) => ({
		name: text(item.name) ?? "",
		status: text(item.status) ?? "unknown",
		excused: item.excused === true,
	}));
}

function verificationFindings(
	event: JournalEvent | null,
): readonly StatusFinding[] {
	if (event === null || !Array.isArray(event.checks)) return [];
	const findings: StatusFinding[] = [];
	for (const check of event.checks) {
		if (!isObject(check) || !Array.isArray(check.findings)) continue;
		for (const finding of check.findings) {
			if (!isObject(finding)) continue;
			findings.push({
				type:
					text(finding.type) ??
					text(finding.rule) ??
					text(check.name) ??
					"check",
				path: text(finding.path) ?? "",
				message: text(finding.message) ?? "",
			});
		}
	}
	return findings;
}

function runAudit(events: readonly JournalEvent[]): readonly StatusAudit[] {
	const audit: StatusAudit[] = [];
	for (const event of events) {
		if (event.event !== "audit" || !Array.isArray(event.items)) continue;
		for (const item of event.items) {
			if (!isObject(item)) continue;
			audit.push({
				rung: text(event.rung),
				id: text(item.id) ?? "",
				verdict: text(item.verdict) ?? "unknown",
				reason: text(item.reason) ?? "",
			});
		}
	}
	return audit;
}

function runFailures(
	events: readonly JournalEvent[],
): readonly StatusFailure[] {
	const failures: StatusFailure[] = [];
	for (const event of events) {
		if (event.event !== "failure" && event.event !== "stage_failure") continue;
		failures.push({
			stage: text(event.stage) ?? "unknown",
			class: text(event.class) ?? "unknown",
			reason: text(event.reason) ?? "unknown",
			detail: text(event.detail) ?? "",
		});
	}
	return failures;
}

function latestFinished(events: readonly JournalEvent[]): JournalEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.event === "finished" || event?.event === "reconciled")
			return event;
	}
	return null;
}

function latestEvent(
	events: readonly JournalEvent[],
	name: string,
): JournalEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.event === name) return event;
	}
	return null;
}

function selectedRung(events: readonly JournalEvent[]): string | null {
	const selection = latestEvent(events, "selection");
	return selection === null ? null : text(selection.winner_rung);
}

function bestCandidate(
	run: StatusRun | null,
	rungs: readonly StatusRungReport[],
): StatusCandidate | null {
	if (run === null) return null;
	const winner = selectedRung(run.events);
	const rung =
		(winner === null ? null : rungs.find((entry) => entry.rung === winner)) ??
		rungs.at(-1) ??
		null;
	if (rung === null || rung.candidate_ref === null) return null;
	return {
		rung: rung.rung,
		ref: rung.candidate_ref,
		diff_path:
			run.candidateDiffPath ??
			`${run.journalPath.replace(/\/$/u, "")}/candidate.diff`,
		verdict: rung.verdict ?? "none",
	};
}

function reportAgents(
	agents: readonly StatusAgent[],
	nowMs: number,
): readonly StatusAgentReport[] {
	return agents.map((agent) => ({
		id: agent.id,
		role: agent.role,
		build: agent.buildId,
		status: agent.status,
		elapsed_ms: Math.max(0, nowMs - agent.startedMs),
		activity: agent.activity,
		events: agent.eventsPath,
	}));
}

function pausedTime(events: readonly JournalEvent[]): number {
	let paused = 0;
	for (const event of events) {
		if (event.event !== "provider_wait" || event.budget_paused !== true)
			continue;
		const wait = safeInteger(event.wait_ms);
		if (wait === null) continue;
		paused += wait;
		if (!Number.isSafeInteger(paused)) return 0;
	}
	return paused;
}

function usageTime(
	run: StatusRun | null,
	events: readonly JournalEvent[],
	nowMs: number,
): { used: number | null; paused: number | null } {
	if (run === null) return { used: null, paused: null };
	const started =
		events.find((event) => event.event === "started")?.ts ??
		run.record.started_ms;
	const end = safeInteger(latestFinished(events)?.ts) ?? nowMs;
	const paused = pausedTime(events);
	return {
		used: Math.max(0, end - started - paused),
		paused,
	};
}

function eventString(event: JournalEvent | null, key: string): string | null {
	return event === null ? null : text(event[key]);
}

function eventNumber(event: JournalEvent | null, key: string): number | null {
	return event === null ? null : safeInteger(event[key]);
}

function reportVerdict(
	finished: JournalEvent | null,
	verification: JournalEvent | null,
): string | null {
	return (
		eventString(finished, "verdict") ??
		eventString(verification, "verdict") ??
		eventString(verification, "result")
	);
}

/** Construct the complete §2.10 JSON object for one Intent. */
export function buildStatusReport(
	status: DerivedStatus,
	intent: DerivedIntent,
	input: StatusInput,
): StatusBuildReport {
	const run = intent.latestRun;
	const events = eventsOf(run);
	const started = events.find((event) => event.event === "started") ?? null;
	const finished = latestFinished(events);
	const verification = latestVerification(events);
	const rungs = runRungs(run, input.nowMs);
	const candidate = bestCandidate(run, rungs);
	const usage = usageTime(run, events, input.nowMs);
	const agents = reportAgents(status.agents, input.nowMs);
	const cacheRate = cacheHitRate(events);
	const landingCommit = run?.record.landing?.candidate_commit ?? null;
	const approval =
		run === null
			? intent.approval === null
				? null
				: { commit: intent.approval.commit, sha256: intent.approval.sha256 }
			: {
					commit: run.record.approval_commit,
					sha256: run.record.approval_sha256,
				};
	const budgetMs = eventNumber(started, "budget_ms");
	const report: StatusBuildReport = {
		slug: intent.slug,
		status: intent.status,
		build_id: run?.record.run_id ?? null,
		journal: run?.journalPath ?? null,
		verdict: reportVerdict(finished, verification),
		land_policy: eventString(started, "land"),
		advisory_items: strings(finished?.advisory_items),
		approval,
		approved_by:
			eventString(started, "approved_by") ??
			intent.approval?.approvedBy ??
			null,
		base:
			run === null
				? intent.approval === null
					? null
					: { branch: null, sha: intent.approval.baseSha }
				: {
						branch: run.record.target_branch,
						sha: eventString(started, "base_sha"),
					},
		candidate: landingCommit ?? candidate?.ref ?? null,
		landed_sha: intent.landed?.sha ?? null,
		priority: intent.priority,
		blocks_on: [...intent.blocksOn],
		cache_hit_rate: cacheRate,
		...(agents.length === 0 ? {} : { agents }),
		credential: {
			source: eventString(started, "credential_source"),
			label: eventString(started, "credential_label"),
		},
		rungs,
		best_candidate: candidate,
		audit: runAudit(events),
		acceptance: verificationAcceptance(verification),
		checks: verificationChecks(verification),
		model_stages: runModelStages(run),
		findings: verificationFindings(verification),
		failures: runFailures(events),
		sandbox:
			eventString(started, "sandbox") ??
			(events.some((event) => event.event === "sandbox_unavailable")
				? "unconfined"
				: null),
		budget: {
			budget_ms: budgetMs,
			used_ms: usage.used,
			paused_ms: usage.paused,
		},
	};
	return report;
}

export function statusIntentJson(intent: DerivedIntent): {
	readonly slug: string;
	readonly status: string;
	readonly build_id: string | null;
	readonly landed_sha: string | null;
	readonly priority: number;
	readonly blocks_on: readonly string[];
} {
	return {
		slug: intent.slug,
		status: intent.status,
		build_id: intent.latestRun?.record.run_id ?? null,
		landed_sha: intent.landed?.sha ?? null,
		priority: intent.priority,
		blocks_on: [...intent.blocksOn],
	};
}

export function agentStatusJson(agent: StatusAgentReport): {
	readonly type: "agent";
	readonly id: string;
	readonly role: string;
	readonly build: string;
	readonly status: string;
	readonly elapsed_ms: number;
	readonly activity: string;
	readonly events: string;
} {
	return { type: "agent", ...agent };
}

export function statusBuildId(run: StatusRun | null): string | null {
	return run?.record.run_id ?? null;
}

export function tokenUsageFromEvent(event: JournalEvent): TokenUsage | null {
	return isObject(event.tokens)
		? (event.tokens as unknown as TokenUsage)
		: null;
}
