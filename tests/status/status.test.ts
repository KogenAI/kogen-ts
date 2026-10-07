import { expect, test } from "bun:test";
import type { JournalEvent } from "../../packages/core/src/run/journal";
import type { RunRecord } from "../../packages/core/src/run/store";
import {
	deriveStatus,
	landingsFromReachableCommits,
	type ReachableLanding,
	type StatusAgent,
	type StatusApproval,
	type StatusInput,
	type StatusIntent,
	type StatusRun,
} from "../../packages/core/src/status/derive";
import {
	renderIntentStatus,
	renderStatusJsonLines,
	renderStatusOverview,
} from "../../packages/core/src/status/render";
import {
	type StatusWatchSnapshot,
	statusWatchPollMilliseconds,
	watchStatus,
} from "../../packages/core/src/status/watch";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA1_C = "c".repeat(40);
const SHA256_A = "a".repeat(64);

function approval(
	commit = SHA1_A,
	approvedAt = 1_700_000_000_000,
	overrides: Partial<StatusApproval> = {},
): StatusApproval {
	return {
		commit,
		sha256: SHA256_A,
		approvedAt,
		approvedBy: "Kogen Test <test@kogen.invalid>",
		baseSha: SHA1_B,
		...overrides,
	};
}

function intent(
	slug: string,
	options: Partial<StatusIntent> = {},
): StatusIntent {
	return {
		slug,
		priority: 0,
		blocksOn: [],
		approval: approval(),
		...options,
	};
}

function record(
	slug: string,
	runId: string,
	status: RunRecord["status"],
	startedMs: number,
	approvalCommit = SHA1_A,
): RunRecord {
	return {
		schema: 2,
		run_id: runId,
		slug,
		approval_sha256: SHA256_A,
		approval_commit: approvalCommit,
		target_branch: "main",
		status,
		landing: null,
		owner_pid: 777,
		owner_started_ms: startedMs,
		started_ms: startedMs,
		recovery: [],
		cleanup_pending: false,
	};
}

function run(
	slug: string,
	status: RunRecord["status"],
	startedMs: number,
	options: {
		readonly runId?: string;
		readonly approvalCommit?: string;
		readonly events?: readonly JournalEvent[];
		readonly ownerLiveness?: StatusRun["ownerLiveness"];
		readonly journalPath?: string;
	} = {},
): StatusRun {
	const runId = options.runId ?? "1".repeat(32);
	return {
		record: record(
			slug,
			runId,
			status,
			startedMs,
			options.approvalCommit ?? SHA1_A,
		),
		events: options.events ?? [],
		journalPath: options.journalPath ?? `/tmp/runs/${runId}`,
		ownerLiveness: options.ownerLiveness ?? "live",
	};
}

function input(options: Partial<StatusInput> = {}): StatusInput {
	return {
		intents: [],
		reachableLandings: [],
		runs: [],
		claimRunId: null,
		queuePid: null,
		agents: [],
		nowMs: 1_700_000_010_000,
		...options,
	};
}

function event(
	name: string,
	ts: number,
	fields: Record<string, unknown> = {},
): JournalEvent {
	return { event: name, ts, ...fields } as JournalEvent;
}

function landing(
	slug: string,
	sha: string,
	committedAt: number,
): ReachableLanding {
	return { slug, sha, committedAt };
}

test("reachable landing wins over current approval and changed Intent contents", () => {
	const currentApproval = approval(SHA1_C, 50);
	const status = deriveStatus(
		input({
			intents: [intent("greet", { approval: currentApproval })],
			reachableLandings: [landing("greet", SHA1_B, 10)],
			runs: [
				run("greet", "failed", 100, {
					approvalCommit: currentApproval.commit,
					events: [
						event("finished", 101, { status: "failed", reason: "repair_cap" }),
					],
				}),
			],
		}),
	);
	expect(status.bySlug.get("greet")?.status).toBe("landed");
	expect(status.bySlug.get("greet")?.landed?.sha).toBe(SHA1_B);
});

