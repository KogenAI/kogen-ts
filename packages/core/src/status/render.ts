import type { DerivedIntent, DerivedStatus, StatusInput } from "./derive";
import {
	agentStatusJson,
	buildStatusReport,
	type StatusBuildReport,
	type StatusModelStage,
	statusIntentJson,
} from "./report";

function shortId(value: string | null): string {
	return value === null ? "unknown" : value.slice(0, 8);
}

function safeLine(value: string): string {
	return value.replace(/[\r\n\0]/gu, " ");
}

export function formatElapsed(milliseconds: number): string {
	const duration = Math.max(0, Math.trunc(milliseconds));
	const seconds = Math.floor(duration / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function section(
	label: string,
	rows: readonly DerivedIntent[],
	detail: (intent: DerivedIntent) => string,
): string[] {
	if (rows.length === 0) return [];
	const width = Math.max(...rows.map((intent) => intent.slug.length));
	return [
		`${label}:`,
		...rows.map((intent) => {
			const suffix = detail(intent);
			return `  ${intent.slug.padEnd(width, " ")}  ${safeLine(suffix)}`;
		}),
	];
}

function buildingDetail(intent: DerivedIntent, status: DerivedStatus): string {
	const run = intent.latestRun;
	const stage = intent.detail ?? "starting";
	if (run === null) return `${stage} (Build unknown)`;
	const elapsed = Math.max(0, status.nowMs - run.record.started_ms);
	return `${stage}, ${formatElapsed(elapsed)} (Build ${shortId(run.record.run_id)})`;
}

function buildReason(intent: DerivedIntent): string {
	const run = intent.currentApprovalRun ?? intent.latestRun;
	return intent.detail ?? (run === null ? "unknown" : "unknown");
}

function nextLine(status: DerivedStatus): string | null {
	const next = status.queue.next;
	if (next === null) return null;
	const dependencies =
		next.blocksOn.length === 0 ? "no dependencies" : "dependencies delivered";
	return `Next: ${next.slug} (priority ${next.priority}; ${dependencies}; ties by approval time and slug)`;
}

function agentLines(status: DerivedStatus): string[] {
	if (status.agents.length === 0) return [];
	return [
		"Agents:",
		...status.agents.flatMap((agent) => [
			`  ${safeLine(agent.id)} ${safeLine(agent.role)} Build=${safeLine(agent.buildId)} ${safeLine(agent.status)} elapsed_ms=${Math.max(0, status.nowMs - agent.startedMs)} ${safeLine(agent.activity)}`,
			`    events: ${safeLine(agent.eventsPath)}`,
		]),
	];
}

/** Render the complete human-readable status overview frame. */
export function renderStatusOverview(status: DerivedStatus): string {
	const lines: string[] = [];
	if (status.queue.runningPid !== null)
		lines.push(`Queue: running (pid ${status.queue.runningPid})`);
	else if (status.queue.queued.length > 0)
		lines.push(
			`Queue: stopped, ${status.queue.queued.length} waiting; start it with kogen queue start`,
		);
	else lines.push("Queue: stopped");
	const next = nextLine(status);
	if (next !== null) lines.push(next);

	const building = status.intents.filter(
		(intent) => intent.status === "building",
	);
	const queued = status.intents.filter((intent) => intent.status === "queued");
	const blocked = status.intents.filter(
		(intent) => intent.status === "blocked",
	);
	const failed = status.intents.filter((intent) => intent.status === "failed");
	const parked = status.intents.filter((intent) => intent.status === "parked");
	const interrupted = status.intents.filter(
		(intent) => intent.status === "interrupted",
	);
	const drafts = status.intents.filter((intent) => intent.status === "draft");
	const landed = status.landedHistory;

	if (status.intents.length === 0) lines.push("No Intents.");
	lines.push(
		...section("Building", building, (intent) =>
			buildingDetail(intent, status),
		),
	);
	if (queued.length > 0)
		lines.push("Queued:", ...queued.map((intent) => `  ${intent.slug}`));
	lines.push(
		...section("Blocked", blocked, (intent) => intent.detail ?? "unknown"),
	);
	lines.push(
		...section(
			"Failed",
			failed,
			(intent) =>
				`${buildReason(intent)} (Build ${shortId((intent.currentApprovalRun ?? intent.latestRun)?.record.run_id ?? null)})`,
		),
	);
	lines.push(
		...section(
			"Parked",
			parked,
			(intent) =>
				`${buildReason(intent)} (Build ${shortId((intent.currentApprovalRun ?? intent.latestRun)?.record.run_id ?? null)})`,
		),
	);
	lines.push(
		...section(
			"Interrupted",
			interrupted,
			(intent) =>
				`${buildReason(intent)} (Build ${shortId((intent.currentApprovalRun ?? intent.latestRun)?.record.run_id ?? null)})`,
		),
	);
	if (drafts.length > 0)
		lines.push("Drafts:", ...drafts.map((intent) => `  ${intent.slug}`));
	if (landed.length > 0) {
		lines.push(`Landed (${landed.length}):`);
		const landedWidth = Math.max(...landed.map((intent) => intent.slug.length));
		for (const intent of landed.slice(0, 5))
			lines.push(
				`  ${intent.slug.padEnd(landedWidth, " ")}  ${shortId(intent.landed?.sha ?? null)}`,
			);
		if (landed.length > 5) lines.push(`  and ${landed.length - 5} earlier`);
	}
	lines.push(...agentLines(status));
	return `${lines.join("\n")}\n`;
}

function slugStatusLine(intent: DerivedIntent, status: DerivedStatus): string {
	switch (intent.status) {
		case "landed":
			return `${intent.slug}: landed ${shortId(intent.landed?.sha ?? null)}`;
		case "queued":
			return `${intent.slug}: queued, ${intent.queuePosition ?? 1} of ${status.queue.queued.length}`;
		case "building":
			return `${intent.slug}: building, ${buildingDetail(intent, status)}`;
		case "blocked":
			return `${intent.slug}: blocked, ${safeLine(intent.detail ?? "unknown")}`;
		case "failed":
		case "parked":
		case "interrupted":
			return `${intent.slug}: ${intent.status}, ${safeLine(buildReason(intent))}`;
		case "draft":
			return `${intent.slug}: draft; review it with kogen intent approve ${intent.slug}`;
	}
}

function runFinishReason(intent: DerivedIntent): string | null {
	const run = intent.latestRun;
	if (run === null) return null;
	for (let index = run.events.length - 1; index >= 0; index -= 1) {
		const event = run.events[index];
		if (
			(event?.event === "finished" || event?.event === "reconciled") &&
			typeof event.reason === "string"
		)
			return event.reason;
	}
	return null;
}

function stageTimes(
	stages: readonly StatusModelStage[],
): readonly [string, number][] {
	const total = new Map<string, number>();
	for (const stage of stages) {
		if (stage.stage === null || stage.wall_ms === null) continue;
		total.set(stage.stage, (total.get(stage.stage) ?? 0) + stage.wall_ms);
	}
	return [...total.entries()];
}

function phaseTiming(
	run: NonNullable<DerivedIntent["latestRun"]>,
	phase: string,
): number | null {
	for (let index = run.events.length - 1; index >= 0; index -= 1) {
		const event = run.events[index];
		if (event?.event === "phase_timing" && event.phase === phase)
			return typeof event.wall_ms === "number" &&
				Number.isSafeInteger(event.wall_ms)
				? event.wall_ms
				: null;
	}
	return null;
}

function setupLine(
	run: NonNullable<DerivedIntent["latestRun"]>,
): string | null {
	for (let index = run.events.length - 1; index >= 0; index -= 1) {
		const event = run.events[index];
		if (event?.event === "setup_reused") {
			const saved =
				typeof event.saved_wall_ms === "number" ? event.saved_wall_ms : 0;
			return `  setup: reused (saved preparation ${saved} ms)`;
		}
	}
	const prepared = phaseTiming(run, "setup");
	return prepared === null ? null : `  setup: prepared in ${prepared} ms`;
}

function contextContinuations(
	run: NonNullable<DerivedIntent["latestRun"]>,
): number {
	if (run.contextContinuations !== undefined) return run.contextContinuations;
	return run.events.filter(
		(event) =>
			event.event === "context_continuation" ||
			event.event === "checkpoint_accepted",
	).length;
}

function acceptanceProgress(
	intent: DerivedIntent,
	report: StatusBuildReport,
): string[] {
	if (report.acceptance.length === 0) return [];
	const passed = new Set(
		report.acceptance
			.filter((item) => item.status === "pass")
			.map((item) => item.id),
	);
	const all = intent.acceptanceIds ?? report.acceptance.map((item) => item.id);
	const verified = all.filter((id) => passed.has(id));
	const remaining = all.filter((id) => !passed.has(id));
	const lines: string[] = [];
	if (verified.length > 0)
		lines.push(`  acceptance verified: ${verified.join(", ")}`);
	if (remaining.length > 0)
		lines.push(`  acceptance remaining: ${remaining.join(", ")}`);
	return lines;
}

/** Render one Intent and its latest Build using §1.7.5 text lines. */
export function renderIntentStatus(
	status: DerivedStatus,
	input: StatusInput,
	slug: string,
): string | null {
	const intent = status.bySlug.get(slug);
	if (intent === undefined) return null;
	const lines = [slugStatusLine(intent, status)];
	const run = intent.latestRun;
	if (run !== null) {
		const reason = runFinishReason(intent);
		lines.push(
			`Build ${shortId(run.record.run_id)}: ${run.record.status}${reason === null ? "" : `, ${safeLine(reason)}`}`,
		);
		const modelTimes = stageTimes(
			buildStatusReport(status, intent, input).model_stages,
		);
		if (modelTimes.length > 0)
			lines.push(
				`  model time: ${modelTimes.map(([stage, duration]) => `${safeLine(stage)} ${formatElapsed(duration)}`).join(", ")}`,
			);
		if (run.candidateChecks !== undefined && run.candidateChecks.length > 0)
			lines.push(
				`  candidate checks (caller approval required): ${run.candidateChecks.join(", ")}`,
			);
		const setup = setupLine(run);
		if (setup !== null) lines.push(setup);
		const continuations = contextContinuations(run);
		if (continuations > 0)
			lines.push(
				`  context continuations: ${continuations} (same approved Build; checkpoints in journal)`,
			);
		const gateTiming = phaseTiming(run, "gate");
		if (gateTiming !== null) lines.push(`  gate: ${gateTiming} ms`);
		const report = buildStatusReport(status, intent, input);
		lines.push(...acceptanceProgress(intent, report));
		if (run.candidateDiffPath !== undefined && run.candidateDiffPath !== null)
			lines.push(`  candidate diff: ${safeLine(run.candidateDiffPath)}`);
		lines.push(`  journal: ${safeLine(run.journalPath)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Select the full text frame used by status and --watch. */
export function renderStatusText(
	status: DerivedStatus,
	input: StatusInput,
	slug?: string,
): string | null {
	return slug === undefined
		? renderStatusOverview(status)
		: renderIntentStatus(status, input, slug);
}

/** Render the `--json` JSON Lines payload, preserving every specified null. */
export function renderStatusJsonLines(
	status: DerivedStatus,
	input: StatusInput,
	slug?: string,
): string | null {
	if (slug !== undefined) {
		const intent = status.bySlug.get(slug);
		return intent === undefined
			? null
			: `${JSON.stringify(buildStatusReport(status, intent, input))}\n`;
	}
	const lines = status.intents.map((intent) =>
		JSON.stringify(statusIntentJson(intent)),
	);
	for (const agent of status.agents) {
		const report = {
			id: agent.id,
			role: agent.role,
			build: agent.buildId,
			status: agent.status,
			elapsed_ms: Math.max(0, status.nowMs - agent.startedMs),
			activity: agent.activity,
			events: agent.eventsPath,
		};
		lines.push(JSON.stringify(agentStatusJson(report)));
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
