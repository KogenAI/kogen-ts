import { expect, test } from "bun:test";
import type { BuildEffectFailure } from "../../packages/core/src/build/controller";
import {
	type EdgeTestCandidateInput,
	optionalEdgeTestsEnabled,
	runOptionalEdgeTestsBeforeSelection,
} from "../../packages/core/src/build/edge";
import type { Result } from "../../packages/core/src/contracts/errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REQUEST =
	"Cover the unusual boundary.\r\nPreserve exact request bytes.\r\n";
const intentBytes = encoder.encode(
	"---\r\n" +
		"title: Edge fixture\r\n" +
		"size: small\r\n" +
		"domains: [core]\r\n" +
		"---\r\n" +
		"## Acceptance\r\n" +
		"- A1: exercise the requested boundary\r\n" +
		"## Verify\r\n" +
		"- A1: test\r\n" +
		"## Request\r\n" +
		REQUEST,
);

function candidate(
	ordinal: number,
	verdict: "green" | "red" = "green",
): EdgeTestCandidateInput {
	const rung = `R${ordinal}`;
	return {
		ordinal,
		candidate: {
			rung,
			workspace: {
				id: `workspace-${ordinal}`,
				root: `/scratch/${ordinal}`,
			},
			verifiedTree: String(ordinal).repeat(40),
			verdict,
		},
	};
}

function ok<Value>(value: Value): Result<Value, BuildEffectFailure> {
	return { ok: true, value };
}

function err<Value = never>(
	code: string,
	message: string,
): Result<Value, BuildEffectFailure> {
	return {
		ok: false,
		error: { code, message, exitCode: 3 },
	};
}

test("optional edge generation stays off unless explicitly enabled", async () => {
	expect(optionalEdgeTestsEnabled(undefined)).toBe(false);
	expect(optionalEdgeTestsEnabled({ recipe: "ladder", edgeTests: false })).toBe(
		false,
	);
	expect(optionalEdgeTestsEnabled({ recipe: "ladder+edge" })).toBe(true);
	expect(optionalEdgeTestsEnabled({ recipe: "ladder", edgeTests: true })).toBe(
		true,
	);

	let effectsCalled = false;
	let selected = false;
	const result = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: false,
			intentBytes: new Uint8Array(),
			candidates: [candidate(1)],
			effects: {
				async generate() {
					effectsCalled = true;
					return ok(encoder.encode("should not run"));
				},
				async run() {
					effectsCalled = true;
					return ok({
						verdict: "green",
						verifiedTree: String(1).repeat(40),
						failureLines: [],
					});
				},
			},
		},
		(candidates) => {
			selected = true;
			expect(candidates[0]?.landable).toBe(true);
			return 1;
		},
	);

	expect(result.kind).toBe("disabled");
	expect(result.canLand).toBe(true);
	expect(effectsCalled).toBe(false);
	expect(selected).toBe(true);
});

test("generation receives the exact Request and a single candidate runs its own suite", async () => {
	const observedRequest: string[] = [];
	const order: string[] = [];
	const result = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: true,
			intentBytes,
			candidates: [candidate(1)],
			effects: {
				async generate(input) {
					order.push("generate");
					observedRequest.push(decoder.decode(input.requestBytes));
					return ok(encoder.encode("edge suite for R1"));
				},
				async run(input) {
					order.push(
						"run:R" +
							input.target.rung.slice(1) +
							":suite-R" +
							input.suiteAuthor.rung.slice(1),
					);
					expect(decoder.decode(input.suiteBytes)).toBe("edge suite for R1");
					return ok({
						verdict: "green",
						verifiedTree: input.target.verifiedTree,
						failureLines: [],
					});
				},
			},
		},
		(candidates) => {
			order.push("select");
			return candidates[0]?.ordinal ?? null;
		},
	);

	expect(observedRequest).toEqual([REQUEST]);
	expect(order).toEqual(["generate", "run:R1:suite-R1", "select"]);
	expect(result.kind).toBe("checked");
	expect(result.canLand).toBe(true);
	expect(result.selected?.edgeStatus).toBe("passed");
	expect(result.selected?.observations).toHaveLength(1);
});

