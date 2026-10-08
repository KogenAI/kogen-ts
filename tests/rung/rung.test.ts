import { expect, test } from "bun:test";
import type { BuildCandidate } from "../../packages/core/src/build/controller";
import {
	BUILD_RUNG_TURN_BUDGET_NOTE,
	BUILD_RUNG_TURN_NOTE_AT,
	type BuildDeveloperTurn,
	buildFirstUserMessage,
	createBuilderSession,
} from "../../packages/core/src/build/develop";
import type { LoadedBuildApproval } from "../../packages/core/src/build/load";
import type { BuildPlan } from "../../packages/core/src/build/planner";
import {
	decideRepair,
	initialRepairProgress,
} from "../../packages/core/src/build/repair";
import type { BuildRungMachineRequest } from "../../packages/core/src/build/rung";
import { runRungMachine } from "../../packages/core/src/build/rung";
import type { GateVerificationResult } from "../../packages/core/src/gate/verify";
import { resolveRoles } from "../../packages/core/src/project/roles";
import type { SessionState } from "../../packages/core/src/provider/session/transition";
import type {
	AssembledResponse,
	ResponseToolCall,
} from "../../packages/core/src/provider/sse/assemble";

const encoder = new TextEncoder();
const baseCommit = "a".repeat(40);
const rolesResult = resolveRoles({ provider: "chatgpt" });
if (!rolesResult.ok) throw new Error("Test roles should resolve.");
const roles = rolesResult.value;
let callIndex = 0;

function session(rung = "R1"): SessionState {
	return createBuilderSession({
		runDirectory: "/tmp/kogen-run-1",
		provider: "chatgpt",
		role: roles.roles.builder,
		authMode: "injected",
		recipe: "ladder",
		attempt: "builder",
		rung,
		promptVersion: "build-prompt-v1",
		adapterVersion: "responses-v1",
		intentBytes: encoder.encode("---\ntitle: Demo\n---\nDo work.\n"),
		acceptance: [
			{
				id: "A1",
				kind: "test",
				status: "failed",
				output: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"],
			},
		],
		plan: "Build the requested feature.",
		repairsLeft: 6,
	});
}

function approval(): LoadedBuildApproval {
	const intentBytes = encoder.encode("---\ntitle: Demo\n---\nDo work.\n");
	return {
		slug: "demo",
		approvalCommit: "b".repeat(40),
		approvalSha256: "c".repeat(64),
		intentSha256: "d".repeat(64),
		targetBranch: "main",
		baseSha: baseCommit,
		intentPath: ".kogen/intents/demo/intent.md",
		acceptancePath: "test/acceptance/demo.t.sh",
		intentBytes,
		acceptanceBytes: encoder.encode("acceptance test bytes\n"),
		metadata: {},
	};
}

function plan(): BuildPlan {
	return {
		difficulty: "easy",
		text: "Implementation plan:\nBuild the requested feature.",
		wordCount: 5,
		trackedPaths: ["src/index.ts"],
		role: roles.roles.planner,
	};
}

function toolResponse(call: ResponseToolCall): AssembledResponse {
	const raw = {
		type: "function_call",
		id: `fc_${call.id}`,
		call_id: call.id,
		name: call.name,
		arguments: JSON.stringify(call.arguments),
		status: "completed",
	};
	return {
		ok: true,
		id: `response_${call.id}`,
		text: "",
		tool_calls: [call],
		usage: null,
		raw_items: [raw],
		raw_item_json: [JSON.stringify(raw)],
	};
}

function textResponse(text: string): AssembledResponse {
	const raw = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
		status: "completed",
	};
	return {
		ok: true,
		id: "response_text",
		text,
		tool_calls: [],
		usage: null,
		raw_items: [raw],
		raw_item_json: [JSON.stringify(raw)],
	};
}

function gateResult(
	status: "green" | "red",
	failureCount = 0,
): GateVerificationResult {
	const items = Array.from({ length: failureCount }, (_, index) => ({
		id: `A${index + 1}`,
		status: "fail" as const,
		rows: [],
	}));
	const ledger = {
		reportState: "valid" as const,
		rows: [],
		items,
		unknownTags: [],
		failures: [],
		treeBefore: "tree",
		treeAfter: "tree",
		exitStatus: status === "green" ? 0 : 1,
		timedOut: false,
	};
	const log = {
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		step: "acceptance",
		stdoutPath: "/tmp/run/gate.out",
		stderrPath: "/tmp/run/gate.err",
	};
	return {
		status,
		fixes: [],
		checks: [],
		acceptance: {
			ledger,
			items,
			failures: [],
			findings: [],
			log,
			exitStatus: ledger.exitStatus,
			timedOut: false,
		},
		findings: [],
		rawLogs: [],
		failureCount,
		counts: { errors: failureCount, warnings: 0, byTool: {} },
		findingsPath: "/tmp/run/gate-findings.json",
	};
}

