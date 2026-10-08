import type { JournalEvent } from "../../../core/src/run/journal";
import type { RunRecord, RunStatus } from "../../../core/src/run/store";
import {
	deriveStatus,
	isStatusWatchIdle,
	type ReachableLanding,
	type StatusAgent,
	type StatusApproval,
	type StatusInput,
	type StatusIntent,
	type StatusRun,
} from "../../../core/src/status/derive";
import { renderStatusOverview } from "../../../core/src/status/render";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

type StatusTag =
	| "Init"
	| "Row"
	| "Raw"
	| "Derive"
	| "Now"
	| "Older"
	| "Queue"
	| "Agents"
	| "Watch"
	| "Json";

interface RowEvent {
	readonly slug: string;
	readonly status: string;
	readonly priority: number;
	readonly at: number;
	readonly blocks: string;
	readonly sched: string;
	readonly started: number;
	readonly index: number;
}

interface RawEvent {
	readonly slug: string;
	readonly trailer: boolean;
	readonly claimed: boolean;
	readonly runStatus: string;
	readonly event: string;
	readonly alive: boolean;
	readonly approved: boolean;
	readonly reason: string;
	readonly same: boolean;
	readonly blocks: string;
	readonly priority: number;
	readonly at: number;
}

type FixtureCard =
	| { readonly kind: "row"; readonly value: RowEvent }
	| { readonly kind: "raw"; readonly value: RawEvent };

interface StatusSliceState {
	cards: Map<string, FixtureCard>;
	now: number;
	older: number;
	running: boolean;
	watchSlug: string;
	watchExit: number;
	busyAgents: number;
	last: string;
}

interface StatusObservation {
	readonly last: string;
	readonly alpha: string;
	readonly bravo: string;
	readonly charlie: string;
	readonly queue: readonly string[];
	readonly whyA: string;
	readonly whyB: string;
	readonly whyC: string;
	readonly sections: readonly string[];
	readonly earlier: number;
	readonly elapsed: string;
	readonly queueLine: "running" | "waiting" | "stopped";
	readonly next: string;
	readonly nextPriority: number;
	readonly nextDependencies: string;
	readonly landedShown: number;
	readonly watchSlug: string;
	readonly watchStatus: string;
	readonly watchPosition: number;
	readonly watchQueueSize: number;
	readonly exit: number;
	readonly jsonDetail: false;
}

const KNOWN_SLUGS = new Set(["alpha", "bravo", "charlie"]);
const KNOWN_STATUSES = new Set([
	"approved",
	"building",
	"failed",
	"parked",
	"draft",
	"landed",
	"interrupted",
]);
const KNOWN_BLOCKS = new Set(["", "BAD", "ghost", ...KNOWN_SLUGS]);
const SECTION_ORDER = [
	"Building",
	"Queued",
	"Blocked",
	"Failed",
	"Parked",
	"Interrupted",
	"Drafts",
	"Landed",
] as const;
const MAX_FIXTURE_ROWS = 10_000;
const APPROVAL_COMMIT = "a".repeat(40);
const STALE_APPROVAL_COMMIT = "b".repeat(40);
const APPROVAL_HASH = "c".repeat(64);
const LANDING_SHAS = new Map([
	["alpha", "d".repeat(40)],
	["bravo", "e".repeat(40)],
	["charlie", "f".repeat(40)],
]);

function emptyState(): StatusSliceState {
	return {
		cards: new Map(),
		now: 0,
		older: 0,
		running: false,
		watchSlug: "",
		watchExit: 0,
		busyAgents: 0,
		last: "ok",
	};
}

function eventValue(
	value: unknown,
	tag: StatusTag,
	fields: readonly string[],
): Record<string, unknown> {
	const decoded = decodeSliceEvent(value);
	if (decoded.tag !== tag)
		throw new XspecProtocolError(
			"invalid_event",
			`status slice expected a ${tag} event`,
		);
	if (fields.length === 0) {
		if (decoded.value !== undefined)
			throw new XspecProtocolError(
				"invalid_event",
				`${tag} event does not accept a value`,
			);
		return Object.create(null) as Record<string, unknown>;
	}
	if (decoded.value === undefined)
		throw new XspecProtocolError(
			"invalid_event",
			`${tag} event requires a value`,
		);
	if (
		Object.keys(decoded.value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(decoded.value ?? {}, field))
	)
		throw new XspecProtocolError(
			"invalid_event",
			`${tag} event does not match the frozen field schema`,
		);
	return decoded.value;
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new XspecProtocolError(
			"invalid_event",
			`Status.${key} must be a string`,
		);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean")
		throw new XspecProtocolError(
			"invalid_event",
			`Status.${key} must be a boolean`,
		);
	return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (typeof field !== "number" || !Number.isSafeInteger(field))
		throw new XspecProtocolError(
			"invalid_event",
			`Status.${key} must be a safe integer`,
		);
	return field;
}

