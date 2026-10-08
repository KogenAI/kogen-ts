import { expect, test } from "bun:test";
import type { LandingCommit } from "../../packages/core/src/build/landing/commit";
import type { LandingPublishOutcome } from "../../packages/core/src/build/landing/publish";
import {
	LANDING_REPAIR_ALLOWANCE_MILLISECONDS,
	type LandingRebasePorts,
	LandingRepairAllowance,
	rebaseAndVerifyLanding,
	type WinningBuildConversation,
} from "../../packages/core/src/build/landing/rebase";
import {
	LANDING_RETRY_DELAYS_MILLISECONDS,
	type LandingRetryPorts,
	retryLanding,
} from "../../packages/core/src/build/landing/retry";
import type { Result } from "../../packages/core/src/contracts/errors";
import type { RunRecord } from "../../packages/core/src/run/store";

const run: RunRecord = {
	schema: 2,
	run_id: "a".repeat(32),
	slug: "greet",
	approval_sha256: "b".repeat(64),
	approval_commit: "1".repeat(40),
	target_branch: "main",
	status: "running",
	landing: null,
	owner_pid: 10,
	owner_started_ms: 1_800_000_000_000,
	started_ms: 1_800_000_000_001,
	recovery: [],
	cleanup_pending: false,
};

function commit(id: string, parent: string, tree: string): LandingCommit {
	return {
		commit: id.repeat(40),
		parent: parent.repeat(40),
		tree: tree.repeat(40),
		objectFormat: "sha1",
		transferCleanupWarning: null,
	};
}

function ok<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

function greenCommit(): LandingCommit {
	return commit("6", "2", "5");
}

test("moved-base conflict and red re-gate repair the winning conversation", async () => {
	const originalCandidate = commit("4", "1", "3");
	const originalConversation = { id: "R2-builder", state: { step: 0 } };
	const allowance = new LandingRepairAllowance();
	const repairStates: unknown[] = [];
	const phases: string[] = [];
	const eventRungs: string[] = [];
	let rebaseCount = 0;
	let verificationCount = 0;
	let commitCount = 0;
	const ports: LandingRebasePorts<{ step: number }> = {
		async resolveBase() {
			return ok({ commit: "2".repeat(40), tree: "7".repeat(40) });
		},
		async rebase() {
			rebaseCount += 1;
			if (rebaseCount === 1)
				return ok({ kind: "conflict", paths: ["lib/greet.txt"] });
			return ok({ kind: "ready" });
		},
		async guard() {
			return ok({ kind: "pass" });
		},
		async verify() {
			verificationCount += 1;
			return ok(
				verificationCount === 1
					? {
							status: "red",
							tree: "8".repeat(40),
							count: 1,
							feedback: "A1 failed on the moved base",
						}
					: {
							status: "green",
							tree: "5".repeat(40),
							count: 0,
							feedback: "",
						},
			);
		},
		async repair(input) {
			expect(input.rung).toBe("R2");
			repairStates.push(input.conversation.state);
			const step = input.conversation.state.step + 1;
			return ok({
				kind: "completed",
				conversation: { id: input.conversation.id, state: { step } },
				activeMilliseconds: step * 10,
			});
		},
		async commit(input) {
			commitCount += 1;
			return ok({
				...greenCommit(),
				parent: input.base.commit,
				tree: input.verifiedTree,
			});
		},
		async emit(event, fields) {
			phases.push(event);
			if (event === "repair" || event === "verification")
				eventRungs.push(fields.rung as string);
		},
	};

	const result = await rebaseAndVerifyLanding(
		{
			run,
			rung: "R2",
			candidate: originalCandidate,
			bestCandidate: originalCandidate,
			conversation: originalConversation,
			allowance,
		},
		ports,
	);

	expect(result.kind).toBe("ready");
	if (result.kind !== "ready") return;
	expect(rebaseCount).toBe(3);
	expect(verificationCount).toBe(2);
	expect(commitCount).toBe(1);
	expect(repairStates).toEqual([{ step: 0 }, { step: 1 }]);
	expect(result.conversation.id).toBe(originalConversation.id);
	expect(result.conversation.state).toEqual({ step: 2 });
	expect(result.candidate.parent).toBe("2".repeat(40));
	expect(result.candidate.tree).toBe("5".repeat(40));
	expect(allowance.usedMilliseconds).toBe(30);
	expect(eventRungs).toEqual(["R2", "R2", "R2", "R2"]);
	expect(phases).toEqual([
		"landing_rebase",
		"repair",
		"landing_rebase",
		"verification",
		"repair",
		"landing_rebase",
		"verification",
	]);
});

