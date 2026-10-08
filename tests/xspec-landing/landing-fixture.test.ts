import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishLanding } from "../../packages/core/src/build/landing/publish";
import {
	LandingRepairAllowance,
	rebaseAndVerifyLanding,
} from "../../packages/core/src/build/landing/rebase";
import { retryLanding } from "../../packages/core/src/build/landing/retry";
import type { Result } from "../../packages/core/src/contracts/errors";
import type { ProcessIdentityPort } from "../../packages/core/src/queue/lock";
import {
	type RecoveryWorkspaceTarget,
	recoverDeadRun,
} from "../../packages/core/src/recovery/recover";
import {
	decodeJsonLines,
	type JournalEvent,
} from "../../packages/core/src/run/journal";
import { parseRunRecord } from "../../packages/core/src/run/store";
import { createLandingFixture } from "../../packages/test-support/src/landing-fixture";

const deadOwner: ProcessIdentityPort = {
	current: () => ({ pid: 424242, startedMs: 1_750_000_000_000 }),
	async inspect() {
		return { ok: true, value: { kind: "dead" } };
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function success<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

test("landing fixture exposes real origin compare-and-swap outcomes", async () => {
	const fixture = await createLandingFixture();
	try {
		const candidate = await fixture.createCandidate();
		expect(candidate.parent).toBe(fixture.baseCommit);
		expect(
			fixture.moveRef("refs/heads/main", fixture.baseCommit, candidate.commit),
		).toBe(true);
		expect(fixture.readRef("refs/heads/main")).toBe(candidate.commit);
		expect(
			fixture.moveRef(
				"refs/heads/main",
				fixture.baseCommit,
				fixture.baseCommit,
			),
		).toBe(false);
	} finally {
		fixture.close();
	}
});

test("public landing writes its record before a real temporary-origin CAS", async () => {
	const fixture = await createLandingFixture();
	try {
		const runId = "d".repeat(32);
		const run = fixture.createRunRecord({ runId });
		const candidate = await fixture.createCandidate();
		const result = await publishLanding({
			origin: fixture.origin,
			runDirectory: fixture.runDirectory(runId),
			run,
			candidate,
			filesystem: fixture.filesystem,
			git: fixture.git,
			now: () => 1_780_000_000_010,
		});
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "landed") return;
		expect(result.value.record.status).toBe("landed");
		expect(fixture.readRef("refs/heads/main")).toBe(candidate.commit);
		expect(fixture.readRef(`refs/kogen/incoming/${runId}`)).toBe(null);
		const events = fixture.filesystemFiles.get(
			`${fixture.runDirectory(runId)}/events.jsonl`,
		);
		expect(events).toBeDefined();
		if (events !== undefined) {
			const decoded = decodeJsonLines(events);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				const names = decoded.value.map((value) => {
					if (!isRecord(value) || typeof value.event !== "string")
						throw new Error("journal row has no event name");
					return value.event;
				});
				expect(names.indexOf("landing_prepared")).toBeGreaterThan(-1);
				expect(names.indexOf("landing_prepared")).toBeLessThan(
					names.indexOf("finished"),
				);
			}
		}
	} finally {
		fixture.close();
	}
});