function decodeStatusEvent(value: unknown): {
	readonly tag: StatusTag;
	readonly value: Record<string, unknown>;
} {
	const decoded = decodeSliceEvent(value);
	switch (decoded.tag) {
		case "Init":
		case "Derive":
		case "Json":
			return {
				tag: decoded.tag,
				value: eventValue(value, decoded.tag, []),
			};
		case "Row":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Row", [
					"slug",
					"status",
					"priority",
					"at",
					"blocks",
					"sched",
					"started",
					"index",
				]),
			};
		case "Raw":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Raw", [
					"slug",
					"trailer",
					"claimed",
					"runStatus",
					"event",
					"alive",
					"approved",
					"reason",
					"same",
					"blocks",
					"priority",
					"at",
				]),
			};
		case "Now":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Now", ["t"]),
			};
		case "Older":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Older", ["n"]),
			};
		case "Queue":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Queue", ["running"]),
			};
		case "Agents":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Agents", ["busy"]),
			};
		case "Watch":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Watch", ["slug"]),
			};
		default:
			throw new XspecProtocolError(
				"invalid_event",
				`status slice does not recognize event ${JSON.stringify(decoded.tag)}`,
			);
	}
}

function secondsToMilliseconds(seconds: number): number {
	const milliseconds = seconds * 1000;
	if (!Number.isSafeInteger(milliseconds))
		throw new XspecProtocolError(
			"invalid_event",
			"Status time is outside the safe millisecond range",
		);
	return milliseconds;
}

function statusApproval(at: number, same = true): StatusApproval {
	return {
		commit: same ? APPROVAL_COMMIT : STALE_APPROVAL_COMMIT,
		sha256: APPROVAL_HASH,
		approvedAt: secondsToMilliseconds(at),
		approvedBy: "Fixture",
		baseSha: "0".repeat(40),
	};
}

function runId(slug: string): string {
	const marker = slug === "alpha" ? "1" : slug === "bravo" ? "2" : "3";
	return marker.repeat(32);
}

function approvalCommitForRun(same: boolean): string {
	return same ? APPROVAL_COMMIT : STALE_APPROVAL_COMMIT;
}

function runRecord(
	slug: string,
	status: RunStatus,
	startedSeconds: number,
	same: boolean,
): RunRecord {
	const id = runId(slug);
	const started = secondsToMilliseconds(startedSeconds);
	return {
		schema: 2,
		run_id: id,
		slug,
		approval_sha256: APPROVAL_HASH,
		approval_commit: approvalCommitForRun(same),
		target_branch: "main",
		status,
		landing: null,
		owner_pid: 4242,
		owner_started_ms: started,
		started_ms: started,
		recovery: [],
		cleanup_pending: false,
	};
}

function runEvent(event: string, at: number, reason: string): JournalEvent {
	const timestamp = secondsToMilliseconds(at);
	if (event === "finished" || event === "reconciled")
		return { event, ts: timestamp, reason };
	return { event, ts: timestamp };
}

function makeRun(
	slug: string,
	status: RunStatus,
	startedSeconds: number,
	same: boolean,
	ownerLiveness: StatusRun["ownerLiveness"],
	event: string,
	reason: string,
): StatusRun {
	const record = runRecord(slug, status, startedSeconds, same);
	return {
		record,
		events: [runEvent(event, startedSeconds, reason)],
		journalPath: `/fixture/${slug}/${record.run_id}.jsonl`,
		ownerLiveness,
	};
}

function runStatus(value: string): RunStatus | null {
	if (
		value === "running" ||
		value === "landed" ||
		value === "failed" ||
		value === "parked" ||
		value === "stopped"
	)
		return value;
	return null;
}

function approvalNeeded(status: string): boolean {
	return status !== "draft" && status !== "landed";
}

function blocksOf(blocks: string, sched: string): readonly string[] {
	if (sched.length > 0) return ["BAD"];
	return blocks.length === 0 ? [] : [blocks];
}

function rowIntent(row: RowEvent): StatusIntent {
	const approval = approvalNeeded(row.status) ? statusApproval(row.at) : null;
	return {
		slug: row.slug,
		priority: row.priority,
		blocksOn: blocksOf(row.blocks, row.sched),
		approval,
	};
}

