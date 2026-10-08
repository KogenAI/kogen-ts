import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ApprovalCommitRequest } from "../../packages/core/src/approval/commit";
import { commitApprovalPackage } from "../../packages/core/src/approval/commit";
import type { BuildEffectFailure } from "../../packages/core/src/build/controller";
import type { LoadedBuildApproval } from "../../packages/core/src/build/load";
import {
	type BuildWitnessEffects,
	reverifyApprovedWitness,
} from "../../packages/core/src/build/witness";
import type { Result } from "../../packages/core/src/contracts/errors";
import { resolveRoles } from "../../packages/core/src/project/roles";
import type { RespondResult } from "../../packages/core/src/provider/retry/respond";
import {
	createSession,
	type SessionState,
} from "../../packages/core/src/provider/session/transition";
import type { AssembledResponse } from "../../packages/core/src/provider/sse/assemble";
import {
	CANONICAL_TOOL_SCHEMAS,
	TOOL_SCHEMA_VERSION,
} from "../../packages/core/src/provider/tools/schema";
import {
	createWitnessAdjudicationSession,
	parseWitnessAdjudication,
	runShapeWitness,
	type ShapeWitnessRequest,
	type WitnessGateResult,
	type WitnessRepairDirective,
} from "../../packages/core/src/shape/witness";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CURRENT_BASE = "c".repeat(40);
const CURRENT_TREE = "d".repeat(40);
const WITNESS_COMMIT = "e".repeat(40);
const VERIFIED_TREE = "f".repeat(40);
const DIFF = encoder.encode("diff --git a/src.txt b/src.txt\n+verified\n");
const INTENT = encoder.encode("# intent\n");
const TEST = encoder.encode("A1 checks the requested result\n");
const REQUEST = encoder.encode("Make the requested result available.\n");

const roleResolution = resolveRoles({ provider: "chatgpt" });
if (!roleResolution.ok) throw new Error("Default roles failed to resolve.");
const auditorRole = roleResolution.value.roles.auditor;

function makeSourceSession(auditorTools: readonly string[] = []): SessionState {
	const roleAuthorization = {
		builder: ["shell", "finish", "tool_output"],
		planner: ["finish"],
		shaper: ["read", "search", "write"],
		auditor: auditorTools,
		reviewer: ["read"],
		context: [],
	} as const;
	return createSession({
		runDirectory: "/witness-test/run",
		provider: "chatgpt",
		authMode: "injected",
		role: "shaper",
		model: "gpt-6.1-sol",
		effort: "high",
		stage: "shape",
		attempt: "shape-primary",
		rung: "shape-primary",
		epoch: "initial",
		roleInstructions: "Shape the requested Intent.",
		genericInstructions: "Kogen test session.",
		toolSchemas: CANONICAL_TOOL_SCHEMAS,
		toolSchemaVersion: TOOL_SCHEMA_VERSION,
		promptVersion: "test-v1",
		adapterVersion: "test-adapter-v1",
		roleToolAuthorization: roleAuthorization,
	});
}

function modelResult(session: SessionState, text: string): RespondResult {
	const response: AssembledResponse = {
		ok: true,
		id: "witness-adjudication",
		text,
		tool_calls: [],
		usage: null,
		raw_items: [],
		raw_item_json: [],
	};
	return {
		kind: "completed",
		session,
		response,
		attempts: [],
		events: [],
		retryState: {} as RespondResult extends { retryState: infer T } ? T : never,
	} as RespondResult;
}

function greenGate(): WitnessGateResult {
	return {
		kind: "green",
		candidate: {
			commit: WITNESS_COMMIT,
			parent: BASE,
			baseSha: BASE,
			diff: DIFF,
		},
	};
}

function gateQueue(
	results: readonly WitnessGateResult[],
	observe?: (
		request: Parameters<ShapeWitnessRequest["effects"]["runGate"]>[0],
	) => void,
): ShapeWitnessRequest["effects"]["runGate"] {
	let index = 0;
	return async (request) => {
		observe?.(request);
		const result = results[index];
		index += 1;
		if (result === undefined) throw new Error("Unexpected witness gate run.");
		return result;
	};
}