test("only runs bound to the current approval classify failed or parked status", () => {
	const oldApproval = SHA1_A;
	const currentApproval = SHA1_C;
	const status = deriveStatus(
		input({
			intents: [intent("greet", { approval: approval(currentApproval) })],
			runs: [
				run("greet", "failed", 200, {
					approvalCommit: oldApproval,
					runId: "1".repeat(32),
					events: [
						event("finished", 201, { status: "failed", reason: "repair_cap" }),
					],
				}),
				run("greet", "stopped", 100, {
					approvalCommit: currentApproval,
					runId: "2".repeat(32),
					events: [
						event("finished", 101, {
							status: "stopped",
							reason: "provider/login",
						}),
					],
				}),
			],
		}),
	);
	const greet = status.bySlug.get("greet");
	expect(greet?.status).toBe("queued");
	expect(greet?.currentApprovalRun?.record.run_id).toBe("2".repeat(32));
	expect(greet?.latestRun?.record.run_id).toBe("1".repeat(32));
});

test("dead interrupted owner, dependency states, and deterministic next order are derived", () => {
	const done = "done-item";
	const status = deriveStatus(
		input({
			intents: [
				intent(done, { approval: null }),
				intent("high", {
					priority: 9,
					blocksOn: [done],
					approval: approval(SHA1_A, 20),
				}),
				intent("bravo", { priority: 2, approval: approval(SHA1_A, 20) }),
				intent("alpha", { priority: 2, approval: approval(SHA1_A, 10) }),
				intent("missing-dep", { blocksOn: ["not-here"] }),
				intent("cycle-one", { blocksOn: ["cycle-two"] }),
				intent("cycle-two", { blocksOn: ["cycle-one"] }),
				intent("failed", { approval: approval(SHA1_A, 1) }),
				intent("parked", { approval: approval(SHA1_A, 1) }),
				intent("stale", { approval: approval(SHA1_C, 1) }),
				intent("intr", { approval: approval(SHA1_A, 1) }),
			],
			reachableLandings: [landing(done, SHA1_B, 5)],
			runs: [
				run("failed", "failed", 1, {
					events: [event("finished", 2, { reason: "repair_cap" })],
				}),
				run("parked", "parked", 1, {
					events: [event("finished", 2, { reason: "landing_retries" })],
				}),
				run("stale", "failed", 3, {
					approvalCommit: SHA1_A,
					events: [event("finished", 4, { reason: "repair_cap" })],
				}),
				run("intr", "running", 10, {
					events: [event("interrupted", 11, { reason: "signal" })],
					ownerLiveness: "dead",
				}),
			],
		}),
	);
	expect(status.queue.queued.map((entry) => entry.slug)).toEqual([
		"high",
		"alpha",
		"bravo",
		"stale",
	]);
	expect(status.bySlug.get("high")?.status).toBe("queued");
	expect(status.bySlug.get("missing-dep")?.status).toBe("blocked");
	expect(status.bySlug.get("cycle-one")?.blocked?.reason).toBe(
		"dependency_cycle",
	);
	expect(status.bySlug.get("failed")?.status).toBe("failed");
	expect(status.bySlug.get("parked")?.status).toBe("parked");
	expect(status.bySlug.get("stale")?.status).toBe("queued");
	expect(status.bySlug.get("intr")?.status).toBe("interrupted");
	expect(status.bySlug.get("alpha")?.queuePosition).toBe(2);
});

test("Git trailer values reduce to latest landing per slug without reading working Intent bytes", () => {
	const rows = landingsFromReachableCommits([
		{ sha: SHA1_A, committedAt: 10, intentTrailers: ["greet"] },
		{ sha: SHA1_B, committedAt: 20, intentTrailers: ["greet", "not a slug"] },
		{ sha: SHA1_C, committedAt: 20, intentTrailers: ["other-task"] },
	]);
	expect(rows).toEqual([
		{ slug: "greet", sha: SHA1_B, committedAt: 20 },
		{ slug: "other-task", sha: SHA1_C, committedAt: 20 },
	]);
});