function rawIntent(raw: RawEvent): StatusIntent {
	return {
		slug: raw.slug,
		priority: raw.priority,
		blocksOn: raw.blocks.length === 0 ? [] : [raw.blocks],
		approval: raw.approved ? statusApproval(raw.at, raw.same) : null,
	};
}

function rowRun(row: RowEvent): StatusRun | null {
	if (row.status === "building")
		return makeRun(
			row.slug,
			"running",
			row.started,
			true,
			"live",
			"started",
			"",
		);
	if (row.status === "failed")
		return makeRun(
			row.slug,
			"failed",
			row.at,
			true,
			"dead",
			"finished",
			"unknown",
		);
	if (row.status === "parked")
		return makeRun(
			row.slug,
			"parked",
			row.at,
			true,
			"dead",
			"finished",
			"unknown",
		);
	if (row.status === "interrupted")
		return makeRun(
			row.slug,
			"failed",
			row.at,
			true,
			"dead",
			"finished",
			"interrupted",
		);
	return null;
}

function rawRun(raw: RawEvent): StatusRun | null {
	const status = runStatus(raw.runStatus);
	if (status === null) return null;
	return makeRun(
		raw.slug,
		status,
		0,
		raw.same,
		raw.alive ? "live" : "dead",
		status === "failed" ? "finished" : raw.event,
		raw.reason,
	);
}

function landing(slug: string, at: number): ReachableLanding {
	const sha = LANDING_SHAS.get(slug);
	if (sha === undefined)
		throw new Error(`Missing fixture landing hash for ${slug}`);
	return { slug, sha, committedAt: secondsToMilliseconds(at) };
}

function currentCards(state: StatusSliceState): readonly FixtureCard[] {
	return [...state.cards.values()];
}

function statusInput(state: StatusSliceState): StatusInput {
	const intents: StatusIntent[] = [];
	const runs: StatusRun[] = [];
	const reachableLandings: ReachableLanding[] = [];
	let claimRunId: string | null = null;
	for (const card of currentCards(state)) {
		if (card.kind === "row") {
			const row = card.value;
			intents.push(rowIntent(row));
			const run = rowRun(row);
			if (run !== null) {
				runs.push(run);
				if (row.status === "building") claimRunId = run.record.run_id;
			}
			if (row.status === "landed")
				reachableLandings.push(landing(row.slug, row.index));
			continue;
		}
		const raw = card.value;
		intents.push(rawIntent(raw));
		const run = rawRun(raw);
		if (run !== null) {
			runs.push(run);
			if (
				raw.claimed &&
				raw.runStatus === "running" &&
				!raw.trailer &&
				!(raw.event === "interrupted" && !raw.alive)
			)
				claimRunId = run.record.run_id;
		}
		if (raw.trailer) reachableLandings.push(landing(raw.slug, raw.at));
	}
	for (let index = 0; index < state.older; index += 1) {
		const slug = `older-${String(index + 1).padStart(6, "0")}`;
		intents.push({
			slug,
			priority: 0,
			blocksOn: [],
			approval: null,
		});
		reachableLandings.push({
			slug,
			sha: `${(index + 1).toString(16).padStart(40, "0")}`,
			committedAt: index,
		});
	}
	const agents: StatusAgent[] = [];
	for (let index = 0; index < state.busyAgents; index += 1) {
		const id = `agent-${String(index + 1).padStart(6, "0")}`;
		agents.push({
			id,
			role: "fixture",
			buildId: claimRunId ?? "fixture-build",
			status: "running",
			startedMs: secondsToMilliseconds(state.now),
			activity: "fixture",
			eventsPath: `/fixture/agents/${id}.jsonl`,
		});
	}
	return {
		intents,
		reachableLandings,
		runs,
		claimRunId,
		queuePid: state.running ? 4242 : null,
		agents,
		nowMs: secondsToMilliseconds(state.now),
	};
}

function fixtureForSlug(
	state: StatusSliceState,
	slug: string,
): FixtureCard | undefined {
	return state.cards.get(slug);
}

function schedulingError(state: StatusSliceState, slug: string): string | null {
	const card = fixtureForSlug(state, slug);
	return card?.kind === "row" && card.value.sched.length > 0
		? card.value.sched
		: null;
}