function shapeRequest(input: {
	readonly gateResults: readonly WitnessGateResult[];
	readonly difficulty?: "easy" | "medium" | "hard";
	readonly witnessRounds?: number;
	readonly requestModel?: ShapeWitnessRequest["requestModel"];
	readonly repair?: ShapeWitnessRequest["effects"]["repair"];
	readonly validate?: ShapeWitnessRequest["effects"]["validate"];
	readonly publishRef?: ShapeWitnessRequest["effects"]["publishRef"];
	readonly onGate?: (
		request: Parameters<ShapeWitnessRequest["effects"]["runGate"]>[0],
	) => void;
}): ShapeWitnessRequest {
	return {
		slug: "witness-proof",
		baseSha: BASE,
		difficulty: input.difficulty ?? "easy",
		witnessRounds: input.witnessRounds ?? 2,
		requestBytes: REQUEST,
		intentBytes: INTENT,
		acceptanceBytes: TEST,
		sourceSession: makeSourceSession(),
		auditorRole,
		requestModel:
			input.requestModel ??
			(async (session) => modelResult(session, '{"items":[]}')),
		effects: {
			runGate: gateQueue(input.gateResults, input.onGate),
			repair:
				input.repair ??
				(async ({ acceptanceBytes }) => ({
					ok: true,
					value: acceptanceBytes,
				})),
			validate: input.validate ?? (async () => true),
			publishRef:
				input.publishRef ?? (async () => ({ ok: true, value: "created" })),
		},
	};
}

test("green witness publishes an immutable record only for the exact base and diff", async () => {
	const published: {
		value: { ref: string; commit: string; expected: null } | null;
	} = { value: null };
	let gateRequest:
		| Parameters<ShapeWitnessRequest["effects"]["runGate"]>[0]
		| null = null;
	const result = await runShapeWitness(
		shapeRequest({
			gateResults: [greenGate()],
			onGate: (request) => {
				gateRequest = request;
			},
			publishRef: async (request) => {
				published.value = request;
				return { ok: true, value: "created" };
			},
		}),
	);
	expect(result.verdict).toBe("PROVEN");
	expect(result.witness).toEqual({
		verdict: "PROVEN",
		commit: WITNESS_COMMIT,
		diff_sha256: createHash("sha256").update(DIFF).digest("hex"),
		base_sha: BASE,
	});
	expect(published.value).toEqual({
		ref: "refs/kogen/witness/witness-proof",
		commit: WITNESS_COMMIT,
		expected: null,
	});
	expect(gateRequest).toMatchObject({
		rungs: ["R1"],
		parallelRungs: false,
		workspace: "throwaway",
		sandbox: true,
		realGate: true,
		auditorDemotion: false,
	});
});

test("hard witness asks for parallel R1 and R2 and never enables demotion", async () => {
	let gateRequest:
		| Parameters<ShapeWitnessRequest["effects"]["runGate"]>[0]
		| null = null;
	const result = await runShapeWitness(
		shapeRequest({
			gateResults: [greenGate()],
			difficulty: "hard",
			onGate: (request) => {
				gateRequest = request;
			},
		}),
	);
	expect(result.verdict).toBe("PROVEN");
	expect(gateRequest).toMatchObject({
		rungs: ["R1", "R2"],
		parallelRungs: true,
		auditorDemotion: false,
	});
});