test("shared retry and rebase controllers recover from real lost base CAS effects", async () => {
	const fixture = await createLandingFixture();
	try {
		const runId = "f".repeat(32);
		const run = fixture.createRunRecord({ runId });
		const original = await fixture.createCandidate();
		const competing = await fixture.createCandidate(
			fixture.baseCommit,
			"Competing base movement",
		);
		expect(competing.commit).not.toBe(original.commit);
		let racedCas = false;
		fixture.setGitFault((request) => {
			if (
				!racedCas &&
				request.argv[0] === "update-ref" &&
				request.argv[1] === "refs/heads/main" &&
				request.argv[2] === original.commit
			) {
				racedCas = true;
				if (
					!fixture.moveRef(
						"refs/heads/main",
						fixture.baseCommit,
						competing.commit,
					)
				)
					throw new Error("could not inject competing base CAS");
			}
			return null;
		});

		const waits: number[] = [];
		const retryDelays: number[] = [];
		const attempts: string[] = [];
		const controllerEvents: string[] = [];
		const result = await retryLanding<{ repair: number }>(
			{
				run,
				rung: "R1",
				candidate: original,
				conversation: { id: "R1-winning-build", state: { repair: 0 } },
				allowance: new LandingRepairAllowance(),
			},
			{
				async publish(input) {
					attempts.push(input.candidate.parent);
					return publishLanding({
						origin: fixture.origin,
						runDirectory: fixture.runDirectory(runId),
						run: input.run,
						candidate: input.candidate,
						filesystem: fixture.filesystem,
						git: fixture.git,
						now: () => 1_780_000_000_030 + attempts.length,
					});
				},
				async discardIncoming(input) {
					const ref = `refs/kogen/incoming/${input.runId}`;
					const current = fixture.readRef(ref);
					if (current === null) return success(undefined);
					if (current !== input.candidate.commit)
						return {
							ok: false,
							error: {
								code: "conflict",
								message: "incoming changed in fixture",
								retryable: false,
							},
						};
					return fixture.moveRef(ref, current, "0".repeat(current.length))
						? success(undefined)
						: {
								ok: false,
								error: {
									code: "conflict",
									message: "incoming changed during fixture deletion",
									retryable: false,
								},
							};
				},
				async rebase(input) {
					return rebaseAndVerifyLanding(input, {
						async resolveBase() {
							const commit = fixture.readRef("refs/heads/main");
							if (commit === null)
								return {
									ok: false,
									error: {
										code: "unavailable",
										message: "temporary main ref is missing",
										retryable: false,
									},
								};
							const tree = await fixture.git.command({
								repository: fixture.origin,
								argv: ["rev-parse", `${commit}^{tree}`],
								timeoutMilliseconds: 30_000,
								outputLimitBytes: 128,
							});
							if (!tree.ok || tree.value.exitCode !== 0)
								return {
									ok: false,
									error: {
										code: "unavailable",
										message: "temporary base tree lookup failed",
										retryable: false,
									},
								};
							return success({
								commit,
								tree: new TextDecoder().decode(tree.value.stdout).trim(),
							});
						},
						async rebase({ base }) {
							const head = fixture.readRef("refs/heads/main");
							return success(
								head === base.commit
									? { kind: "ready" as const }
									: { kind: "conflict" as const, paths: ["main"] },
							);
						},
						async guard() {
							return success({ kind: "pass" as const });
						},
						async verify({ base }) {
							return success({
								status: "green" as const,
								tree: base.tree,
								count: 0,
								feedback: "",
							});
						},
						async repair() {
							throw new Error("clean fixture rebase must not repair");
						},
						async commit({ base, verifiedTree }) {
							const candidate = await fixture.createCandidate(base.commit);
							if (candidate.tree !== verifiedTree)
								return {
									ok: false,
									error: {
										code: "unavailable",
										message: "fixture candidate tree mismatch",
										retryable: false,
									},
								};
							return success(candidate);
						},
						async emit(event) {
							controllerEvents.push(event);
						},
					});
				},
				async emit(_event, fields) {
					if (typeof fields.delay_ms === "number")
						retryDelays.push(fields.delay_ms);
				},
				async sleep(milliseconds) {
					waits.push(milliseconds);
				},
			},
		);

		expect(result.kind).toBe("landed");
		if (result.kind !== "landed") return;
		expect(racedCas).toBe(true);
		expect(waits).toEqual([1_000, 2_000, 4_000]);
		expect(retryDelays).toEqual([1_000, 2_000, 4_000]);
		expect(attempts.slice(0, 4)).toEqual(Array(4).fill(fixture.baseCommit));
		expect(attempts[4]).toBe(competing.commit);
		expect(fixture.readRef("refs/heads/main")).toBe(result.candidate.commit);
		expect(fixture.readRef(`refs/kogen/incoming/${runId}`)).toBe(null);
		expect(controllerEvents).toContain("landing_rebase");
	} finally {
		fixture.close();
	}
});

