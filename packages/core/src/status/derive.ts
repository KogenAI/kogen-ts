import { isValidIntentSlug } from "../intent/parse";
import {
	type BlockedQueueIntent,
	type QueueBlockReason,
	type QueueIntent,
	selectQueue,
} from "../queue/transition";
import type { JournalEvent } from "../run/journal";
import type { RunRecord } from "../run/store";

export type DerivedIntentStatus =
	| "landed"
	| "building"
	| "failed"
	| "parked"
	| "blocked"
	| "queued"
	| "draft"
	| "interrupted";

export type OwnerLiveness = "live" | "dead" | "unknown";

/**
 * Approval data is read from the immutable approval ref. `priority` and
 * `blocksOn` on StatusIntent are taken from this frozen Intent when approved,
 * and from the working Intent when it is still a draft.
 */
export interface StatusApproval {
	readonly commit: string;
	readonly sha256: string;
	readonly approvedAt: number;
	readonly approvedBy: string;
	readonly baseSha: string;
}

export interface StatusIntent {
	readonly slug: string;
	readonly priority: number;
	readonly blocksOn: readonly string[];
	readonly approval: StatusApproval | null;
	readonly acceptanceIds?: readonly string[];
}

export interface ReachableIntentCommit {
	readonly sha: string;
	readonly committedAt: number;
	/** Values returned by Git's trailer parser for Kogen-Intent. */
	readonly intentTrailers: readonly string[];
}

export interface ReachableLanding {
	readonly slug: string;
	readonly sha: string;
	readonly committedAt: number;
}

export interface StatusRun {
	readonly record: RunRecord;
	readonly events: readonly JournalEvent[];
	readonly journalPath: string;
	readonly ownerLiveness: OwnerLiveness;
	readonly journalIncompleteTail?: boolean;
	readonly candidateDiffPath?: string | null;
	readonly candidateChecks?: readonly string[];
	readonly contextContinuations?: number;
}

export interface StatusAgent {
	readonly id: string;
	readonly role: string;
	readonly buildId: string;
	readonly status: string;
	readonly startedMs: number;
	readonly activity: string;
	readonly eventsPath: string;
}

export interface StatusInput {
	readonly intents: readonly StatusIntent[];
	readonly reachableLandings: readonly ReachableLanding[];
	readonly runs: readonly StatusRun[];
	readonly claimRunId: string | null;
	readonly queuePid: number | null;
	readonly agents: readonly StatusAgent[];
	readonly nowMs: number;
}

export interface DerivedIntent {
	readonly slug: string;
	readonly status: DerivedIntentStatus;
	readonly priority: number;
	readonly blocksOn: readonly string[];
	readonly acceptanceIds: readonly string[] | null;
	readonly approval: StatusApproval | null;
	readonly landed: ReachableLanding | null;
	readonly latestRun: StatusRun | null;
	readonly currentApprovalRun: StatusRun | null;
	readonly detail: string | null;
	readonly queuePosition: number | null;
	readonly blocked: BlockedQueueIntent | null;
}