test("TEST-WRONG repairs the test, revalidates it, then reruns the gate", async () => {
	const failures: WitnessGateResult = {
		kind: "red",
		failures: [{ id: "A1", output: ["expected result, got none"] }],
	};
	let gateRuns = 0;
	const requestedSession: { value: SessionState | null } = { value: null };
	let directives: readonly WitnessRepairDirective[] = [];
	let validations = 0;
	const correctedTest = encoder.encode(
		"A1 checks the actual requested behavior\n",
	);
	const result = await runShapeWitness(
		shapeRequest({
			gateResults: [failures, greenGate()],
			onGate: () => {
				gateRuns += 1;
			},
			requestModel: async (session) => {
				requestedSession.value = session;
				return modelResult(
					session,
					'{"items":[{"id":"A1","verdict":"TEST-WRONG","citation":"requested behavior","reason":"The assertion is too narrow."}]}',
				);
			},
			repair: async (request) => {
				directives = request.directives;
				return { ok: true, value: correctedTest };
			},
			validate: async ({ acceptanceBytes }) => {
				validations += 1;
				return (
					decoder.decode(acceptanceBytes) === decoder.decode(correctedTest)
				);
			},
		}),
	);
	expect(result.verdict).toBe("PROVEN");
	expect(result.gateRuns).toBe(2);
	expect(result.adjudicationRounds).toBe(1);
	expect(decoder.decode(result.acceptanceBytes)).toBe(
		decoder.decode(correctedTest),
	);
	expect(directives).toEqual([
		{
			id: "A1",
			kind: "test",
			citation: "requested behavior",
			reason: "The assertion is too narrow.",
		},
	]);
	expect(requestedSession.value?.authorizedTools).toEqual([]);
	expect(requestedSession.value?.stage).toBe("shape-witness-adjudication");
	expect(validations).toBe(1);
	expect(gateRuns).toBe(2);
});

test("WITNESS-WRONG cannot change test bytes and undecided advice remains a concern", async () => {
	const failures: WitnessGateResult = {
		kind: "red",
		failures: [
			{ id: "A1", output: ["implementation misses behavior"] },
			{ id: "A2", output: ["cannot isolate source of failure"] },
		],
	};
	const result = await runShapeWitness(
		shapeRequest({
			gateResults: [failures, greenGate()],
			requestModel: async (session) =>
				modelResult(
					session,
					'{"items":[{"id":"A1","verdict":"WITNESS-WRONG","citation":"implementation","reason":"Fix the source."},{"id":"A2","verdict":"UNDECIDED","citation":"","reason":"Evidence is inconclusive."}]}',
				),
			repair: async ({ acceptanceBytes, directives }) => {
				expect(directives.map((item) => item.kind)).toEqual(["witness"]);
				return { ok: true, value: acceptanceBytes };
			},
		}),
	);
	expect(result.verdict).toBe("PROVEN_WITH_CONCERNS");
	expect(result.witness?.verdict).toBe("PROVEN_WITH_CONCERNS");
	expect(result.concerns).toContain(
		"feasibility_concern A2: Evidence is inconclusive.",
	);
});

test("unresolved red witness and conflicting ref cannot become proof", async () => {
	const failures: WitnessGateResult = {
		kind: "red",
		failures: [{ id: "A1", output: ["failure"] }],
	};
	const unresolved = await runShapeWitness(
		shapeRequest({
			gateResults: [failures],
			requestModel: async (session) =>
				modelResult(
					session,
					'{"items":[{"id":"A1","verdict":"UNDECIDED","citation":"","reason":"Cannot determine."}]}',
				),
		}),
	);
	expect(unresolved.verdict).toBe("UNPROVEN");
	expect(unresolved.witness).toBeNull();
	const conflicted = await runShapeWitness(
		shapeRequest({
			gateResults: [greenGate()],
			publishRef: async () => ({ ok: true, value: "conflict" }),
		}),
	);
	expect(conflicted.verdict).toBe("UNPROVEN");
	expect(conflicted.witness).toBeNull();
});

