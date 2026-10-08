import { expect, test } from "bun:test";
import {
	runSerialLadder,
	type SerialLadderEffects,
} from "../../packages/core/src/build/attempts";
import type {
	BuildCandidate,
	BuildEffectFailure,
} from "../../packages/core/src/build/controller";
import {
	createLadderPlan,
	parseLadderOptions,
} from "../../packages/core/src/build/ladder";
import type { LoadedBuildApproval } from "../../packages/core/src/build/load";
import type { BuildPlan } from "../../packages/core/src/build/planner";
import { BUILD_RUNG_REPAIR_LIMIT } from "../../packages/core/src/build/repair";
import { resolveRoles } from "../../packages/core/src/project/roles";
import type { JsonValue } from "../../packages/core/src/run/journal";

const encoder = new TextEncoder();
const roleResolution = resolveRoles({ provider: "chatgpt" });
if (!roleResolution.ok) throw new Error("ChatGPT roles should resolve.");
const roles = roleResolution.value;
const baseCommit = "a".repeat(40);
const base = {
	commit: baseCommit,
	tree: "b".repeat(40),
	trackedPaths: ["src/index.ts"],
};

function approval(): LoadedBuildApproval {
	const intentBytes = encoder.encode("---\ntitle: Demo\n---\nDo the work.\n");
	return {
		slug: "demo",
		approvalCommit: "c".repeat(40),
		approvalSha256: "d".repeat(64),
		intentSha256: "e".repeat(64),
		targetBranch: "main",
		baseSha: baseCommit,
		intentPath: ".kogen/intents/demo/intent.md",
		acceptancePath: "test/acceptance/demo.t.sh",
		intentBytes,
		acceptanceBytes: encoder.encode("acceptance fixture\n"),
		metadata: {},
	};
}

function buildPlan(difficulty: "easy" | "hard" = "easy"): BuildPlan {
	return {
		difficulty,
		text: "Implementation plan:\nAdd the requested feature.",
		wordCount: 5,
		trackedPaths: ["src/index.ts"],
		role: roles.roles.planner,
	};
}

function ladder(experimental = false) {
	const parsed = parseLadderOptions(
		experimental ? { experimental_r4: true } : undefined,
	);
	if (!parsed.ok) throw new Error("Test ladder options should resolve.");
	const value = createLadderPlan({
		recipe: "ladder",
		roles,
		options: parsed.value,
	});
	if (value === null) throw new Error("Ladder recipe should resolve.");
	return value;
}

function candidate(
	input: Parameters<SerialLadderEffects["run"]>[0],
	verdict: BuildCandidate["verdict"],
): BuildCandidate {
	return {
		rung: input.attempt.rung,
		workspace: input.workspace,
		verifiedTree: `${input.attempt.ordinal}`.padStart(40, "0"),
		verdict,
	};
}

function effectFailure(code: string, message: string): BuildEffectFailure {
	return { code, message, exitCode: 3 };
}

function effectsFor(input: {
	readonly outcomes: readonly ("red" | "green")[];
	readonly received?: Parameters<SerialLadderEffects["run"]>[0][];
	readonly roots?: string[];
}): SerialLadderEffects {
	let rungIndex = 0;
	return {
		async createWorkspace({ attempt }) {
			const id = `workspace-${attempt.ordinal}`;
			input.roots?.push(`/scratch/${id}`);
			return { ok: true, value: { id, root: `/scratch/${id}` } };
		},
		async setup() {
			return { ok: true, value: undefined };
		},
		async run(runInput) {
			input.received?.push(runInput);
			const kind = input.outcomes[rungIndex] ?? "red";
			rungIndex += 1;
			const result = {
				kind,
				reason: kind === "green" ? "green" : "no_progress",
				candidate: candidate(runInput, kind),
			} as const;
			return {
				ok: true,
				value: {
					outcome: result,
					failureLines: [
						"old line",
						"line 2",
						"line 3",
						"line 4",
						"x".repeat(200),
						"last useful line",
					],
				},
			};
		},
	};
}

