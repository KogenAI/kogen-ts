import { expect, test } from "bun:test";
import { observeBuildAudit } from "../../packages/core/src/build/audit";
import {
	rankBuildCandidates,
	selectBestBuildCandidate,
} from "../../packages/core/src/build/select";
import type {
	GateCheckResult,
	GateVerificationResult,
} from "../../packages/core/src/gate/verify";
import { acceptanceItem, gateResult } from "./fixtures";

const encoder = new TextEncoder();

function diff(lines: readonly string[]): Uint8Array {
	return encoder.encode(
		[
			"diff --git a/lib/greeting.txt b/lib/greeting.txt",
			"index 1111111..2222222 100644",
			"--- a/lib/greeting.txt",
			"+++ b/lib/greeting.txt",
			`@@ -1,${lines.length} +1,${lines.length} @@`,
			...lines,
			"",
		].join("\n"),
	);
}

function candidate(
	name: string,
	ordinal: number,
	verification: GateVerificationResult,
	diffBytes: Uint8Array,
) {
	return { candidate: name, ordinal, verification, diff: diffBytes };
}

function redCheck(): GateCheckResult {
	const log = {
		step: "check",
		stdoutPath: "/run/check.stdout",
		stderrPath: "/run/check.stderr",
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
	};
	return {
		name: "lint",
		argv: ["lint"],
		timeoutMilliseconds: 1000,
		baselineStatus: null,
		status: "red",
		exitStatus: 1,
		timedOut: false,
		excused: false,
		changedPaths: [],
		findings: [],
		log,
		treeBefore: "tree-1",
		treeAfter: "tree-1",
		restoredTree: null,
	};
}

test("selector scores actual passing items before findings, diff size, and rung order", () => {
	const oneItemPass = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "fail")],
	});
	const twoItemsPass = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "pass")],
	});
	const candidates = [
		candidate("R1", 1, oneItemPass, diff(["-old", "+new"])),
		candidate("R2", 2, twoItemsPass, diff(["-a", "+b", "+c"])),
	];
	const winner = selectBestBuildCandidate(candidates);
	expect(winner?.candidate).toBe("R2");
	expect(winner?.score).toEqual({
		passingApprovedItems: 2,
		blockingFindings: 0,
		implementationDiffLines: 3,
		ordinal: 2,
	});
});

test("selector uses blocking findings before diff and uses smallest diff then earliest rung", () => {
	const itemPass = gateResult({
		items: [acceptanceItem("A1", "fail")],
	});
	const noCheckFailure = gateResult({
		items: [acceptanceItem("A1", "fail")],
	});
	const withCheckFailure = gateResult({
		items: [acceptanceItem("A1", "fail")],
		checks: [redCheck()],
	});
	const fewerFindings = candidate(
		"R2",
		2,
		noCheckFailure,
		diff(["-old", "+new", "+extra"]),
	);
	const smallerDiff = candidate(
		"R1",
		1,
		withCheckFailure,
		diff(["-old", "+new"]),
	);
	expect(
		selectBestBuildCandidate([smallerDiff, fewerFindings])?.candidate,
	).toBe("R2");

	const laterRung = candidate("R3", 3, itemPass, diff(["-old", "+new"]));
	const earliestSmallDiff = candidate(
		"R2",
		2,
		itemPass,
		diff(["-old", "+new"]),
	);
	const largerDiff = candidate(
		"R1",
		1,
		itemPass,
		diff(["-a", "-b", "+a", "+b"]),
	);
	expect(
		selectBestBuildCandidate([laterRung, largerDiff, earliestSmallDiff])
			?.candidate,
	).toBe("R2");
});

test("best red candidate keeps its exact diff bytes and rank is order independent", () => {
	const failed = gateResult({ items: [acceptanceItem("A1", "fail")] });
	const bestDiff = diff(["-old", "+new"]);
	const candidates = [
		candidate("R2", 2, failed, diff(["-a", "-b", "+a", "+b"])),
		candidate("R1", 1, failed, bestDiff),
	];
	const first = selectBestBuildCandidate(candidates);
	const reversed = selectBestBuildCandidate([...candidates].reverse());
	expect(first?.candidate).toBe("R1");
	expect(first?.score).toMatchObject({
		blockingFindings: 1,
		implementationDiffLines: 2,
	});
	expect(first?.candidateDiff).toEqual(bestDiff);
	expect(reversed?.candidate).toBe(first?.candidate);
	bestDiff[0] = 0;
	expect(first?.candidateDiff).not.toEqual(bestDiff);
	expect(rankBuildCandidates([])).toEqual([]);
});

test("auditor observations cannot alter selector ordering or score inputs", () => {
	const first = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "fail")],
	});
	const second = gateResult({
		items: [acceptanceItem("A1", "fail"), acceptanceItem("A2", "fail")],
	});
	const candidates = [
		candidate("R1", 1, first, diff(["-old", "+new"])),
		candidate("R2", 2, second, diff(["-old", "+new", "+extra"])),
	];
	const before = rankBuildCandidates(candidates);
	for (const verdict of ["over_strict", "contradicts"] as const)
		observeBuildAudit(first, {
			items: [{ id: "A2", verdict, reason: "Advice only." }],
		});
	const after = rankBuildCandidates(candidates);
	expect(after.map(({ candidate: name, score }) => ({ name, score }))).toEqual(
		before.map(({ candidate: name, score }) => ({ name, score })),
	);
	expect(after[0]?.candidate).toBe("R1");
});

test("diff size ignores headers and binary patch payload", () => {
	const bytes = encoder.encode(
		"diff --git a/x b/x\nGIT binary patch\nliteral 4\n+abcd\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1,2 @@\n-old\n+new\n+second\n",
	);
	const verification = gateResult({
		items: [acceptanceItem("A1", "fail")],
	});
	const ranked = rankBuildCandidates([candidate("R1", 1, verification, bytes)]);
	expect(ranked[0]?.score.implementationDiffLines).toBe(3);
});

test("selector rejects duplicate attempt ordinals instead of depending on input order", () => {
	const verification = gateResult({
		items: [{ id: "A1", status: "fail", rows: [] }],
	});
	const duplicateOrdinal = [
		candidate("R1", 1, verification, diff(["-a", "+b"])),
		candidate("R2", 1, verification, diff(["-a", "+b"])),
	];
	expect(() => selectBestBuildCandidate(duplicateOrdinal)).toThrow(
		"Candidate attempt ordinals must be unique.",
	);
});