/** Format only the selector's typed decision; policy stays in deriveStatus/selectQueue. */
function blockedReason(
	state: StatusSliceState,
	input: StatusInput,
	slug: string,
): string {
	const suppliedSchedulingError = schedulingError(state, slug);
	if (suppliedSchedulingError !== null) return suppliedSchedulingError;
	const intent = deriveStatus(input).bySlug.get(slug);
	const blocked = intent?.blocked;
	if (blocked === null || blocked === undefined) return intent?.detail ?? "";
	const dependencies = blocked.dependencies;
	switch (blocked.reason) {
		case "dependency_cycle": {
			const bySlug = new Map(input.intents.map((entry) => [entry.slug, entry]));
			const path = [slug];
			const seen = new Set([slug]);
			let current = slug;
			for (let count = 0; count < input.intents.length; count += 1) {
				const next = bySlug.get(current)?.blocksOn[0];
				if (next === undefined) break;
				path.push(next);
				if (next === slug) return `dependency cycle: ${path.join(" -> ")}`;
				if (seen.has(next)) break;
				seen.add(next);
				current = next;
			}
			return `dependency cycle: ${dependencies.join(", ")}`;
		}
		case "unknown_dependency":
			return `unknown dependencies: ${dependencies.join(", ")}`;
		case "dependency_not_landed":
			return `waiting for delivered dependencies: ${dependencies.join(", ")}`;
		case "invalid_dependencies":
			return `invalid dependencies: ${dependencies.join(", ")}`;
	}
}

function sectionsFromRendered(text: string): readonly string[] {
	const lines = text.split("\n");
	const result: string[] = [];
	for (const line of lines) {
		for (const title of SECTION_ORDER) {
			if (
				line === `${title}:` ||
				(title === "Landed" && /^Landed \(\d+\):$/u.test(line))
			) {
				result.push(title);
				break;
			}
		}
	}
	return result;
}

function elapsedBucket(
	text: string,
	status: ReturnType<typeof deriveStatus>,
): string {
	const intent = status.intents.find((entry) => entry.status === "building");
	if (intent?.latestRun?.record.started_ms === 0) return "";
	const match = text.match(/^Building:\n[^\n]*, \d+(s|m|h)/mu);
	return match?.[1] ?? "";
}

function statusName(
	status: ReturnType<typeof deriveStatus>,
	slug: string,
): string {
	const value = status.bySlug.get(slug)?.status;
	return value === "queued" ? "approved" : (value ?? "");
}

function watchStatus(
	status: ReturnType<typeof deriveStatus>,
	slug: string,
	exit: number,
): string {
	if (slug.length === 0) return "";
	if (exit === 2) return "not_found";
	const intent = status.bySlug.get(slug);
	if (intent === undefined) return "not_found";
	return intent.status === "queued" ? "queued" : intent.status;
}

function observation(state: StatusSliceState): StatusObservation {
	const input = statusInput(state);
	const derived = deriveStatus(input);
	const text = renderStatusOverview(derived);
	const queue = derived.queue.queued.map((intent) => intent.slug);
	const next = derived.queue.next;
	const watchPosition = queue.indexOf(state.watchSlug);
	const watch = watchStatus(derived, state.watchSlug, state.watchExit);
	return {
		last: state.last,
		alpha: statusName(derived, "alpha"),
		bravo: statusName(derived, "bravo"),
		charlie: statusName(derived, "charlie"),
		queue,
		whyA:
			derived.bySlug.get("alpha")?.status === "blocked"
				? blockedReason(state, input, "alpha")
				: "",
		whyB:
			derived.bySlug.get("bravo")?.status === "blocked"
				? blockedReason(state, input, "bravo")
				: "",
		whyC:
			derived.bySlug.get("charlie")?.status === "blocked"
				? blockedReason(state, input, "charlie")
				: "",
		sections: sectionsFromRendered(text),
		earlier: Math.max(0, derived.landedHistory.length - 5),
		elapsed: elapsedBucket(text, derived),
		queueLine: text.startsWith("Queue: running")
			? "running"
			: derived.queue.queued.length > 0
				? "waiting"
				: "stopped",
		next: next?.slug ?? "",
		nextPriority: next?.priority ?? 0,
		nextDependencies:
			next === null
				? ""
				: next.blocksOn.length === 0
					? "no_dependencies"
					: "dependencies_delivered",
		landedShown: Math.min(5, derived.landedHistory.length),
		watchSlug: state.watchSlug,
		watchStatus: watch,
		watchPosition,
		watchQueueSize: queue.length,
		exit: state.watchExit,
		jsonDetail: false,
	};
}

function validBlocks(blocks: string): boolean {
	return KNOWN_BLOCKS.has(blocks);
}

function validNonnegativeMillisecondsInput(value: number): boolean {
	if (value < 0) return false;
	secondsToMilliseconds(value);
	return true;
}

function setWatch(state: StatusSliceState, slug: string): void {
	state.watchSlug = slug;
	const derived = deriveStatus(statusInput(state));
	if (slug !== "") {
		const intent = derived.bySlug.get(slug);
		state.watchExit =
			intent === undefined ? 2 : intent.status === "landed" ? 0 : 1;
		return;
	}
	state.watchExit = isStatusWatchIdle(derived) ? 0 : -1;
}