test("a landing repair cannot replace the winning conversation", async () => {
	const originalCandidate = commit("4", "1", "3");
	const conversation = { id: "R1-builder", state: { step: 0 } };
	const ports: LandingRebasePorts<{ step: number }> = {
		async resolveBase() {
			return ok({ commit: "2".repeat(40), tree: "7".repeat(40) });
		},
		async rebase() {
			return ok({ kind: "conflict", paths: ["lib/greet.txt"] });
		},
		async guard() {
			throw new Error("a conflict must be repaired before the guard");
		},
		async verify() {
			throw new Error("a conflict must be repaired before the gate");
		},
		async repair(_input) {
			return ok({
				kind: "completed",
				conversation: { id: "new-conversation", state: { step: 1 } },
				activeMilliseconds: 1,
			});
		},
		async commit() {
			throw new Error("a changed conversation cannot land");
		},
		async emit() {},
	};

	const result = await rebaseAndVerifyLanding(
		{
			run,
			rung: "R1",
			candidate: originalCandidate,
			bestCandidate: originalCandidate,
			conversation,
			allowance: new LandingRepairAllowance(),
		},
		ports,
	);

	expect(result.kind).toBe("stopped");
	if (result.kind !== "stopped") return;
	expect(result.failure.message).toBe(
		"Moved-base repair changed the winning conversation.",
	);
});

test("landing allowance exhaustion parks the last green candidate", async () => {
	const originalCandidate = commit("4", "1", "3");
	const conversation: WinningBuildConversation<{ step: number }> = {
		id: "R1-builder",
		state: { step: 0 },
	};
	const allowance = new LandingRepairAllowance(10);
	let commitCount = 0;
	const ports: LandingRebasePorts<{ step: number }> = {
		async resolveBase() {
			return ok({ commit: "2".repeat(40), tree: "7".repeat(40) });
		},
		async rebase() {
			return ok({ kind: "ready" });
		},
		async guard() {
			return ok({ kind: "pass" });
		},
		async verify() {
			return ok({
				status: "red",
				tree: "8".repeat(40),
				count: 1,
				feedback: "A1 still fails",
			});
		},
		async repair(input) {
			expect(input.remainingAllowanceMilliseconds).toBe(10);
			return ok({
				kind: "completed",
				conversation: input.conversation,
				activeMilliseconds: 11,
			});
		},
		async commit() {
			commitCount += 1;
			return ok(greenCommit());
		},
		async emit() {},
	};

	const result = await rebaseAndVerifyLanding(
		{
			run,
			rung: "R1",
			candidate: originalCandidate,
			bestCandidate: originalCandidate,
			conversation,
			allowance,
		},
		ports,
	);

	expect(result.kind).toBe("parked");
	if (result.kind !== "parked") return;
	expect(result.reason).toBe("landing_allowance_exhausted");
	expect(result.bestCandidate).toBe(originalCandidate);
	expect(commitCount).toBe(0);
	expect(allowance.usedMilliseconds).toBe(10);
});

test("landing allowance is the separate ten-minute allowance", () => {
	expect(new LandingRepairAllowance().remainingMilliseconds).toBe(
		LANDING_REPAIR_ALLOWANCE_MILLISECONDS,
	);
	expect(LANDING_REPAIR_ALLOWANCE_MILLISECONDS).toBe(600_000);
});

function notLanded(
	record: RunRecord,
	reason: "branch_locked" | "base_moved",
	currentBase: string | null,
): Extract<LandingPublishOutcome, { readonly kind: "not_landed" }> {
	return { kind: "not_landed", reason, currentBase, record };
}

function landed(
	record: RunRecord,
): Extract<LandingPublishOutcome, { readonly kind: "landed" }> {
	return {
		kind: "landed",
		record: { ...record, status: "landed" },
		candidateCommit: "6".repeat(40),
		incomingRef: `refs/kogen/incoming/${record.run_id}`,
		warnings: [],
		cleanupPending: false,
		terminalRecordPersisted: true,
		cleanupFailurePersisted: true,
	};
}

