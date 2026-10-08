import { expect, test } from "bun:test";
import { BuildBudget } from "../../packages/core/src/build/budget";
import type {
	BuildCandidate,
	RungWorkspace,
} from "../../packages/core/src/build/controller";
import { createSerializedRunStateWriter } from "../../packages/core/src/build/controller";
import {
	createLadderPlan,
	parseLadderOptions,
} from "../../packages/core/src/build/ladder";
import type { LoadedBuildApproval } from "../../packages/core/src/build/load";
import {
	type ParallelLadderEffects,
	type ParallelLadderRequest,
	type ParallelLadderRunInput,
	runParallelHardRungs,
} from "../../packages/core/src/build/parallel";
import type { BuildPlan } from "../../packages/core/src/build/planner";
import { BUILD_RUNG_REPAIR_LIMIT } from "../../packages/core/src/build/repair";
import { resolveRoles } from "../../packages/core/src/project/roles";
import {
	applyRunEventToRecord,
	createJournalEvent,
	type RunRecord,
} from "../../packages/core/src/run/store";

const rolesResult = resolveRoles({ provider: "chatgpt" });
if (!rolesResult.ok) throw new Error("ChatGPT roles should resolve.");
const roles = rolesResult.value;
const base = {
	commit: "a".repeat(40),
	tree: "b".repeat(40),
	trackedPaths: ["src/index.ts"],
};
const approval: LoadedBuildApproval = {
	slug: "parallel",
	approvalCommit: "c".repeat(40),
	approvalSha256: "d".repeat(64),
	intentSha256: "e".repeat(64),
	targetBranch: "main",
	baseSha: base.commit,
	intentPath: ".kogen/intents/parallel/intent.md",
	acceptancePath: "test/acceptance/parallel.t.sh",
	intentBytes: new TextEncoder().encode(
		"---\ntitle: Parallel\n---\nDo work.\n",
	),
	acceptanceBytes: new TextEncoder().encode("acceptance fixture\n"),
	metadata: {},
};
const plan: BuildPlan = {
	difficulty: "hard",
	text: "Implementation plan:\nBuild independently in each worktree.",
	wordCount: 6,
	trackedPaths: ["src/index.ts"],
	role: roles.roles.planner,
};
const optionsResult = parseLadderOptions();
if (!optionsResult.ok)
	throw new Error("Default ladder options should resolve.");
const ladder = (() => {
	const result = createLadderPlan({
		recipe: "ladder",
		roles,
		options: optionsResult.value,
	});
	if (result === null) throw new Error("Default ladder should resolve.");
	return result;
})();

class FakeClock {
	now = 0;
	private readonly sleepers: {
		readonly at: number;
		readonly resolve: () => void;
		readonly reject: (cause: Error) => void;
		readonly signal: AbortSignal;
		readonly onAbort: () => void;
	}[] = [];
	monotonicMilliseconds = (): number => this.now;
	sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
		new Promise((resolve, reject) => {
			const onAbort = (): void => reject(new Error("sleep aborted"));
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.sleepers.push({
				at: this.now + milliseconds,
				resolve,
				reject,
				signal: signal as AbortSignal,
				onAbort,
			});
		});

	advance(milliseconds: number): void {
		this.now += milliseconds;
		for (const sleeper of [...this.sleepers]) {
			if (sleeper.at > this.now) continue;
			this.sleepers.splice(this.sleepers.indexOf(sleeper), 1);
			sleeper.signal?.removeEventListener("abort", sleeper.onAbort);
			sleeper.resolve();
		}
	}
}

function candidate(
	input: Pick<ParallelLadderRunInput, "attempt" | "workspace">,
	verdict: BuildCandidate["verdict"],
): BuildCandidate {
	return {
		rung: input.attempt.rung,
		workspace: input.workspace,
		verifiedTree: input.attempt.ordinal.toString().padStart(40, "0"),
		verdict,
	};
}