function setRow(state: StatusSliceState, value: Record<string, unknown>): void {
	const row: RowEvent = {
		slug: stringField(value, "slug"),
		status: stringField(value, "status"),
		priority: integerField(value, "priority"),
		at: integerField(value, "at"),
		blocks: stringField(value, "blocks"),
		sched: stringField(value, "sched"),
		started: integerField(value, "started"),
		index: integerField(value, "index"),
	};
	if (!KNOWN_SLUGS.has(row.slug)) {
		state.last = "bad_slug";
		return;
	}
	if (!KNOWN_STATUSES.has(row.status)) {
		state.last = "bad_status";
		return;
	}
	if (!validBlocks(row.blocks)) {
		state.last = "bad_blocks";
		return;
	}
	if (
		!validNonnegativeMillisecondsInput(row.at) ||
		!validNonnegativeMillisecondsInput(row.started)
	)
		throw new XspecProtocolError(
			"invalid_event",
			"Status row times must be nonnegative safe integers",
		);
	state.cards.set(row.slug, { kind: "row", value: row });
	state.last = "ok";
}

function setRaw(state: StatusSliceState, value: Record<string, unknown>): void {
	const raw: RawEvent = {
		slug: stringField(value, "slug"),
		trailer: booleanField(value, "trailer"),
		claimed: booleanField(value, "claimed"),
		runStatus: stringField(value, "runStatus"),
		event: stringField(value, "event"),
		alive: booleanField(value, "alive"),
		approved: booleanField(value, "approved"),
		reason: stringField(value, "reason"),
		same: booleanField(value, "same"),
		blocks: stringField(value, "blocks"),
		priority: integerField(value, "priority"),
		at: integerField(value, "at"),
	};
	if (!KNOWN_SLUGS.has(raw.slug)) {
		state.last = "bad_slug";
		return;
	}
	if (!validBlocks(raw.blocks)) {
		state.last = "bad_blocks";
		return;
	}
	if (!validNonnegativeMillisecondsInput(raw.at))
		throw new XspecProtocolError(
			"invalid_event",
			"Status raw time must be a nonnegative safe integer",
		);
	state.cards.set(raw.slug, { kind: "raw", value: raw });
	state.last = "ok";
}

function applyEvent(
	state: StatusSliceState,
	value: unknown,
): StatusObservation {
	const { tag, value: event } = decodeStatusEvent(value);
	switch (tag) {
		case "Init":
			state.cards.clear();
			state.now = 0;
			state.older = 0;
			state.running = false;
			state.watchSlug = "";
			state.watchExit = 0;
			state.busyAgents = 0;
			state.last = "ok";
			break;
		case "Row":
			setRow(state, event);
			break;
		case "Raw":
			setRaw(state, event);
			break;
		case "Derive":
			state.last = "ok";
			break;
		case "Now": {
			const time = integerField(event, "t");
			if (time < 0)
				throw new XspecProtocolError(
					"invalid_event",
					"Status.t must be nonnegative",
				);
			secondsToMilliseconds(time);
			state.now = time;
			state.last = "ok";
			break;
		}
		case "Older": {
			const count = integerField(event, "n");
			if (count < 0) state.last = "bad_older";
			else if (count > MAX_FIXTURE_ROWS)
				throw new XspecProtocolError(
					"invalid_event",
					`Status older history exceeds ${MAX_FIXTURE_ROWS} rows`,
				);
			else {
				state.older = count;
				state.last = "ok";
			}
			break;
		}
		case "Queue":
			state.running = booleanField(event, "running");
			state.last = "ok";
			break;
		case "Agents": {
			const busy = integerField(event, "busy");
			if (busy < 0) state.last = "bad_agents";
			else if (busy > MAX_FIXTURE_ROWS)
				throw new XspecProtocolError(
					"invalid_event",
					`Status busy agent count exceeds ${MAX_FIXTURE_ROWS}`,
				);
			else {
				state.busyAgents = busy;
				state.last = "ok";
			}
			break;
		}
		case "Watch":
			setWatch(state, stringField(event, "slug"));
			state.last = "ok";
			break;
		case "Json":
			state.last = "ok";
			break;
	}
	return observation(state);
}

export async function createStatusSlice(): Promise<XspecSlice> {
	let state = emptyState();
	return {
		reset: async () => {
			state = emptyState();
			return observation(state);
		},
		apply: async (event) => applyEvent(state, event),
	};
}