export interface DerivedStatus {
	readonly intents: readonly DerivedIntent[];
	readonly bySlug: ReadonlyMap<string, DerivedIntent>;
	readonly queue: {
		readonly runningPid: number | null;
		readonly queued: readonly DerivedIntent[];
		readonly blocked: readonly DerivedIntent[];
		readonly next: DerivedIntent | null;
	};
	readonly landedHistory: readonly DerivedIntent[];
	readonly agents: readonly StatusAgent[];
	readonly nowMs: number;
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUN_ID = /^[a-f0-9]{32}$/u;
const UTF8 = new TextEncoder();

export function compareStatusText(left: string, right: string): number {
	const a = UTF8.encode(left);
	const b = UTF8.encode(right);
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.byteLength - b.byteLength;
}

/**
 * Reduce Git's base-reachable history to the latest landing commit per slug.
 * Reachability is established by the caller by walking `base`; the current
 * Intent bytes intentionally do not participate in this lookup.
 */
export function landingsFromReachableCommits(
	commits: readonly ReachableIntentCommit[],
): readonly ReachableLanding[] {
	const latest = new Map<string, ReachableLanding>();
	for (const commit of commits) {
		if (
			!OBJECT_ID.test(commit.sha) ||
			!Number.isSafeInteger(commit.committedAt) ||
			commit.committedAt < 0
		)
			continue;
		for (const slug of commit.intentTrailers) {
			if (!isValidIntentSlug(slug)) continue;
			const previous = latest.get(slug);
			if (
				previous === undefined ||
				commit.committedAt > previous.committedAt ||
				(commit.committedAt === previous.committedAt &&
					compareStatusText(commit.sha, previous.sha) > 0)
			)
				latest.set(slug, {
					slug,
					sha: commit.sha,
					committedAt: commit.committedAt,
				});
		}
	}
	return [...latest.values()].sort(
		(left, right) =>
			right.committedAt - left.committedAt ||
			compareStatusText(left.slug, right.slug),
	);
}

function compareRuns(left: StatusRun, right: StatusRun): number {
	if (left.record.started_ms !== right.record.started_ms)
		return left.record.started_ms < right.record.started_ms ? -1 : 1;
	return compareStatusText(left.record.run_id, right.record.run_id);
}

function latestRun(
	previous: StatusRun | undefined,
	next: StatusRun,
): StatusRun {
	return previous === undefined || compareRuns(previous, next) < 0
		? next
		: previous;
}

function latestEvent(run: StatusRun): JournalEvent | null {
	return run.events.at(-1) ?? null;
}

function lastFinishedReason(run: StatusRun): string | null {
	for (let index = run.events.length - 1; index >= 0; index -= 1) {
		const event = run.events[index];
		if (event?.event === "finished" || event?.event === "reconciled")
			return typeof event.reason === "string" ? event.reason : null;
	}
	return null;
}

function currentStage(run: StatusRun): string {
	for (let index = run.events.length - 1; index >= 0; index -= 1) {
		const event = run.events[index];
		if (event === undefined) continue;
		if (typeof event.stage === "string" && event.stage.length > 0)
			return event.stage;
		if (typeof event.rung === "string" && event.rung.length > 0)
			return event.rung;
	}
	return "starting";
}

function blockedDetail(blocked: BlockedQueueIntent): string {
	const dependencies = [...new Set(blocked.dependencies)].sort(
		compareStatusText,
	);
	const joined = dependencies.join(", ");
	switch (blocked.reason as QueueBlockReason) {
		case "dependency_not_landed":
			return `waiting for delivered dependencies: ${joined}`;
		case "dependency_cycle":
			return `dependency cycle: ${joined}`;
		case "unknown_dependency":
			return `unknown dependency: ${joined}`;
		case "invalid_dependencies":
			return `invalid dependencies: ${joined}`;
	}
}

function checkedIntent(intent: StatusIntent): boolean {
	if (!isValidIntentSlug(intent.slug)) return false;
	if (!Number.isSafeInteger(intent.priority))
		throw new TypeError(
			`Status priority for ${intent.slug} must be a safe integer.`,
		);
	if (
		!Array.isArray(intent.blocksOn) ||
		!intent.blocksOn.every((value) => typeof value === "string")
	)
		throw new TypeError(
			`Status dependencies for ${intent.slug} must be strings.`,
		);
	if (intent.approval !== null) {
		if (
			!OBJECT_ID.test(intent.approval.commit) ||
			!/^[a-f0-9]{64}$/u.test(intent.approval.sha256) ||
			!Number.isSafeInteger(intent.approval.approvedAt) ||
			intent.approval.approvedAt < 0
		)
			throw new TypeError(`Status approval for ${intent.slug} is invalid.`);
	}
	return true;
}

function checkedLanding(landing: ReachableLanding): boolean {
	return (
		isValidIntentSlug(landing.slug) &&
		OBJECT_ID.test(landing.sha) &&
		Number.isSafeInteger(landing.committedAt) &&
		landing.committedAt >= 0
	);
}

function validateInput(input: StatusInput): void {
	if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
		throw new TypeError("Status time must be a nonnegative safe integer.");
	if (input.claimRunId !== null && !RUN_ID.test(input.claimRunId))
		throw new TypeError("Status claim run id is invalid.");
	if (
		input.queuePid !== null &&
		(!Number.isSafeInteger(input.queuePid) || input.queuePid <= 0)
	)
		throw new TypeError("Status queue pid is invalid.");
	const seen = new Set<string>();
	for (const intent of input.intents) {
		if (!checkedIntent(intent)) continue;
		if (seen.has(intent.slug))
			throw new TypeError(`Status contains duplicate Intent ${intent.slug}.`);
		seen.add(intent.slug);
	}
	for (const landing of input.reachableLandings)
		if (!checkedLanding(landing))
			throw new TypeError("Reachable landing record is invalid.");
	for (const run of input.runs) {
		if (
			!RUN_ID.test(run.record.run_id) ||
			!isValidIntentSlug(run.record.slug) ||
			!Number.isSafeInteger(run.record.started_ms) ||
			run.record.started_ms < 0
		)
			throw new TypeError("Status run record is invalid.");
	}
}

/** Apply §2.11 precedence to an already recovered, immutable status snapshot. */
export function deriveStatus(input: StatusInput): DerivedStatus {
	validateInput(input);
	const intents = input.intents.filter(checkedIntent);
	const landings = new Map<string, ReachableLanding>();
	for (const landing of input.reachableLandings) {
		const previous = landings.get(landing.slug);
		if (
			previous === undefined ||
			landing.committedAt > previous.committedAt ||
			(landing.committedAt === previous.committedAt &&
				compareStatusText(landing.sha, previous.sha) > 0)
		)
			landings.set(landing.slug, landing);
	}
	const latestRuns = new Map<string, StatusRun>();
	const latestApprovalRuns = new Map<string, StatusRun>();
	for (const run of input.runs) {
		latestRuns.set(
			run.record.slug,
			latestRun(latestRuns.get(run.record.slug), run),
		);
		const key = `${run.record.slug}\0${run.record.approval_commit}`;
		latestApprovalRuns.set(key, latestRun(latestApprovalRuns.get(key), run));
	}

	const queueIntents: QueueIntent[] = intents.map((intent) => ({
		slug: intent.slug,
		approved: intent.approval !== null,
		landed: landings.has(intent.slug),
		priority: intent.priority,
		approvedAt: intent.approval?.approvedAt ?? 0,
		blocksOn: intent.blocksOn,
	}));
	const selected = selectQueue(queueIntents, new Set(landings.keys()));
	const blockedBySlug = new Map(
		selected.blocked.map((entry) => [entry.slug, entry]),
	);
	const queuedSlugs = new Set(selected.queued.map((entry) => entry.slug));

	const derived: DerivedIntent[] = intents.map((intent) => {
		const landed = landings.get(intent.slug) ?? null;
		const latest = latestRuns.get(intent.slug) ?? null;
		const current =
			intent.approval === null
				? null
				: (latestApprovalRuns.get(
						`${intent.slug}\0${intent.approval.commit}`,
					) ?? null);
		const last = current === null ? null : latestEvent(current);
		const interrupted =
			current !== null &&
			((current.record.status === "running" &&
				last?.event === "interrupted" &&
				current.ownerLiveness === "dead") ||
				(current.record.status === "failed" &&
					lastFinishedReason(current) === "interrupted"));
		const building =
			latest !== null &&
			latest.record.status === "running" &&
			input.claimRunId === latest.record.run_id;
		const blocked = blockedBySlug.get(intent.slug) ?? null;
		let status: DerivedIntentStatus;
		let detail: string | null = null;
		if (landed !== null) status = "landed";
		else if (interrupted) {
			status = "interrupted";
			detail = lastFinishedReason(current as StatusRun) ?? "interrupted";
		} else if (building) {
			status = "building";
			detail = currentStage(latest as StatusRun);
		} else if (current?.record.status === "failed") {
			status = "failed";
			detail = lastFinishedReason(current) ?? "unknown";
		} else if (current?.record.status === "parked") {
			status = "parked";
			detail = lastFinishedReason(current) ?? "unknown";
		} else if (blocked !== null && intent.approval !== null) {
			status = "blocked";
			detail = blockedDetail(blocked);
		} else if (queuedSlugs.has(intent.slug)) status = "queued";
		else if (intent.approval !== null) {
			// A stopped run remains approved. It is queued unless a stronger
			// current-approval or dependency state above applies.
			status = "queued";
		} else status = "draft";
		return {
			slug: intent.slug,
			status,
			priority: intent.priority,
			blocksOn: [...intent.blocksOn],
			acceptanceIds:
				intent.acceptanceIds === undefined ? null : [...intent.acceptanceIds],
			approval: intent.approval,
			landed,
			latestRun: latest,
			currentApprovalRun: current,
			detail,
			queuePosition: null,
			blocked: status === "blocked" ? blocked : null,
		};
	});
	const bySlug = new Map(derived.map((intent) => [intent.slug, intent]));
	const queued = selected.queued
		.map((entry) => bySlug.get(entry.slug))
		.filter((entry): entry is DerivedIntent => entry?.status === "queued");
	for (const [index, intent] of queued.entries()) {
		const position = index + 1;
		const replacement = { ...intent, queuePosition: position };
		bySlug.set(intent.slug, replacement);
		const itemIndex = derived.findIndex((entry) => entry.slug === intent.slug);
		if (itemIndex >= 0) derived[itemIndex] = replacement;
		queued[index] = replacement;
	}
	const blocked = derived
		.filter((intent) => intent.status === "blocked")
		.sort((left, right) => compareStatusText(left.slug, right.slug));
	const landedHistory = derived
		.filter((intent) => intent.status === "landed")
		.sort(
			(left, right) =>
				(right.landed?.committedAt ?? 0) - (left.landed?.committedAt ?? 0) ||
				compareStatusText(left.slug, right.slug),
		);
	const agents = [...input.agents].sort((left, right) =>
		compareStatusText(left.id, right.id),
	);
	return {
		intents: [...derived].sort((left, right) =>
			compareStatusText(left.slug, right.slug),
		),
		bySlug,
		queue: {
			runningPid: input.queuePid,
			queued,
			blocked,
			next: queued[0] ?? null,
		},
		landedHistory,
		agents,
		nowMs: input.nowMs,
	};
}

export function isStatusWatchIdle(status: DerivedStatus): boolean {
	return (
		status.queue.runningPid === null &&
		!status.intents.some((intent) => intent.status === "building") &&
		!status.agents.some(
			(agent) => agent.status === "running" || agent.status === "waiting",
		)
	);
}