test("a .lock retry waits one second before another publish", async () => {
	const events: number[] = [];
	const waits: number[] = [];
	let calls = 0;
	const ports: LandingRetryPorts<{ step: number }> = {
		async publish(input) {
			calls += 1;
			return ok(
				calls === 1
					? notLanded(input.run, "branch_locked", input.candidate.parent)
					: landed(input.run),
			);
		},
		async discardIncoming() {
			throw new Error("lock recovery should not rebase");
		},
		async rebase() {
			throw new Error("lock recovery should not rebase");
		},
		async emit(_event, fields) {
			events.push(fields.delay_ms as number);
		},
		async sleep(milliseconds) {
			waits.push(milliseconds);
		},
	};
	const result = await retryLanding(
		{
			run,
			rung: "R1",
			candidate: commit("4", "1", "3"),
			conversation: { id: "R1-builder", state: { step: 0 } },
		},
		ports,
	);

	expect(result.kind).toBe("landed");
	expect(calls).toBe(2);
	expect(events).toEqual([1_000]);
	expect(waits).toEqual([1_000]);
	expect(LANDING_RETRY_DELAYS_MILLISECONDS).toEqual([1_000, 2_000, 4_000]);
});

test("a lost CAS retries, drops its stale incoming ref, then re-gates and lands", async () => {
	const oldCandidate = commit("4", "1", "3");
	const movedCandidate = commit("6", "2", "5");
	const events: number[] = [];
	const waits: number[] = [];
	const calls: LandingCommit[] = [];
	let discarded = 0;
	let rebases = 0;
	const conversation: WinningBuildConversation<{ step: number }> = {
		id: "R1-builder",
		state: { step: 2 },
	};
	const ports: LandingRetryPorts<{ step: number }> = {
		async publish(input) {
			calls.push(input.candidate);
			return ok(
				calls.length < 5
					? notLanded(input.run, "base_moved", "2".repeat(40))
					: landed(input.run),
			);
		},
		async discardIncoming(input) {
			discarded += 1;
			expect(input.candidate).toBe(oldCandidate);
			return ok(undefined);
		},
		async rebase(input) {
			rebases += 1;
			expect(input.conversation).toBe(conversation);
			expect(input.bestCandidate).toBe(oldCandidate);
			return {
				kind: "ready",
				candidate: movedCandidate,
				bestCandidate: movedCandidate,
				conversation,
				record: input.run,
			};
		},
		async emit(_event, fields) {
			events.push(fields.delay_ms as number);
		},
		async sleep(milliseconds) {
			waits.push(milliseconds);
		},
	};

	const result = await retryLanding(
		{ run, rung: "R1", candidate: oldCandidate, conversation },
		ports,
	);

	expect(result.kind).toBe("landed");
	expect(calls.slice(0, 4).every((item) => item === oldCandidate)).toBe(true);
	expect(calls[4]).toBe(movedCandidate);
	expect(events).toEqual([1_000, 2_000, 4_000]);
	expect(waits).toEqual([1_000, 2_000, 4_000]);
	expect(discarded).toBe(1);
	expect(rebases).toBe(1);
});

test("persistent lock after a no-op rebase parks with the best candidate", async () => {
	const candidate = commit("4", "1", "3");
	let calls = 0;
	let rebases = 0;
	const delays: number[] = [];
	const result = await retryLanding(
		{
			run,
			rung: "R1",
			candidate,
			conversation: { id: "R1-builder", state: { step: 0 } },
			allowance: new LandingRepairAllowance(5),
		},
		{
			async publish(input) {
				calls += 1;
				return ok(
					notLanded(input.run, "branch_locked", input.candidate.parent),
				);
			},
			async discardIncoming() {
				return ok(undefined);
			},
			async rebase(input) {
				rebases += 1;
				return {
					kind: "ready",
					candidate,
					bestCandidate: candidate,
					conversation: input.conversation,
					record: input.run,
				};
			},
			async emit(_event, fields) {
				delays.push(fields.delay_ms as number);
			},
			async sleep() {},
		},
	);

	expect(result.kind).toBe("parked");
	if (result.kind !== "parked") return;
	expect(result.reason).toBe("landing_lock_persisted");
	expect(result.bestCandidate).toBe(candidate);
	expect(calls).toBe(8);
	expect(rebases).toBe(1);
	expect(delays).toEqual([1_000, 2_000, 4_000, 1_000, 2_000, 4_000]);
});