function runRequest(input: {
	readonly ladder: ReturnType<typeof ladder>;
	readonly effects: SerialLadderEffects;
	readonly remaining: () => number;
	readonly plan?: BuildPlan;
	readonly events?: {
		name: string;
		fields: Readonly<Record<string, JsonValue>>;
	}[];
}) {
	return runSerialLadder({
		runId: "f".repeat(32),
		approval: approval(),
		base,
		plan: input.plan ?? buildPlan(),
		baseAcceptance: {
			items: [
				{
					id: "A1",
					kind: "test",
					status: "failed",
					output: ["base failure"],
				},
			],
		},
		roles,
		ladder: input.ladder,
		effects: input.effects,
		remainingBuildBudgetMilliseconds: input.remaining,
		async emit(name, fields = {}) {
			input.events?.push({ name, fields });
		},
	});
}

test("serial attempts use a new workspace, the shared plan, and six repairs each", async () => {
	const received: Parameters<SerialLadderEffects["run"]>[0][] = [];
	const roots: string[] = [];
	const events: {
		name: string;
		fields: Readonly<Record<string, JsonValue>>;
	}[] = [];
	const result = await runRequest({
		ladder: ladder(),
		effects: effectsFor({
			outcomes: ["red", "red", "green"],
			received,
			roots,
		}),
		remaining: () => 3_600_000,
		events,
	});

	expect(result.kind).toBe("green");
	if (result.kind !== "green") throw new Error("Third rung should win.");
	expect(result.attempts.map((entry) => entry.attempt.rung)).toEqual([
		"R1",
		"R2",
		"R3",
	]);
	expect(new Set(roots).size).toBe(3);
	expect(received.map((entry) => entry.workspace.root)).toEqual(roots);
	expect(received.map((entry) => entry.plan?.text)).toEqual([
		buildPlan().text,
		buildPlan().text,
		buildPlan().text,
	]);
	expect(received.map((entry) => entry.earlierAttempts.length)).toEqual([
		0, 1, 2,
	]);
	expect(received.map((entry) => entry.repairsLeft)).toEqual([
		BUILD_RUNG_REPAIR_LIMIT,
		BUILD_RUNG_REPAIR_LIMIT,
		BUILD_RUNG_REPAIR_LIMIT,
	]);
	expect(received[1]?.earlierAttempts[0]?.reason).toBe("no_progress");
	expect(received[2]?.earlierAttempts[1]?.rung).toBe("R2");
	expect(received[1]?.base).toBe(base);
	expect(
		events
			.filter((entry) => entry.name === "rung_started")
			.map((entry) => entry.fields.wall_ms),
	).toEqual([1_800_000, 1_800_000, 1_800_000]);
});

test("R4 omits the shared plan, repeat summaries persist, and the wall stops repeats", async () => {
	const received: Parameters<SerialLadderEffects["run"]>[0][] = [];
	const roots: string[] = [];
	const remaining = [900_000, 700_000, 500_000, 300_000, 120_000, 0];
	const result = await runRequest({
		ladder: ladder(true),
		effects: effectsFor({ outcomes: [], received, roots }),
		remaining: () => remaining.shift() ?? 0,
	});

	expect(result.kind).toBe("budget");
	if (result.kind !== "budget") throw new Error("Budget should stop repeats.");
	expect(result.attempts.map((entry) => entry.attempt.name)).toEqual([
		"builder",
		"sol-medium",
		"sol-high",
		"raw-request",
		"sol-high-2",
	]);
	expect(received.map((entry) => entry.plan === null)).toEqual([
		false,
		false,
		false,
		true,
		false,
	]);
	expect(received.map((entry) => entry.earlierAttempts.length)).toEqual([
		0, 1, 2, 3, 4,
	]);
	expect(new Set(roots).size).toBe(5);
	expect(received.every((entry) => entry.repairsLeft === 6)).toBe(true);
	expect(received[4]?.earlierAttempts[3]?.rung).toBe("R4");
	expect(received[4]?.earlierAttempts[3]?.failures).toEqual([
		"line 2",
		"line 3",
		"line 4",
		"x".repeat(180),
		"last useful line",
	]);
});