test("witness repairs stop at the configured adjudication round limit", async () => {
	const failures: WitnessGateResult = {
		kind: "red",
		failures: [{ id: "A1", output: ["still red"] }],
	};
	let adjudications = 0;
	let repairs = 0;
	const result = await runShapeWitness(
		shapeRequest({
			gateResults: [failures, failures],
			witnessRounds: 1,
			requestModel: async (session) => {
				adjudications += 1;
				return modelResult(
					session,
					'{"items":[{"id":"A1","verdict":"TEST-WRONG","citation":"A1","reason":"Repair the test."}]}',
				);
			},
			repair: async ({ acceptanceBytes }) => {
				repairs += 1;
				return { ok: true, value: acceptanceBytes };
			},
		}),
	);
	expect(result.verdict).toBe("UNPROVEN");
	expect(result.witness).toBeNull();
	expect(result.gateRuns).toBe(2);
	expect(result.adjudicationRounds).toBe(1);
	expect(adjudications).toBe(1);
	expect(repairs).toBe(1);
});

test("adjudication parser turns duplicate, missing, and unknown advice into undecided", () => {
	const parsed = parseWitnessAdjudication(
		'{"items":[{"id":"A1","verdict":"TEST-WRONG","citation":"x","reason":"r"},{"id":"A1","verdict":"WITNESS-WRONG","citation":"y","reason":"r"},{"id":"other","verdict":"TEST-WRONG","citation":"z","reason":"r"}]}',
		["A1", "A2"],
	);
	expect(parsed.items.map((item) => item.verdict)).toEqual([
		"UNDECIDED",
		"UNDECIDED",
	]);
	expect(parsed.warnings.length).toBeGreaterThan(0);
});

test("adjudication session rejects auditor tools", () => {
	const session = makeSourceSession();
	const created = createWitnessAdjudicationSession({
		source: session,
		role: auditorRole,
		round: 1,
		message: "Adjudicate A1.",
	});
	expect(created.authorizedTools).toEqual([]);
	expect(created.effectiveRole).toBe("auditor");
	expect(created.roleInstructions).toContain("no tools");
	expect(() =>
		createWitnessAdjudicationSession({
			source: makeSourceSession(["read"]),
			role: auditorRole,
			round: 1,
			message: "Adjudicate A1.",
		}),
	).toThrow("must not have tools");
});

function approvedWitness(metadataWitness: unknown): LoadedBuildApproval {
	return {
		slug: "witness-proof",
		approvalCommit: "1".repeat(40),
		approvalSha256: "2".repeat(64),
		intentSha256: "3".repeat(64),
		targetBranch: "main",
		baseSha: BASE,
		intentPath: ".kogen/intents/witness-proof/intent.md",
		acceptancePath: ".kogen/acceptance/witness-proof.t.sh",
		intentBytes: INTENT,
		acceptanceBytes: TEST,
		metadata: { witness: metadataWitness },
	};
}

function metadataRecord() {
	return {
		verdict: "PROVEN",
		commit: WITNESS_COMMIT,
		diff_sha256: createHash("sha256").update(DIFF).digest("hex"),
		base_sha: BASE,
	};
}

function buildEffects(
	options: {
		readonly ref?: string | null;
		readonly diff?: Uint8Array;
		readonly verification?: "green" | "red";
		readonly onVerify?: Parameters<
			BuildWitnessEffects["verify"]
		>[0] extends infer T
			? (request: T) => void
			: never;
		readonly onApply?: Parameters<
			BuildWitnessEffects["applyWitness"]
		>[0] extends infer T
			? (request: T) => void
			: never;
	} = {},
): BuildWitnessEffects {
	const ok = <T>(value: T): Result<T, BuildEffectFailure> => ({
		ok: true,
		value,
	});
	return {
		readRef: async () => ok(options.ref ?? WITNESS_COMMIT),
		readDiff: async () => ok(options.diff ?? DIFF),
		createWorkspace: async ({ workspace }) =>
			ok({ id: "witness-workspace", root: `/${workspace}/root` }),
		applyWitness: async (request) => {
			options.onApply?.(request);
			return ok<void>(undefined);
		},
		verify: async (request) => {
			options.onVerify?.(request);
			return ok({
				kind: options.verification ?? "green",
				verifiedTree: VERIFIED_TREE,
			});
		},
		cleanup: async () => ok<void>(undefined),
	};
}