function request(
	clock: FakeClock,
	budgetMilliseconds = 1_000,
	effects: ParallelLadderEffects,
	events: string[] = [],
): ParallelLadderRequest {
	return {
		runId: "f".repeat(32),
		approval,
		base,
		plan,
		baseAcceptance: { items: [] },
		roles,
		ladder,
		budget: new BuildBudget(budgetMilliseconds, clock),
		effects,
		async emit(name, fields = {}) {
			const rung = typeof fields.rung === "string" ? fields.rung : "";
			events.push(rung.length === 0 ? name : `${name}:${rung}`);
		},
	};
}

function baseEffects(
	run: ParallelLadderEffects["run"],
	options: {
		readonly stopMember?: ParallelLadderEffects["stopMember"];
		readonly snapshotFinal?: ParallelLadderEffects["snapshotFinal"];
		readonly cleanupWorkspace?: ParallelLadderEffects["cleanupWorkspace"];
		readonly onCreate?: (workspace: RungWorkspace) => void;
	} = {},
): ParallelLadderEffects {
	return {
		async createWorkspace({ attempt }) {
			const workspace = {
				id: `workspace-${attempt.rung}`,
				root: `/scratch/${attempt.rung}`,
			};
			options.onCreate?.(workspace);
			return { ok: true, value: workspace };
		},
		async setup() {
			return { ok: true, value: undefined };
		},
		run,
		async stopMember(input) {
			return options.stopMember === undefined
				? { ok: true, value: undefined }
				: options.stopMember(input);
		},
		async snapshotFinal(input) {
			return options.snapshotFinal === undefined
				? { ok: true, value: candidate(input, "red") }
				: options.snapshotFinal(input);
		},
		async cleanupWorkspace(input) {
			return options.cleanupWorkspace === undefined
				? { ok: true, value: undefined }
				: options.cleanupWorkspace(input);
		},
	};
}

