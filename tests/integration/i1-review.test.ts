import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalProcess } from "../../packages/cli/src/approval-process";
import { createApprovalWorkspace } from "../../packages/cli/src/approval-workspace";
import {
	type ControllerRuntime,
	createControllerRuntime,
} from "../../packages/cli/src/composition";
import { classifyCliException } from "../../packages/cli/src/errors";
import {
	inspectOwnerPid,
	readStatusRuns,
} from "../../packages/cli/src/status-runs";
import type { ProcessPort } from "../../packages/core/src/contracts/ports";
import { HostBridgeError } from "../../packages/core/src/process/host";
import type { RunRecord } from "../../packages/core/src/run/store";

const roots: string[] = [];
let runtime: ControllerRuntime;
let nativeRoot = "";
beforeAll(async () => {
	nativeRoot = mkdtempSync(join(tmpdir(), "kogen-i1-native-"));
	const built = spawnSync(
		process.execPath,
		["--no-install", "tools/build-foundation.ts", nativeRoot],
		{ cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 30_000 },
	);
	if (built.status !== 0) throw new Error(built.stderr);
	runtime = await createControllerRuntime(join(nativeRoot, "kogen"));
}, 30_000);
afterAll(async () => {
	if (runtime) await runtime.close();
	if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true });
});
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; directory: string; record: RunRecord } {
	const root = mkdtempSync(join(tmpdir(), "kogen-i1-review-"));
	roots.push(root);
	const runId = "a".repeat(32);
	const directory = join(root, "runs", runId);
	mkdirSync(directory, { recursive: true });
	const commit = "b".repeat(40);
	const record: RunRecord = {
		schema: 2,
		run_id: runId,
		slug: "sample",
		approval_sha256: "c".repeat(64),
		approval_commit: commit,
		target_branch: "main",
		status: "running",
		landing: {
			approval_commit: commit,
			run_id: runId,
			expected_parent: commit,
			final_tree: "d".repeat(40),
			candidate_commit: "e".repeat(40),
		},
		owner_pid: process.pid,
		owner_started_ms: Date.now(),
		started_ms: Date.now(),
		recovery: [
			{
				workspace: "/tmp/workspace",
				base: commit,
				tree: "d".repeat(40),
				ref: `refs/kogen/candidates/${runId}/recovery-workspace`,
				archive: null,
				verification: "unverified",
			},
		],
		cleanup_pending: true,
	};
	writeFileSync(join(directory, "run.json"), `${JSON.stringify(record)}\n`);
	return { root, directory, record };
}

test("status keeps the parsed landing, recovery and cleanup obligation for a live owner", async () => {
	const { root, directory, record } = fixture();
	writeFileSync(
		join(directory, "events.jsonl"),
		'{"event":"started","ts":1}\n',
	);
	const runs = await readStatusRuns(root, async () => ({
		kind: "alive",
		startedMs: record.owner_started_ms,
	}));
	expect(runs).toHaveLength(1);
	expect(runs[0]?.record).toEqual(record);
	expect(runs[0]?.ownerLiveness).toBe("live");
	expect(
		(
			await readStatusRuns(root, async () => ({
				kind: "alive",
				startedMs: record.owner_started_ms + 10_000,
			}))
		)[0]?.ownerLiveness,
	).toBe("dead");
	expect(
		(await readStatusRuns(root, async () => ({ kind: "unknown" })))[0]
			?.ownerLiveness,
	).toBe("unknown");
});

test("status retains valid events and snapshot after a torn journal tail", async () => {
	const { root, directory, record } = fixture();
	writeFileSync(
		join(directory, "events.jsonl"),
		'{"event":"started","ts":1}\n{"event":"unfinished"',
	);
	const runs = await readStatusRuns(root, async () => ({ kind: "dead" }));
	expect(runs).toHaveLength(1);
	expect(runs[0]?.record).toEqual(record);
	expect(runs[0]?.events.map((event) => event.event)).toEqual(["started"]);
	expect(runs[0]?.journalIncompleteTail).toBe(true);
	writeFileSync(
		join(directory, "events.jsonl"),
		'{"event":"started","ts":1}\n{"event":"finished","ts":2}',
	);
	const withoutTerminator = await readStatusRuns(root, async () => ({
		kind: "dead",
	}));
	expect(withoutTerminator[0]?.events.map((event) => event.event)).toEqual([
		"started",
	]);
});