test("an edge test failure is visible to selection and blocks landing", async () => {
	const result = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: true,
			intentBytes,
			candidates: [candidate(1)],
			effects: {
				async generate() {
					return ok(encoder.encode("assert boundary"));
				},
				async run(input) {
					return ok({
						verdict: "red",
						verifiedTree: input.target.verifiedTree,
						failureLines: ["assertion failed: boundary"],
					});
				},
			},
		},
		(candidates) => candidates[0]?.ordinal ?? null,
	);

	expect(result.kind).toBe("checked");
	expect(result.selected?.edgeStatus).toBe("failed");
	expect(result.selected?.landable).toBe(false);
	expect(result.canLand).toBe(false);
	expect(result.selected?.observations[0]?.failureLines).toEqual([
		"assertion failed: boundary",
	]);
});

test("green parallel candidates run the full cross-test matrix before selection", async () => {
	const order: string[] = [];
	const runPairs: string[] = [];
	const candidates = [candidate(2), candidate(1)];
	const result = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: true,
			intentBytes,
			candidates,
			effects: {
				async generate(input) {
					order.push(`generate:R${input.author.rung.slice(1)}`);
					return ok(encoder.encode(`suite-R${input.author.rung.slice(1)}`));
				},
				async run(input) {
					const pair =
						"R" +
						input.target.rung.slice(1) +
						"<-R" +
						input.suiteAuthor.rung.slice(1);
					order.push(`run:${pair}`);
					runPairs.push(pair);
					const failed =
						input.target.rung === "R2" && input.suiteAuthor.rung === "R1";
					return ok({
						verdict: failed ? "red" : "green",
						verifiedTree: input.target.verifiedTree,
						failureLines: failed ? ["peer edge assertion failed"] : [],
					});
				},
			},
		},
		(evaluations) => {
			order.push("select");
			return evaluations.find((entry) => entry.landable)?.ordinal ?? null;
		},
	);

	expect(runPairs).toEqual(["R1<-R1", "R1<-R2", "R2<-R1", "R2<-R2"]);
	expect(order).toEqual([
		"generate:R1",
		"generate:R2",
		"run:R1<-R1",
		"run:R1<-R2",
		"run:R2<-R1",
		"run:R2<-R2",
		"select",
	]);
	expect(result.kind).toBe("checked");
	expect(result.selected?.ordinal).toBe(1);
	expect(result.canLand).toBe(true);
	expect(result.candidates.find((entry) => entry.ordinal === 2)?.landable).toBe(
		false,
	);
	expect(
		result.candidates.find((entry) => entry.ordinal === 2)?.observations,
	).toHaveLength(2);
});

test("generation or candidate mutation failure prevents selection", async () => {
	let selected = false;
	const generationFailure = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: true,
			intentBytes,
			candidates: [candidate(1)],
			effects: {
				async generate() {
					return err("provider/unavailable", "fake generation failure");
				},
				async run() {
					return ok({
						verdict: "green",
						verifiedTree: String(1).repeat(40),
						failureLines: [],
					});
				},
			},
		},
		() => {
			selected = true;
			return 1;
		},
	);
	expect(generationFailure.kind).toBe("stopped");
	expect(generationFailure.canLand).toBe(false);
	expect(selected).toBe(false);

	const mutationFailure = await runOptionalEdgeTestsBeforeSelection(
		{
			enabled: true,
			intentBytes,
			candidates: [candidate(1)],
			effects: {
				async generate() {
					return ok(encoder.encode("edge suite"));
				},
				async run(_input) {
					return ok({
						verdict: "green",
						verifiedTree: "f".repeat(40),
						failureLines: [],
					});
				},
			},
		},
		() => {
			selected = true;
			return 1;
		},
	);
	expect(mutationFailure.kind).toBe("stopped");
	expect(mutationFailure.canLand).toBe(false);
	expect(selected).toBe(false);
});