test("recovery publishes the complete crash workspace before removing it", async () => {
	const fixture = await createLandingFixture();
	try {
		const runId = "a".repeat(32);
		const runDirectory = fixture.runDirectory(runId);
		const workspace = await fixture.createWorkspace("r1");
		mkdirSync(join(workspace.path, "untracked"), { mode: 0o755 });
		writeFileSync(join(workspace.path, "untracked", "crash.txt"), "unsaved\n", {
			mode: 0o755,
		});
		symlinkSync("crash.txt", join(workspace.path, "untracked", "link"));
		const record = fixture.createRunRecord({ runId });
		const originalRemove = workspace.remove;
		const orderedWorkspace: RecoveryWorkspaceTarget = {
			...workspace,
			async remove() {
				const snapshot = fixture.filesystemFiles.get(
					`${runDirectory}/run.json`,
				);
				if (snapshot === undefined)
					throw new Error("workspace removed before run.json was durable");
				const parsed = parseRunRecord(snapshot);
				if (!parsed.ok || parsed.value.recovery.length !== 1)
					throw new Error(
						"workspace removed before recovery preservation was recorded",
					);
				return originalRemove();
			},
		};
		const result = await recoverDeadRun({
			record,
			runDirectory,
			origin: fixture.origin,
			latestEvent: null,
			workspaces: [orderedWorkspace],
			filesystem: fixture.filesystem,
			git: fixture.git,
			identity: deadOwner,
			async stopWriters() {
				return { ok: true, value: undefined };
			},
			now: () => 1_780_000_000_000,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("recovered");
		if (result.value.kind !== "recovered") return;
		expect(result.value.outcome).toMatchObject({
			status: "failed",
			reason: "crashed",
		});
		expect(result.value.record.recovery).toHaveLength(1);
		expect(result.value.record.cleanup_pending).toBe(false);
		expect(existsSync(workspace.path)).toBe(false);
		const recoveryRef = result.value.record.recovery[0]?.ref;
		expect(recoveryRef).toBe(`refs/kogen/candidates/${runId}/recovery-r1`);
		const restored = await fixture.git.command({
			repository: fixture.origin,
			argv: ["show", `${recoveryRef}:untracked/crash.txt`],
			timeoutMilliseconds: 30_000,
			outputLimitBytes: 4096,
		});
		expect(restored.ok).toBe(true);
		if (restored.ok)
			expect(new TextDecoder().decode(restored.value.stdout)).toBe("unsaved\n");
		const link = await fixture.git.command({
			repository: fixture.origin,
			argv: ["ls-tree", recoveryRef ?? "", "untracked/link"],
			timeoutMilliseconds: 30_000,
			outputLimitBytes: 4096,
		});
		expect(link.ok).toBe(true);
		if (link.ok)
			expect(new TextDecoder().decode(link.value.stdout)).toContain("120000");
	} finally {
		fixture.close();
	}
});

test("failed recovery-ref publication retains crash bytes and cleanup_pending", async () => {
	const fixture = await createLandingFixture();
	try {
		const runId = "c".repeat(32);
		const runDirectory = fixture.runDirectory(runId);
		const workspace = await fixture.createWorkspace("r1");
		writeFileSync(join(workspace.path, "crash.txt"), "still here\n");
		fixture.setGitFault((request) => {
			if (
				request.argv[0] === "update-ref" &&
				request.argv[1]?.startsWith(`refs/kogen/candidates/${runId}/recovery-`)
			)
				return {
					exitCode: 1,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new TextEncoder().encode("injected create-only ref failure"),
					timedOut: false,
				};
			return null;
		});
		const result = await recoverDeadRun({
			record: fixture.createRunRecord({ runId }),
			runDirectory,
			origin: fixture.origin,
			latestEvent: null,
			workspaces: [workspace],
			filesystem: fixture.filesystem,
			git: fixture.git,
			identity: deadOwner,
			async stopWriters() {
				return { ok: true, value: undefined };
			},
			now: () => 1_780_000_000_001,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("cleanup_pending");
		expect(result.value.record.status).toBe("failed");
		expect(result.value.record.cleanup_pending).toBe(true);
		expect(result.value.record.recovery).toHaveLength(0);
		expect(existsSync(workspace.path)).toBe(true);
		expect(existsSync(join(workspace.path, "crash.txt"))).toBe(true);
		const snapshot = fixture.filesystemFiles.get(`${runDirectory}/run.json`);
		expect(snapshot).toBeDefined();
		if (snapshot !== undefined) {
			const parsed = parseRunRecord(snapshot);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.cleanup_pending).toBe(true);
		}
	} finally {
		fixture.close();
	}
});

test("post-CAS recovery keeps landed status and preserves later workspace bytes", async () => {
	const fixture = await createLandingFixture();
	try {
		const runId = "e".repeat(32);
		const runDirectory = fixture.runDirectory(runId);
		const run = fixture.createRunRecord({ runId });
		const candidate = await fixture.createCandidate();
		const incomingRef = `refs/kogen/incoming/${runId}`;
		fixture.setGitFault((request) => {
			if (
				request.argv[0] === "update-ref" &&
				request.argv[1] === "-d" &&
				request.argv[2] === incomingRef
			)
				return {
					exitCode: 1,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new TextEncoder().encode(
						"injected post-CAS cleanup interruption",
					),
					timedOut: false,
				};
			return null;
		});
		const landed = await publishLanding({
			origin: fixture.origin,
			runDirectory,
			run,
			candidate,
			filesystem: fixture.filesystem,
			git: fixture.git,
			now: () => 1_780_000_000_020,
		});
		expect(landed.ok).toBe(true);
		if (!landed.ok || landed.value.kind !== "landed") return;
		expect(landed.value.record.cleanup_pending).toBe(true);
		expect(fixture.readRef("refs/heads/main")).toBe(candidate.commit);
		expect(fixture.readRef(incomingRef)).toBe(candidate.commit);
		fixture.setGitFault(null);

		const workspace = await fixture.createWorkspace("landed", candidate.commit);
		writeFileSync(join(workspace.path, "after-cas.txt"), "preserve me\n");
		const eventsBytes = fixture.filesystemFiles.get(
			`${runDirectory}/events.jsonl`,
		);
		if (eventsBytes === undefined) throw new Error("landing journal missing");
		const events = decodeJsonLines(eventsBytes);
		if (!events.ok) throw new Error(events.error.message);
		const latest = events.value.at(-1);
		const latestEvent: JournalEvent | null =
			isRecord(latest) &&
			typeof latest.event === "string" &&
			typeof latest.ts === "number"
				? (latest as JournalEvent)
				: null;
		const recovered = await recoverDeadRun({
			record: landed.value.record,
			runDirectory,
			origin: fixture.origin,
			latestEvent,
			workspaces: [workspace],
			filesystem: fixture.filesystem,
			git: fixture.git,
			identity: deadOwner,
			async stopWriters() {
				return { ok: true, value: undefined };
			},
			now: () => 1_780_000_000_021,
		});
		expect(recovered.ok).toBe(true);
		if (!recovered.ok || recovered.value.kind !== "recovered") return;
		expect(recovered.value.outcome).toMatchObject({
			status: "landed",
			reason: "already_terminal",
		});
		expect(recovered.value.record.status).toBe("landed");
		expect(recovered.value.record.cleanup_pending).toBe(false);
		expect(fixture.readRef("refs/heads/main")).toBe(candidate.commit);
		expect(fixture.readRef(incomingRef)).toBe(null);
		expect(existsSync(workspace.path)).toBe(false);
		const recovery = recovered.value.record.recovery[0];
		expect(recovery?.ref).toBe(
			`refs/kogen/candidates/${runId}/recovery-landed`,
		);
		const saved = await fixture.git.command({
			repository: fixture.origin,
			argv: ["show", `${recovery?.ref}:after-cas.txt`],
			timeoutMilliseconds: 30_000,
			outputLimitBytes: 4096,
		});
		expect(saved.ok).toBe(true);
		if (saved.ok)
			expect(new TextDecoder().decode(saved.value.stdout)).toBe(
				"preserve me\n",
			);
	} finally {
		fixture.close();
	}
});