test("setup retries once in the same fresh workspace then stops on a second failure", async () => {
	let created = 0;
	let setupCalls = 0;
	const effects: SerialLadderEffects = {
		async createWorkspace() {
			created += 1;
			return { ok: true, value: { id: "only", root: "/scratch/only" } };
		},
		async setup() {
			setupCalls += 1;
			return {
				ok: false,
				error: effectFailure("setup/red", "setup command failed"),
			};
		},
		async run() {
			throw new Error("Builder must not start after setup fails twice.");
		},
	};
	const result = await runRequest({
		ladder: ladder(),
		effects,
		remaining: () => 1_000_000,
	});

	expect(result.kind).toBe("stopped");
	if (result.kind !== "stopped") throw new Error("Setup failure should stop.");
	expect(result.failure.code).toBe("environment/setup_failed");
	expect(created).toBe(1);
	expect(setupCalls).toBe(2);
});

test("a repeated workspace identity is refused before another builder starts", async () => {
	let runCount = 0;
	const effects: SerialLadderEffects = {
		async createWorkspace() {
			return {
				ok: true,
				value: { id: "workspace-1", root: "/scratch/same" },
			};
		},
		async setup() {
			return { ok: true, value: undefined };
		},
		async run(input) {
			runCount += 1;
			return {
				ok: true,
				value: {
					outcome: {
						kind: "red",
						reason: "no_progress",
						candidate: candidate(input, "red"),
					},
					failureLines: [],
				},
			};
		},
	};
	const result = await runRequest({
		ladder: ladder(),
		effects,
		remaining: () => 1_000_000,
	});

	expect(result.kind).toBe("stopped");
	if (result.kind !== "stopped")
		throw new Error("Workspace reuse should stop.");
	expect(result.failure.code).toBe("controller/ladder_workspace_reused");
	expect(runCount).toBe(1);
});

test("provider budget and missing green candidates do not create a false winner", async () => {
	const noBudget = await runRequest({
		ladder: ladder(),
		effects: effectsFor({ outcomes: [] }),
		remaining: () => 0,
	});
	expect(noBudget.kind).toBe("budget");
	if (noBudget.kind === "budget") expect(noBudget.attempts).toHaveLength(0);

	const malformed: SerialLadderEffects = {
		...effectsFor({ outcomes: [] }),
		async run() {
			return {
				ok: true,
				value: {
					outcome: { kind: "green", reason: "green", candidate: null },
					failureLines: [],
				},
			};
		},
	};
	const invalid = await runRequest({
		ladder: ladder(),
		effects: malformed,
		remaining: () => 1_000_000,
	});
	expect(invalid.kind).toBe("stopped");
	if (invalid.kind === "stopped")
		expect(invalid.failure.code).toBe("controller/ladder_input_invalid");
});

test("hard plans require parallel policy unless max_rungs admits only R1", async () => {
	const received: Parameters<SerialLadderEffects["run"]>[0][] = [];
	const singleRungOptions = parseLadderOptions({ max_rungs: 1 });
	if (!singleRungOptions.ok)
		throw new Error("Single-rung options should parse.");
	const singleRungPlan = createLadderPlan({
		recipe: "ladder",
		roles,
		options: singleRungOptions.value,
	});
	if (singleRungPlan === null) throw new Error("Ladder should resolve.");
	const hardSingle = await runRequest({
		ladder: singleRungPlan,
		plan: buildPlan("hard"),
		effects: effectsFor({ outcomes: ["green"], received }),
		remaining: () => 1_000_000,
	});
	expect(hardSingle.kind).toBe("green");
	expect(received).toHaveLength(1);

	const hardMultiple = await runRequest({
		ladder: ladder(),
		plan: buildPlan("hard"),
		effects: effectsFor({ outcomes: ["green"], received }),
		remaining: () => 1_000_000,
	});
	expect(hardMultiple.kind).toBe("stopped");
	if (hardMultiple.kind !== "stopped")
		throw new Error("Hard multi-rung schedule must use parallel policy.");
	expect(hardMultiple.failure.code).toBe("controller/parallel_ladder_required");
	expect(received).toHaveLength(1);
});