test("overview includes queue head, sections, aligned details, and only five landed rows", () => {
	const intents = [
		intent("queue-b", { approval: approval(SHA1_A, 1) }),
		intent("queue-cc", { approval: approval(SHA1_A, 2) }),
		intent("draft-a", { approval: null }),
		intent("failed-long", { approval: approval(SHA1_A, 3) }),
	];
	const histories = [
		"land-a",
		"land-b",
		"land-c",
		"land-d",
		"land-e",
		"land-f",
		"land-g",
	];
	for (const slug of histories) intents.push(intent(slug, { approval: null }));
	const failed = run("failed-long", "failed", 1, {
		runId: "f".repeat(32),
		events: [event("finished", 2, { status: "failed", reason: "repair_cap" })],
	});
	const inputValue = input({
		intents,
		reachableLandings: histories.map((slug, index) =>
			landing(slug, [SHA1_A, SHA1_B, SHA1_C][index % 3] ?? SHA1_A, index + 10),
		),
		runs: [failed],
	});
	const status = deriveStatus(inputValue);
	const rendered = renderStatusOverview(status);
	expect(rendered).toContain(
		"Queue: stopped, 2 waiting; start it with kogen queue start\n",
	);
	expect(rendered).toContain(
		"Next: queue-b (priority 0; no dependencies; ties by approval time and slug)\n",
	);
	expect(rendered).toContain(
		"Failed:\n  failed-long  repair_cap (Build ffffffff)\n",
	);
	expect(rendered).toContain("Landed (7):\n");
	expect(rendered).toContain("  and 2 earlier\n");
	expect(rendered.match(/^ {2}land-/gmu)?.length).toBe(5);
	expect(rendered).toContain("Drafts:\n  draft-a\n");
});

test("slug text omits legacy verdict and keeps the current Build summary", () => {
	const build = run("greet", "failed", 1, {
		runId: "d".repeat(32),
		journalPath: "/tmp/status/runs/dddddddddddddddddddddddddddddddd",
		events: [
			event("started", 1, {
				approved_by: "Kogen Test",
				base_sha: SHA1_B,
				budget_ms: 3_600_000,
			}),
			event("verification", 2, {
				result: "red",
				checks: [],
				acceptance: [{ id: "A1", status: "fail", demoted: false }],
			}),
			event("finished", 3, {
				status: "failed",
				reason: "repair_cap",
				verdict: "unverified",
			}),
		],
	});
	const inputValue = input({
		intents: [intent("greet", { approval: approval() })],
		runs: [build],
	});
	const status = deriveStatus(inputValue);
	const rendered = renderIntentStatus(status, inputValue, "greet");
	expect(rendered).toBe(
		"greet: failed, repair_cap\n" +
			"Build dddddddd: failed, repair_cap\n" +
			"  acceptance remaining: A1\n" +
			"  journal: /tmp/status/runs/dddddddddddddddddddddddddddddddd\n",
	);
	expect(rendered).not.toContain("verdict:");
});

test("JSON report emits every §2.10 key and explicit nulls without a Build", () => {
	const inputValue = input({
		intents: [intent("greet", { approval: approval() })],
	});
	const status = deriveStatus(inputValue);
	const jsonLine = renderStatusJsonLines(status, inputValue, "greet");
	if (jsonLine === null) throw new Error("Expected status report");
	const report = JSON.parse(jsonLine) as Record<string, unknown>;
	expect(Object.keys(report).sort()).toEqual(
		[
			"advisory_items",
			"approval",
			"approved_by",
			"audit",
			"acceptance",
			"base",
			"best_candidate",
			"blocks_on",
			"budget",
			"build_id",
			"cache_hit_rate",
			"candidate",
			"checks",
			"credential",
			"failures",
			"findings",
			"land_policy",
			"landed_sha",
			"journal",
			"model_stages",
			"priority",
			"rungs",
			"sandbox",
			"slug",
			"status",
			"verdict",
		]
			.filter((key) => key !== "agents")
			.sort(),
	);
	expect(report).toMatchObject({
		slug: "greet",
		status: "queued",
		build_id: null,
		journal: null,
		verdict: null,
		land_policy: null,
		advisory_items: [],
		approved_by: "Kogen Test <test@kogen.invalid>",
		candidate: null,
		landed_sha: null,
		cache_hit_rate: null,
		best_candidate: null,
		audit: [],
		acceptance: [],
		checks: [],
		model_stages: [],
		findings: [],
		failures: [],
		sandbox: null,
		budget: { budget_ms: null, used_ms: null, paused_ms: null },
	});
});