test("status reads frozen snapshots that omit v1.3 recovery defaults", async () => {
	const { root, directory, record } = fixture();
	const {
		recovery: _recovery,
		cleanup_pending: _cleanupPending,
		...legacy
	} = record;
	writeFileSync(join(directory, "run.json"), `${JSON.stringify(legacy)}\n`);
	writeFileSync(
		join(directory, "events.jsonl"),
		'{"event":"finished","ts":1,"reason":"repair_cap"}\n',
	);
	const runs = await readStatusRuns(root, async () => ({ kind: "unknown" }));
	expect(runs[0]?.record.recovery).toEqual([]);
	expect(runs[0]?.record.cleanup_pending).toBe(false);
});

test("owner inspection reads the actual PID start identity", async () => {
	const observation = await inspectOwnerPid(process.pid);
	expect(observation.kind).toBe("alive");
	if (observation.kind === "alive")
		expect(Math.abs(observation.startedMs - Date.now())).toBeLessThan(60_000);
});

test("unexpected exceptions use bug exit while typed host failures retain exit 3", () => {
	const bug = classifyCliException(new TypeError("broken invariant"));
	expect(bug.exitCode).toBe(70);
	expect(bug.stdout).toBe("controller/internal_error: broken invariant\n");
	expect(
		classifyCliException(new HostBridgeError("helper unavailable")).exitCode,
	).toBe(3);
});

test("approval project commands use the macOS and Linux confinement wrappers", async () => {
	const root = mkdtempSync(join(tmpdir(), "kogen-i1-sandbox-"));
	roots.push(root);
	const checkout = join(root, "checkout"),
		origin = join(root, "origin");
	const workspace = join(root, "workspace"),
		runDirectory = join(root, "run");
	for (const path of [checkout, origin, workspace, runDirectory])
		mkdirSync(path);
	const seen: string[][] = [];
	const raw: Pick<ProcessPort, "run"> = {
		async run(request) {
			seen.push([...request.argv]);
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const command = {
		argv: ["/usr/bin/true"],
		cwd: workspace,
		env: { PATH: "/usr/bin:/bin" },
		timeoutMilliseconds: 1000,
		outputLimitBytes: 1024,
	};
	const shared = {
		raw,
		enabled: true,
		hostEnvironment: {},
		checkout,
		origin,
		workspace,
		runDirectory,
		home: root,
	};
	await createApprovalProcess({
		...shared,
		platform: "darwin",
		probe: { available: true },
	}).process.run(command);
	expect(seen[0]?.slice(0, 3)).toEqual([
		"/usr/bin/sandbox-exec",
		"-f",
		join(runDirectory, "approval.sb"),
	]);
	await createApprovalProcess({
		...shared,
		platform: "linux",
		probe: { available: true, bwrapPath: "/usr/bin/bwrap" },
	}).process.run(command);
	expect(seen[1]?.[0]).toBe("/usr/bin/bwrap");
	const missing = await createApprovalProcess({
		...shared,
		platform: "darwin",
		probe: { available: true },
	}).process.run({ ...command, argv: ["kogen-conformance-missing-tool"] });
	expect(missing.ok && missing.value.exitCode).toBe(127);
	expect(seen).toHaveLength(2);
});

test("approval rejects a clone whose materialized bytes differ from the resolved base tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "kogen-i1-tree-"));
	roots.push(root);
	const origin = join(root, "origin"),
		scratchRoot = join(root, "scratch");
	mkdirSync(origin);
	mkdirSync(scratchRoot);
	const git = (...argv: string[]) => {
		const result = spawnSync("git", ["-C", origin, ...argv], {
			encoding: "utf8",
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(origin, "base.txt"), "expected\n");
	git("add", "base.txt");
	git("commit", "-qm", "base");
	const baseCommit = git("rev-parse", "HEAD"),
		expectedTree = git("rev-parse", "HEAD^{tree}");
	const processPort: Pick<ProcessPort, "run"> = {
		async run(request) {
			const result = await runtime.process.run(request);
			if (
				result.ok &&
				request.argv.includes("checkout") &&
				request.argv.includes("--detach")
			)
				writeFileSync(join(scratchRoot, "base-sample", "base.txt"), "wrong\n");
			return result;
		},
	};
	const workspace = createApprovalWorkspace(
		origin,
		origin,
		processPort,
		runtime.filesystemHost,
		".",
	);
	const scratch = await workspace.createScratch({
		baseCommit,
		expectedTree,
		scratchRoot,
		slug: "sample",
	});
	if (!scratch.ok) throw new Error(scratch.error.message);
	expect(scratch.value.baseTree).not.toBe(expectedTree);
	expect((await scratch.value.tree.snapshot()).ok).toBe(true);
}, 30_000);