function success<T>(value: T) {
	return { ok: true as const, value };
}

function baseRequest(input: {
	readonly turns: readonly BuildDeveloperTurn[];
	readonly verify: readonly GateVerificationResult[];
	readonly initialTree?: string;
	readonly onTurn?: (session: SessionState, turn: number) => void;
	readonly onRestore?: (count: number) => void;
	readonly onVerify?: () => void;
	readonly audit?: () => void;
	readonly restoreEveryBatch?: boolean;
	readonly turnLimit?: number;
	readonly wallMilliseconds?: number;
	readonly remainingBuildBudgetMilliseconds?: () => number;
}) {
	let treeIdentity = input.initialTree ?? "tree-base";
	let modelHead = "head-base";
	const clockState = { now: 0 };
	let restores = 0;
	const turns = [...input.turns];
	const verifications = [...input.verify];
	const requests: SessionState[] = [];
	const treeBases: string[] = [];
	const emitted: { event: string; fields?: Record<string, unknown> }[] = [];
	const request: BuildRungMachineRequest = {
		runId: "1".repeat(32),
		rung: "R1",
		workspace: { id: "ws-1", root: "/tmp/workspace" },
		approval: approval(),
		baseCommit,
		plan: plan(),
		roles,
		session: session(),
		developer: {
			async complete(inputValue: {
				session: SessionState;
				turn: number;
			}): Promise<BuildDeveloperTurn> {
				requests.push(inputValue.session);
				input.onTurn?.(inputValue.session, inputValue.turn);
				const next = turns.shift();
				if (next === undefined) throw new Error("No scripted developer turn.");
				return { ...next, session: inputValue.session } as BuildDeveloperTurn;
			},
		},
		tools: {
			authorizedTools: ["shell", "finish", "tool_output"],
			additionalHandlers: {
				shell: (args: Record<string, unknown>) => {
					if (args.cmd === "edit") treeIdentity = `tree-${turns.length}`;
					if (args.cmd === "commit") modelHead = `head-${turns.length}`;
					return "shell complete";
				},
				tool_output: () => "tool output",
			},
		},
		tree: {
			async snapshot(base: string) {
				treeBases.push(base);
				return success({ baseCommit: base, identity: treeIdentity });
			},
		},
		protection: {
			async restoreAfterToolBatch(previous: number) {
				restores += 1;
				input.onRestore?.(restores);
				if (restores === 1 || input.restoreEveryBatch === true) {
					const note =
						"You changed test/acceptance/demo.t.sh; acceptance tests and the Intent are read-only and have been restored. Make the implementation satisfy them.";
					return success({
						restoreCount: previous + 1,
						limitReached: previous + 1 >= 4,
						notes: [note],
						events: [{ path: "test/acceptance/demo.t.sh", note }],
					});
				}
				return success({
					restoreCount: previous,
					limitReached: previous >= 4,
					notes: [],
					events: [],
				});
			},
		},
		verification: {
			async verify(inputValue) {
				input.onVerify?.();
				expect(inputValue.baseCommit).toBe(baseCommit);
				const next = verifications.shift();
				if (next === undefined) throw new Error("No scripted verification.");
				return success(next);
			},
		},
		audit: {
			async advise() {
				input.audit?.();
				return success({
					items:
						input.audit === undefined
							? []
							: [
									{
										id: "A1",
										verdict: "over_strict" as const,
										reason: "advice only",
									},
								],
				});
			},
		},
		clock: {
			monotonicMilliseconds() {
				return clockState.now;
			},
		},
		remainingBuildBudgetMilliseconds:
			input.remainingBuildBudgetMilliseconds ?? (() => 10_000),
		...(input.turnLimit === undefined ? {} : { turnLimit: input.turnLimit }),
		...(input.wallMilliseconds === undefined
			? {}
			: { wallMilliseconds: input.wallMilliseconds }),
		emit: async (event: string, fields?: Readonly<Record<string, unknown>>) => {
			emitted.push({
				event,
				...(fields === undefined ? {} : { fields: { ...fields } }),
			});
		},
	};
	return {
		request,
		get treeIdentity() {
			return treeIdentity;
		},
		get modelHead() {
			return modelHead;
		},
		get requests() {
			return requests;
		},
		get treeBases() {
			return treeBases;
		},
		get emitted() {
			return emitted;
		},
		advanceClock(milliseconds: number) {
			clockState.now += milliseconds;
		},
	};
}