test("cache hit rate uses Build model stages and is null when usage is missing", () => {
	const tokens = {
		input: 6,
		cached_input: 3,
		cache_write: null,
		output: 8,
		reasoning: null,
	};
	const built = run("greet", "landed", 1, {
		events: [
			event("started", 1, {
				budget_ms: 10_000,
				base_sha: SHA1_B,
				land: "green",
			}),
			event("model_stage", 2, {
				stage: "develop",
				rung: "R1",
				model: "gpt-6-luna",
				effort: "max",
				tokens,
				wall_ms: 50,
			}),
			event("verification", 3, {
				result: "green",
				checks: [
					{ name: "unit", status: "green", excused: false, findings: [] },
				],
				acceptance: [{ id: "A1", status: "pass", demoted: false }],
			}),
		],
	});
	const inputValue = input({
		intents: [intent("greet", { approval: approval() })],
		runs: [built],
	});
	const reportLine = renderStatusJsonLines(
		deriveStatus(inputValue),
		inputValue,
		"greet",
	);
	if (reportLine === null) throw new Error("Expected report");
	const report = JSON.parse(reportLine) as {
		cache_hit_rate: number;
		rungs: { tokens: Record<string, number | null> }[];
	};
	expect(report.cache_hit_rate).toBe(1 / 3);
	expect(report.rungs[0]?.tokens).toEqual({
		input: 6,
		cached_input: 3,
		cache_write: null,
		output: 8,
		reasoning: null,
	});
	const missing = run("greet", "landed", 1, {
		events: [
			event("model_stage", 2, {
				stage: "develop",
				tokens: { input: null, cached_input: null },
			}),
		],
	});
	const missingInput = input({
		intents: [intent("greet", { approval: approval() })],
		runs: [missing],
	});
	const missingLine = renderStatusJsonLines(
		deriveStatus(missingInput),
		missingInput,
		"greet",
	);
	if (missingLine === null) throw new Error("Expected report");
	expect(
		(JSON.parse(missingLine) as { cache_hit_rate: unknown }).cache_hit_rate,
	).toBeNull();
});

test("watch streams changed frames only, with a blank line between frames and idle exit", async () => {
	const build = run("greet", "running", 1, {
		runId: "e".repeat(32),
		events: [event("rung_started", 1, { rung: "R1", model: "gpt-6-luna" })],
	});
	const liveInput = input({
		intents: [intent("greet", { approval: approval() })],
		runs: [build],
		claimRunId: build.record.run_id,
		queuePid: 20,
	});
	const landedInput = input({
		intents: [intent("greet", { approval: approval() })],
		reachableLandings: [landing("greet", SHA1_C, 5)],
		nowMs: 3,
	});
	const snapshots: StatusWatchSnapshot[] = [
		{ input: liveInput, status: deriveStatus(liveInput) },
		{ input: liveInput, status: deriveStatus(liveInput) },
		{ input: landedInput, status: deriveStatus(landedInput) },
	];
	const writes: string[] = [];
	let reads = 0;
	let waits = 0;
	const result = await watchStatus({
		source: {
			async read() {
				const current = snapshots[reads];
				reads += 1;
				if (current === undefined) throw new Error("No watch snapshot remains");
				return current;
			},
			async wait(milliseconds) {
				waits += 1;
				expect(milliseconds).toBe(100);
			},
		},
		write(chunk) {
			writes.push(chunk);
		},
		timeScale: 0.02,
	});
	expect(result).toEqual({ exitCode: 0, frames: 2 });
	expect(waits).toBe(2);
	expect(writes[0]).toContain("Building:");
	expect(writes[1]).toStartWith("\nQueue: stopped\n");
	expect(writes[1]).toContain("Landed (1):");
});