function outcome(input: ParallelLadderRunInput, kind: "green" | "red") {
	return {
		ok: true as const,
		value: {
			outcome: {
				kind,
				reason: kind === "green" ? "green" : "no_progress",
				candidate: candidate(input, kind),
			},
			failureLines: [],
		},
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

test("BuildBudget subtracts overlapping provider pauses once from active time", () => {
	const clock = new FakeClock();
	const budget = new BuildBudget(100, clock);
	clock.advance(40);
	const releaseOne = budget.pause();
	clock.advance(50);
	const releaseTwo = budget.pause();
	clock.advance(50);
	releaseOne();
	clock.advance(50);
	releaseTwo();
	releaseTwo();
	expect(budget.snapshot()).toEqual({
		budgetMilliseconds: 100,
		elapsedMilliseconds: 190,
		usedMilliseconds: 40,
		pausedMilliseconds: 150,
		remainingMilliseconds: 60,
		pauseDepth: 0,
	});
	clock.advance(60);
	expect(budget.remainingMilliseconds()).toBe(0);
	expect(budget.activeMonotonicMilliseconds()).toBe(100);
});

test("hard rungs overlap behind a barrier and a green winner stops, snapshots, then cleans the loser", async () => {
	const clock = new FakeClock();
	const bothEntered = deferred();
	const cancelR1 = deferred();
	const active = new Set<string>();
	const overlap = { maximum: 0 };
	const order: string[] = [];
	const events: string[] = [];
	const conversations = new Map<string, string>();
	const effects = baseEffects(
		async (input) => {
			active.add(input.attempt.rung);
			overlap.maximum = Math.max(overlap.maximum, active.size);
			conversations.set(input.workspace.id, `thread-${input.attempt.rung}`);
			if (active.size === 2) bothEntered.resolve();
			await bothEntered.promise;
			if (input.attempt.rung === "R1") {
				await new Promise<void>((resolve) => {
					input.signal.addEventListener(
						"abort",
						() => {
							order.push("R1:aborted");
							cancelR1.resolve();
							resolve();
						},
						{ once: true },
					);
				});
				active.delete("R1");
				order.push("R1:stopped");
				return outcome(input, "red");
			}
			active.delete("R2");
			order.push("R2:green");
			return outcome(input, "green");
		},
		{
			async stopMember({ attempt }) {
				order.push(`${attempt.rung}:stop`);
				await cancelR1.promise;
				return { ok: true, value: undefined };
			},
			async snapshotFinal({ attempt, workspace }) {
				order.push(`${attempt.rung}:snapshot`);
				return {
					ok: true,
					value: {
						rung: attempt.rung,
						workspace,
						verifiedTree: "9".repeat(40),
						verdict: "red",
					},
				};
			},
			async cleanupWorkspace({ workspace }) {
				order.push(`${workspace.id}:cleanup`);
				return { ok: true, value: undefined };
			},
		},
	);
	const result = await runParallelHardRungs(
		request(clock, 1_000, effects, events),
	);
	expect(result.kind).toBe("green");
	if (result.kind !== "green")
		throw new Error("Expected a green hard-rung winner.");
	expect(overlap.maximum).toBe(2);
	expect(new Set(conversations.values()).size).toBe(2);
	expect(result.winner.rung).toBe("R2");
	expect(result.attempts.map((attempt) => attempt.attempt.rung)).toEqual([
		"R1",
		"R2",
	]);
	expect(result.attempts[0]?.outcome.reason).toBe(
		"cancelled_after_parallel_winner",
	);
	expect(order.indexOf("R1:stopped")).toBeLessThan(
		order.indexOf("R1:snapshot"),
	);
	expect(order.indexOf("R1:snapshot")).toBeLessThan(
		order.indexOf("workspace-R1:cleanup"),
	);
	expect(events.filter((event) => event.startsWith("rung_started:"))).toEqual([
		"rung_started:R1",
		"rung_started:R2",
	]);
});

test("simultaneous green completions tie-break by rung ordinal", async () => {
	const clock = new FakeClock();
	const bothEntered = deferred();
	let entered = 0;
	let stopped = 0;
	const effects = baseEffects(
		async (input) => {
			entered += 1;
			if (entered === 2) bothEntered.resolve();
			await bothEntered.promise;
			return outcome(input, "green");
		},
		{
			async stopMember() {
				stopped += 1;
				return { ok: true, value: undefined };
			},
		},
	);
	const result = await runParallelHardRungs(request(clock, 1_000, effects));
	if (result.kind !== "green")
		throw new Error("Expected a green hard-rung winner.");
	expect(entered).toBe(2);
	expect(result.winner.rung).toBe("R1");
	expect(result.candidates.map((item) => item.rung)).toEqual(["R1", "R2"]);
	expect(stopped).toBe(0);
});

test("budget cancellation snapshots each stopped member and keeps the workspaces", async () => {
	const clock = new FakeClock();
	const bothEntered = deferred();
	const releases = new Map<string, () => void>();
	let entered = 0;
	const snapshots: string[] = [];
	const stopCalls: string[] = [];
	const effects = baseEffects(
		async (input) => {
			entered += 1;
			if (entered === 2) bothEntered.resolve();
			await bothEntered.promise;
			await new Promise<void>((resolve) => {
				releases.set(input.attempt.rung, resolve);
				input.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return outcome(input, "red");
		},
		{
			async stopMember({ attempt, reason }) {
				stopCalls.push(`${attempt.rung}:${reason}`);
				releases.get(attempt.rung)?.();
				return { ok: true, value: undefined };
			},
			async snapshotFinal({ attempt, workspace }) {
				snapshots.push(attempt.rung);
				return {
					ok: true,
					value: {
						rung: attempt.rung,
						workspace,
						verifiedTree: "8".repeat(40),
						verdict: "red",
					},
				};
			},
		},
	);
	const run = runParallelHardRungs(request(clock, 10, effects));
	await bothEntered.promise;
	clock.advance(10);
	const result = await run;
	expect(result.kind).toBe("budget");
	expect(stopCalls).toEqual(["R1:budget", "R2:budget"]);
	expect(snapshots).toEqual(["R1", "R2"]);
	if (result.kind !== "budget") throw new Error("Expected budget exhaustion.");
	expect(result.candidates.map((item) => item.verifiedTree)).toEqual([
		"8".repeat(40),
		"8".repeat(40),
	]);
});

test("parallel members receive independent plan, repair allowance, wall, budget, and cancellation signal", async () => {
	const clock = new FakeClock();
	const received: ParallelLadderRunInput[] = [];
	const bothEntered = deferred();
	const effects = baseEffects(async (input) => {
		received.push(input);
		if (received.length === 2) bothEntered.resolve();
		await bothEntered.promise;
		return outcome(input, input.attempt.rung === "R1" ? "green" : "red");
	});
	const result = await runParallelHardRungs(request(clock, 1_000, effects));
	expect(result.kind).toBe("green");
	expect(received.map((input) => input.attempt.rung).sort()).toEqual([
		"R1",
		"R2",
	]);
	expect(received.every((input) => input.plan === plan)).toBe(true);
	expect(received.every((input) => input.earlierAttempts.length === 0)).toBe(
		true,
	);
	expect(
		received.every((input) => input.repairsLeft === BUILD_RUNG_REPAIR_LIMIT),
	).toBe(true);
	expect(received.every((input) => input.wallMilliseconds === 1_000)).toBe(
		true,
	);
	expect(received.every((input) => input.signal instanceof AbortSignal)).toBe(
		true,
	);
});

test("barrier-interleaved rung events preserve both run snapshots through the shared writer", async () => {
	const clock = new FakeClock();
	const bothEntered = deferred();
	const firstAppendStarted = deferred();
	const releaseFirstAppend = deferred();
	let entered = 0;
	const initial: RunRecord = {
		schema: 2,
		run_id: "f".repeat(32),
		slug: "parallel",
		approval_sha256: "d".repeat(64),
		approval_commit: "c".repeat(40),
		target_branch: "main",
		status: "running",
		landing: null,
		owner_pid: 1,
		owner_started_ms: 1,
		started_ms: 1,
		recovery: [],
		cleanup_pending: false,
	};
	const observed: RunRecord[] = [];
	const writer = createSerializedRunStateWriter(
		initial,
		async (current, event) => {
			observed.push(current);
			if (event.event === "cleanup_failure") {
				firstAppendStarted.resolve();
				await releaseFirstAppend.promise;
			}
			const record = applyRunEventToRecord(current, event);
			return { ok: true as const, value: { record, event } };
		},
	);
	const initialRequest = request(
		clock,
		1_000,
		baseEffects(async (input) => {
			entered += 1;
			if (entered === 2) bothEntered.resolve();
			await bothEntered.promise;
			await input.emit("parallel_member", { rung: input.attempt.rung });
			return outcome(input, "red");
		}),
	);
	const parallelRequest: ParallelLadderRequest = {
		...initialRequest,
		async emit(event, fields = {}) {
			if (event === "parallel_member") {
				const journalEvent =
					fields.rung === "R1"
						? createJournalEvent(
								"cleanup_failure",
								{ message: "snapshot pending" },
								() => 10,
							)
						: createJournalEvent("finished", { status: "stopped" }, () => 11);
				const saved = await writer.append(journalEvent);
				if (!saved.ok) throw new Error("Parallel event append failed.");
				return;
			}
			await initialRequest.emit(event, fields);
		},
	};
	const run = runParallelHardRungs(parallelRequest);
	await bothEntered.promise;
	await firstAppendStarted.promise;
	expect(observed).toHaveLength(1);
	expect(writer.current()).toMatchObject({
		cleanup_pending: false,
		status: "running",
	});
	releaseFirstAppend.resolve();
	const result = await run;
	expect(result.kind).toBe("red");
	expect(observed).toHaveLength(2);
	expect(observed[1]).toMatchObject({ cleanup_pending: true });
	expect(writer.current()).toMatchObject({
		cleanup_pending: true,
		status: "stopped",
	});
});