function completed(response: AssembledResponse): BuildDeveloperTurn {
	return { kind: "completed", response, session: session(), attempts: 1 };
}

function finishTurn(): BuildDeveloperTurn {
	callIndex += 1;
	return completed(
		toolResponse({ id: `call-${callIndex}`, name: "finish", arguments: {} }),
	);
}

function editTurn(command = "edit"): BuildDeveloperTurn {
	callIndex += 1;
	return completed(
		toolResponse({
			id: `call-${callIndex}`,
			name: "shell",
			arguments: { cmd: command },
		}),
	);
}

test("builder first message includes approved context and clips base output to five lines", () => {
	const message = buildFirstUserMessage({
		intentBytes: encoder.encode("approved intent"),
		acceptance: [
			{
				id: "A1",
				kind: "test",
				status: "failed",
				output: ["one", "two", "three", "four", "five", "six"],
			},
		],
		plan: "Plan text",
		repairsLeft: 6,
	});
	expect(message).toContain("Approved Intent:\napproved intent");
	expect(message).toContain("A1 (test): failed — one\ntwo\nthree\nfour\nfive");
	expect(message).not.toContain("six");
	expect(message).toEndWith(
		"Repairs available: 6. Begin work in the supplied worktree.",
	);
	expect(BUILD_RUNG_TURN_NOTE_AT).toBe(48);
	expect(BUILD_RUNG_TURN_BUDGET_NOTE).toContain("12 turns remain");
});

test("one conversation survives text progress, model commits, controller notes, and gate verification", async () => {
	const run = baseRequest({
		turns: [
			completed(textResponse("I am checking the workspace.")),
			editTurn("edit"),
			editTurn("commit"),
			finishTurn(),
		],
		verify: [gateResult("green")],
		onTurn: (current, turn) => {
			if (turn === 2) expect(current.threadId).toBe(session().threadId);
			if (turn === 3) {
				const history = current.history
					.itemBytes()
					.map((item) => new TextDecoder().decode(item));
				expect(history.join("\n")).toContain(
					"Continue the entire approved Intent",
				);
				expect(history.join("\n")).toContain("shell complete");
				expect(history.join("\n")).toContain(
					"You changed test/acceptance/demo.t.sh",
				);
			}
		},
	});
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("green");
	expect(outcome.candidate?.verifiedTree).toBe("tree-2");
	expect(run.modelHead).toBe("head-1");
	expect(run.treeBases.length).toBeGreaterThan(3);
	expect(run.treeBases.every((base) => base === baseCommit)).toBe(true);
	expect(run.requests).toHaveLength(4);
	expect(
		run.requests.every((value) => value.threadId === run.requests[0]?.threadId),
	).toBe(true);
	expect(
		run.emitted.some((value) => value.event === "protected_restored"),
	).toBe(true);
});

test("text is progress; first empty finish is refused and the second empty finish verifies", async () => {
	const outputs: string[] = [];
	const run = baseRequest({
		turns: [
			completed(textResponse("Still working.")),
			finishTurn(),
			finishTurn(),
		],
		verify: [gateResult("green")],
		onTurn: (current, turn) => {
			if (turn === 3) {
				const items = current.history
					.itemBytes()
					.map((item) => new TextDecoder().decode(item));
				outputs.push(items.join("\n"));
			}
		},
	});
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("green");
	expect(outputs[0]).toContain("Continue the entire approved Intent");
	expect(outputs[0]).toContain(
		"Kogen found no changed files. Make the requested change before claiming done.",
	);
	expect(run.requests).toHaveLength(3);
});

test("the turn-budget note is appended once after 48 completed turns", async () => {
	const turns = Array.from({ length: 48 }, () =>
		completed(textResponse("Progress.")),
	);
	turns.push(finishTurn(), finishTurn());
	let noteCountAtTurn49 = 0;
	const run = baseRequest({
		turns,
		verify: [gateResult("green")],
		onTurn: (current, turn) => {
			if (turn !== 49) return;
			const history = current.history
				.itemBytes()
				.map((item) => new TextDecoder().decode(item));
			noteCountAtTurn49 =
				history.join("\n").split(BUILD_RUNG_TURN_BUDGET_NOTE).length - 1;
		},
	});
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("green");
	expect(noteCountAtTurn49).toBe(1);
	expect(run.requests).toHaveLength(50);
});