test("watch exits one when an idle slug has not landed and keeps one unchanged frame", async () => {
	const draftInput = input({ intents: [intent("draft", { approval: null })] });
	const snapshot = { input: draftInput, status: deriveStatus(draftInput) };
	const writes: string[] = [];
	const result = await watchStatus({
		source: {
			async read() {
				return snapshot;
			},
			async wait() {
				throw new Error("Idle watch must return without polling");
			},
		},
		write(chunk) {
			writes.push(chunk);
		},
		slug: "draft",
	});
	expect(result).toEqual({ exitCode: 1, frames: 1 });
	expect(writes).toEqual([
		"draft: draft; review it with kogen intent approve draft\n",
	]);
});

test("50 Intents and 200 runs derive within the one-second status target", () => {
	const intents: StatusIntent[] = [];
	const runs: StatusRun[] = [];
	for (let index = 0; index < 50; index += 1) {
		const slug = `perf-${String(index).padStart(2, "0")}`;
		const approvalCommit = index.toString(16).padStart(40, "0");
		intents.push(intent(slug, { approval: approval(approvalCommit, index) }));
	}
	for (let index = 0; index < 200; index += 1) {
		const intentIndex = index % 50;
		const slug = `perf-${String(intentIndex).padStart(2, "0")}`;
		const approvalCommit = intentIndex.toString(16).padStart(40, "0");
		const runId = (index + 1).toString(16).padStart(32, "0");
		runs.push(
			run(slug, "failed", 1_700_000_000_000 + index, {
				runId,
				approvalCommit,
				events: [
					event("started", 1_700_000_000_000 + index),
					event("finished", 1_700_000_000_001 + index, {
						reason: "repair_cap",
					}),
				],
			}),
		);
	}
	const snapshot = input({ intents, runs });
	const startedAt = performance.now();
	const derived = deriveStatus(snapshot);
	const duration = performance.now() - startedAt;
	expect(derived.intents).toHaveLength(50);
	expect(duration).toBeLessThan(1_000);
});

test("JSON overview emits one row per Intent in slug order and agent rows afterward", () => {
	const agents: StatusAgent[] = [
		{
			id: "f".repeat(32),
			role: "builder",
			buildId: "e".repeat(32),
			status: "running",
			startedMs: 1_700_000_000_000,
			activity: "editing",
			eventsPath: "/tmp/agents/events.jsonl",
		},
	];
	const snapshot = input({
		intents: [intent("bravo"), intent("alpha")],
		agents,
	});
	const lines = renderStatusJsonLines(deriveStatus(snapshot), snapshot)
		?.trim()
		.split("\n");
	expect(lines).toHaveLength(3);
	expect(JSON.parse(lines?.[0] ?? "{}")).toMatchObject({
		slug: "alpha",
		status: "queued",
	});
	expect(JSON.parse(lines?.[1] ?? "{}")).toMatchObject({
		slug: "bravo",
		status: "queued",
	});
	expect(JSON.parse(lines?.[2] ?? "{}")).toMatchObject({
		type: "agent",
		id: "f".repeat(32),
		elapsed_ms: 10_000,
	});
});

test("watch timing scale keeps the specified 100ms floor", () => {
	expect(statusWatchPollMilliseconds()).toBe(2_000);
	expect(statusWatchPollMilliseconds(0.02)).toBe(100);
	expect(statusWatchPollMilliseconds(2)).toBe(4_000);
});