const currentBase = {
	commit: CURRENT_BASE,
	tree: CURRENT_TREE,
	trackedPaths: ["src.txt"],
} as const;

test("Build rechecks the immutable witness on the current base with no model calls", async () => {
	let verifyRequest: Parameters<BuildWitnessEffects["verify"]>[0] | null = null;
	let applyRequest: Parameters<BuildWitnessEffects["applyWitness"]>[0] | null =
		null;
	const result = await reverifyApprovedWitness({
		runId: "build-1",
		approval: approvedWitness(metadataRecord()),
		base: currentBase,
		effects: buildEffects({
			onVerify: (request) => {
				verifyRequest = request;
			},
			onApply: (request) => {
				applyRequest = request;
			},
		}),
	});
	expect(result.kind).toBe("green");
	if (result.kind !== "green") return;
	expect(result.candidate).toMatchObject({
		rung: "witness",
		verifiedTree: VERIFIED_TREE,
		verdict: "green",
	});
	expect(applyRequest).toMatchObject({
		witnessBase: BASE,
		currentBase,
		witnessCommit: WITNESS_COMMIT,
	});
	expect(verifyRequest).toMatchObject({
		base: currentBase,
		sandbox: true,
		modelCalls: false,
		auditorDemotion: false,
	});
});

test("stale refs and diffs go to the normal ladder without landing the witness", async () => {
	const staleRef = await reverifyApprovedWitness({
		runId: "build-1",
		approval: approvedWitness(metadataRecord()),
		base: currentBase,
		effects: buildEffects({ ref: "9".repeat(40) }),
	});
	expect(staleRef).toEqual({ kind: "ladder", reason: "stale_ref" });
	const staleDiff = await reverifyApprovedWitness({
		runId: "build-1",
		approval: approvedWitness(metadataRecord()),
		base: currentBase,
		effects: buildEffects({ diff: encoder.encode("changed diff") }),
	});
	expect(staleDiff).toEqual({ kind: "ladder", reason: "stale_diff" });
});

test("a red current-base verification cleans up and returns to the normal ladder", async () => {
	let cleaned = false;
	const effects = buildEffects({ verification: "red" });
	effects.cleanup = async () => {
		cleaned = true;
		return { ok: true, value: undefined };
	};
	const result = await reverifyApprovedWitness({
		runId: "build-1",
		approval: approvedWitness(metadataRecord()),
		base: currentBase,
		effects,
	});
	expect(result).toEqual({ kind: "ladder", reason: "red" });
	expect(cleaned).toBe(true);
});

test("unproven witness approval is refused before any effect runs", async () => {
	const unused = async (): Promise<never> => {
		throw new Error("An effect must not run before unproven refusal.");
	};
	const baseSha = BASE;
	const preflight = {
		kind: "ready_to_approve",
		exitCode: 0,
		approvalSha256: "a".repeat(64),
		intentSha256: "b".repeat(64),
		checkedBaseTree: BASE_TREE,
		checkBaseline: [],
		acceptanceChecks: [{ name: "test", status: "green" }],
		warnings: [],
		warningText: "",
		card: null,
		baselineCacheKey: null,
		baselineCacheHit: false,
		checkoutTree: BASE_TREE,
		checkedInScratch: true,
	} as unknown as ApprovalCommitRequest["preflight"];
	const request = {
		origin: "/tmp/witness-origin",
		checkout: "/tmp/witness-checkout",
		slug: "witness-proof",
		intentPath: ".kogen/intents/witness-proof/intent.md",
		acceptancePath: ".kogen/acceptance/witness-proof.t.sh",
		targetBranch: "main",
		baseSha,
		givenHash: "a".repeat(64),
		preflight,
		protectedManifest: {},
		witnessRequired: true,
		witness: null,
		filesystem: { readFile: unused },
		git: { command: unused },
		clock: { unixMilliseconds: () => 1_800_000_000_000 },
	} satisfies ApprovalCommitRequest;
	const result = await commitApprovalPackage(request);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe("intent/unproven");
});