test("six repairs are granted only while red counts strictly decrease", async () => {
	const turns: BuildDeveloperTurn[] = [];
	for (let i = 0; i < 7; i += 1) {
		turns.push(editTurn("edit"), finishTurn());
	}
	const verifications = [7, 6, 5, 4, 3, 2, 1].map((count) =>
		gateResult("red", count),
	);
	const run = baseRequest({ turns, verify: verifications });
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("red");
	expect(outcome.reason).toBe("repair_cap");
	expect(run.emitted.filter((value) => value.event === "repair")).toHaveLength(
		6,
	);
	expect(
		run.emitted.filter((value) => value.event === "verification"),
	).toHaveLength(6);
	expect(run.requests).toHaveLength(14);
	const red = gateResult("red", 4);
	expect(decideRepair(initialRepairProgress(), red).kind).toBe("repair");
	const unchanged = decideRepair(
		{ repairsUsed: 1, previousRedCount: 4, consecutiveRedWithoutCount: 0 },
		gateResult("red", 4),
	);
	expect(unchanged).toMatchObject({ kind: "end", reason: "no_progress" });
});

test("the fourth protected restore ends the rung and retains a base-relative snapshot", async () => {
	let verifyCalls = 0;
	const run = baseRequest({
		turns: [editTurn(), editTurn(), editTurn(), editTurn()],
		verify: [],
		restoreEveryBatch: true,
		onVerify: () => {
			verifyCalls += 1;
		},
	});
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("red");
	expect(outcome.reason).toBe("protected_restore_limit");
	expect(verifyCalls).toBe(0);
	expect(run.requests).toHaveLength(4);
	expect(run.treeBases.every((base) => base === baseCommit)).toBe(true);
	expect(outcome.candidate?.verifiedTree).toBe("tree-0");
});

test("a controller repair note does not reset the conversation and unchanged repair ends without another verify", async () => {
	let auditCalls = 0;
	let verified = 0;
	const run = baseRequest({
		turns: [finishTurn(), finishTurn(), finishTurn()],
		verify: [gateResult("red", 1)],
		audit: () => {
			auditCalls += 1;
		},
		onVerify: () => {
			verified += 1;
		},
		onTurn: (current, turn) => {
			if (turn === 3) {
				const values = current.history
					.itemBytes()
					.map((item) => new TextDecoder().decode(item));
				expect(values.join("\n")).toContain(
					"Kogen's controller reported this failure.",
				);
				expect(current.threadId).toBe(session().threadId);
			}
		},
	});
	const outcome = await runRungMachine(run.request);
	expect(outcome.kind).toBe("red");
	expect(outcome.reason).toBe("unchanged");
	expect(auditCalls).toBe(1);
	expect(verified).toBe(1);
	const candidate: BuildCandidate | null = outcome.candidate;
	expect(candidate?.verifiedTree).toBe("tree-base");
	const auditEvent = run.emitted.find((value) => value.event === "audit");
	expect(auditEvent?.fields).toMatchObject({
		mode: "observational",
		demoted: false,
		advisory_items: [],
	});
});

test("turn, wall, and budget caps verify the saved-base snapshot", async () => {
	for (const cap of ["turn", "wall", "budget"] as const) {
		const run = baseRequest({
			turns: cap === "turn" ? [completed(textResponse("progress"))] : [],
			verify: [gateResult("green")],
			...(cap === "turn" ? { turnLimit: 1 } : {}),
			...(cap === "wall" ? { wallMilliseconds: 1 } : {}),
			...(cap === "budget"
				? { remainingBuildBudgetMilliseconds: () => 0 }
				: {}),
		});
		if (cap === "turn") {
		} else if (cap === "wall") {
			run.request.developer.complete = async () => {
				run.advanceClock(1);
				return { kind: "cancelled", session: run.request.session, attempts: 1 };
			};
		}
		const outcome = await runRungMachine(run.request);
		expect(outcome.kind).toBe("green");
		expect(run.treeBases.every((base) => base === baseCommit)).toBe(true);
	}
});

test("two red verifications without a count end no_progress", () => {
	const noCount = gateResult("red", 0);
	const first = decideRepair(initialRepairProgress(), noCount);
	expect(first.kind).toBe("repair");
	if (first.kind !== "repair") return;
	expect(decideRepair(first.progress, noCount)).toMatchObject({
		kind: "end",
		reason: "no_progress",
	});
});
