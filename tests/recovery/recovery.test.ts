import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	GitPort,
	GitRequest,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	FILESYSTEM_PUBLISH_ACTION,
	FILESYSTEM_PUBLISH_HOST_OPERATION,
} from "../../packages/core/src/fs/publish";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
	FileSystemStatus,
} from "../../packages/core/src/fs/read";
import type { PrivateGitRepository } from "../../packages/core/src/git/repository";
import { createPrivateGitRepository } from "../../packages/core/src/git/repository";
import { acquireBuildClaim } from "../../packages/core/src/queue/claim";
import {
	type RecoveryArchivePort,
	type RecoveryWorkspaceTarget,
	recoverDeadRun,
	releaseRecoveryClaimIfOwned,
} from "../../packages/core/src/recovery/recover";
import {
	recoveryOutcomeTransition,
	recoveryOwnerDecision,
	recoveryWorkspaceTransition,
} from "../../packages/core/src/recovery/transition";
import {
	decodeJsonLines,
	type JournalEvent,
} from "../../packages/core/src/run/journal";
import {
	parseRunRecord,
	type RunRecord,
} from "../../packages/core/src/run/store";
import { cloneFreshWorkspace } from "../../packages/core/src/workspace/clone";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const OWNER = { pid: 424242, startedMs: 1_750_000_000_000 } as const;
const RUN_ID = "a".repeat(32);
const tempRoots: string[] = [];
let gitExecutable = "";

beforeAll(() => {
	const git = Bun.which("git");
	if (git === null) throw new Error("Git is not available in PATH");
	gitExecutable = resolve(git);
});

afterAll(() => {
	for (const root of tempRoots.splice(0))
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function testEnvironment(home: string): Record<string, string> {
	return {
		PATH: `${dirname(gitExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
		HOME: home,
		TMPDIR: home,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function git(
	executable: string,
	argv: readonly string[],
	cwd: string,
	home: string,
	stdin?: Uint8Array,
) {
	const result = spawnSync(executable, [...argv], {
		cwd,
		env: testEnvironment(home),
		...(stdin === undefined ? {} : { input: stdin }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: 30_000,
		encoding: "buffer",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`fixture Git failed (${result.status}): ${argv.join(" ")}\n${result.stderr?.toString() ?? ""}`,
		);
	return new Uint8Array(result.stdout ?? []);
}

function makeProcessPort(home: string): ProcessPort {
	return {
		async run(request: ProcessRequest) {
			const executable = request.argv[0];
			if (executable === undefined)
				return {
					ok: false as const,
					error: {
						code: "invalid_input" as const,
						message: "empty argv",
						retryable: false,
					},
				};
			const result = spawnSync(executable, request.argv.slice(1), {
				cwd: request.cwd,
				env: { ...request.env, ...testEnvironment(home) },
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				timeout: request.timeoutMilliseconds,
				encoding: "buffer",
			});
			const error = result.error as NodeJS.ErrnoException | undefined;
			if (error?.code === "ETIMEDOUT") {
				const value: ProcessResult = {
					exitCode: null,
					signal: result.signal ?? null,
					stdout: new Uint8Array(result.stdout ?? []),
					stderr: new Uint8Array(result.stderr ?? []),
					timedOut: true,
				};
				return { ok: true as const, value };
			}
			if (result.error !== undefined)
				return {
					ok: false as const,
					error: {
						code: "unavailable" as const,
						message: result.error.message,
						retryable: false,
					},
				};
			return {
				ok: true as const,
				value: {
					exitCode: result.status,
					signal: result.signal,
					stdout: new Uint8Array(result.stdout ?? []),
					stderr: new Uint8Array(result.stderr ?? []),
					timedOut: false,
				},
			};
		},
	};
}

function makeGitPort(home: string): GitPort {
	return {
		async command(request: GitRequest) {
			const result = spawnSync(gitExecutable, [...request.argv], {
				cwd: request.repository,
				env: testEnvironment(home),
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				timeout: request.timeoutMilliseconds,
				encoding: "buffer",
			});
			const error = result.error as NodeJS.ErrnoException | undefined;
			if (error?.code === "ETIMEDOUT")
				return {
					ok: true as const,
					value: {
						exitCode: null,
						signal: result.signal ?? null,
						stdout: new Uint8Array(result.stdout ?? []),
						stderr: new Uint8Array(result.stderr ?? []),
						timedOut: true,
					},
				};
			if (result.error !== undefined)
				return {
					ok: false as const,
					error: {
						code: "unavailable" as const,
						message: result.error.message,
						retryable: false,
					},
				};
			return {
				ok: true as const,
				value: {
					exitCode: result.status,
					signal: result.signal,
					stdout: new Uint8Array(result.stdout ?? []),
					stderr: new Uint8Array(result.stderr ?? []),
					timedOut: false,
				},
			};
		},
	};
}

class RecoveryFilesystemHost implements FileSystemHostRequest {
	readonly files = new Map<string, Uint8Array>();
	readonly operations: string[] = [];
	readonly failAppendNumber: number | null;
	private appendCount = 0;
	readonly home: string;

	constructor(home: string, failAppendNumber: number | null = null) {
		this.home = home;
		this.failAppendNumber = failAppendNumber;
	}

	async request(operation: number, payload: Uint8Array): Promise<Uint8Array> {
		if (operation === FILESYSTEM_PUBLISH_HOST_OPERATION)
			return this.publish(payload);
		if (operation === FILESYSTEM_HOST_OPERATION)
			return this.readWorkspace(payload);
		throw new Error(`unexpected filesystem operation ${operation}`);
	}

	private publish(payload: Uint8Array): Uint8Array {
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const action = payload[0];
		const rootLength = view.getUint32(4, false);
		const pathLength = view.getUint32(8, false);
		const bytesLength = view.getUint32(12, false);
		const root = decoder.decode(payload.subarray(16, 16 + rootLength));
		const path = decoder.decode(
			payload.subarray(16 + rootLength, 16 + rootLength + pathLength),
		);
		const bytes = payload.subarray(16 + rootLength + pathLength);
		if (bytes.byteLength !== bytesLength)
			throw new Error("malformed publication frame");
		const key = `${root}/${path}`;
		if (action === FILESYSTEM_PUBLISH_ACTION.append) {
			this.appendCount += 1;
			this.operations.push(`append:${path}`);
			if (this.appendCount === this.failAppendNumber)
				return Uint8Array.of(FileSystemStatus.io);
			const old = this.files.get(key) ?? new Uint8Array();
			const next = new Uint8Array(old.byteLength + bytes.byteLength);
			next.set(old);
			next.set(bytes, old.byteLength);
			this.files.set(key, next);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action === FILESYSTEM_PUBLISH_ACTION.atomicWrite) {
			this.operations.push(`atomic:${path}`);
			this.files.set(key, bytes.slice());
			return Uint8Array.of(FileSystemStatus.ok);
		}
		throw new Error(`unexpected filesystem publish action ${String(action)}`);
	}

	private readWorkspace(payload: Uint8Array): Uint8Array {
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const maxBytes = view.getUint32(1, false);
		const rootLength = view.getUint32(9, false);
		const pathLength = view.getUint32(13, false);
		const root = decoder.decode(payload.subarray(17, 17 + rootLength));
		const path = decoder.decode(
			payload.subarray(17 + rootLength, 17 + rootLength + pathLength),
		);
		this.operations.push(`read:${path}`);
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(readFileSync(join(root, path)));
		} catch {
			return Uint8Array.of(FileSystemStatus.notFound);
		}
		if (bytes.byteLength > maxBytes)
			return Uint8Array.of(FileSystemStatus.tooLarge);
		const response = new Uint8Array(bytes.byteLength + 1);
		response.set(bytes, 1);
		return response;
	}
}

interface Fixture {
	readonly root: string;
	readonly origin: string;
	readonly workspace: string;
	readonly runDirectory: string;
	readonly baseCommit: string;
	readonly home: string;
	readonly git: GitPort;
	readonly process: ProcessPort;
	readonly repository: PrivateGitRepository;
	readonly host: RecoveryFilesystemHost;
	readonly record: RunRecord;
	readonly target: RecoveryWorkspaceTarget;
	close(): void;
}

async function fixture(
	options: { readonly failAppendNumber?: number | null } = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "kogen-recovery-"));
	tempRoots.push(root);
	const home = join(root, "home");
	mkdirSync(home, { mode: 0o700 });
	const origin = join(root, "origin");
	mkdirSync(origin, { mode: 0o700 });
	const process = makeProcessPort(home);
	git(gitExecutable, ["init", "--initial-branch=main", "."], origin, home);
	git(gitExecutable, ["config", "user.name", "Recovery fixture"], origin, home);
	git(
		gitExecutable,
		["config", "user.email", "recovery@example.invalid"],
		origin,
		home,
	);
	git(gitExecutable, ["config", "commit.gpgsign", "false"], origin, home);
	writeFileSync(join(origin, ".gitignore"), "*.cache\n");
	writeFileSync(join(origin, "src.txt"), "base\n");
	writeFileSync(join(origin, "delete.txt"), "delete in recovery\n");
	writeFileSync(join(origin, "script.sh"), "#!/bin/sh\necho base\n", {
		mode: 0o644,
	});
	git(gitExecutable, ["add", "-A"], origin, home);
	git(gitExecutable, ["commit", "-m", "base"], origin, home);
	const baseCommit = decoder
		.decode(git(gitExecutable, ["rev-parse", "HEAD"], origin, home))
		.trim();
	const workspace = join(root, "workspace");
	const cloned = await cloneFreshWorkspace(process, {
		sourceRepository: origin,
		destination: workspace,
		baseCommit,
		executable: gitExecutable,
		environment: testEnvironment(home),
	});
	if (!cloned.ok) throw new Error(cloned.error.message);
	git(
		gitExecutable,
		["config", "user.name", "Workspace fixture"],
		workspace,
		home,
	);
	git(
		gitExecutable,
		["config", "user.email", "workspace@example.invalid"],
		workspace,
		home,
	);
	const metadata = join(root, "private-git");
	mkdirSync(metadata, { mode: 0o700 });
	const created = await createPrivateGitRepository(process, {
		sourceRepository: origin,
		gitDirectory: metadata,
		workTree: workspace,
		executable: gitExecutable,
		environment: testEnvironment(home),
	});
	if (!created.ok) throw new Error(created.error.message);
	const host = new RecoveryFilesystemHost(
		home,
		options.failAppendNumber ?? null,
	);
	const runDirectory = "/state/runs/recovery-fixture";
	const record: RunRecord = {
		schema: 2 as const,
		run_id: RUN_ID,
		slug: "greet",
		approval_sha256: "b".repeat(64),
		approval_commit: baseCommit,
		target_branch: "main",
		status: "running",
		landing: null,
		owner_pid: OWNER.pid,
		owner_started_ms: OWNER.startedMs,
		started_ms: 1_740_000_000_000,
		recovery: [],
		cleanup_pending: false,
	};
	const target: RecoveryWorkspaceTarget = {
		id: "r1",
		baseCommit,
		sourceRepository: origin,
		repository: created.value,
		async present() {
			return { ok: true, value: existsSync(workspace) };
		},
		async remove() {
			const snapshot = host.files.get(`${runDirectory}/run.json`);
			if (snapshot === undefined)
				throw new Error("workspace removed before run.json recovery write");
			const parsed = parseRunRecord(snapshot);
			if (
				!parsed.ok ||
				(parsed.value.status === "failed" &&
					parsed.value.recovery.length === 0 &&
					!parsed.value.cleanup_pending)
			)
				throw new Error(
					"workspace removed before preservation or durable failure state",
				);
			rmSync(workspace, { recursive: true, force: true });
			return { ok: true, value: undefined };
		},
	};
	return {
		root,
		origin,
		workspace,
		runDirectory,
		baseCommit,
		home,
		git: makeGitPort(home),
		process,
		repository: created.value,
		host,
		record,
		target,
		close() {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		},
	};
}

function deadIdentity() {
	return {
		current: () => OWNER,
		async inspect() {
			return { ok: true as const, value: { kind: "dead" as const } };
		},
	};
}

function latestEvent(
	host: RecoveryFilesystemHost,
	runDirectory: string,
): JournalEvent | null {
	const bytes = host.files.get(`${runDirectory}/events.jsonl`);
	if (bytes === undefined) return null;
	const decoded = decodeJsonLines(bytes);
	if (!decoded.ok) throw new Error(decoded.error.message);
	const item = decoded.value.at(-1);
	return item !== undefined &&
		item !== null &&
		typeof item === "object" &&
		!Array.isArray(item)
		? (item as JournalEvent)
		: null;
}

function archivePort(): RecoveryArchivePort {
	const complete = new Map<string, { tree: string; archive: string }>();
	const key = (request: {
		readonly runId: string;
		readonly workspace: string;
		readonly base: string;
	}) => `${request.runId}/${request.workspace}/${request.base}`;
	return {
		async listComplete(request) {
			return {
				ok: true,
				value: [...complete.entries()]
					.filter(([entry]) => entry.startsWith(`${key(request)}/`))
					.map(([, value]) => value),
			};
		},
		async publishCreateOnly(request) {
			const identity = `/archives/${request.runId}/${request.workspace}-${request.tree}.kra`;
			complete.set(`${key(request)}/${request.tree}`, {
				tree: request.tree,
				archive: identity,
			});
			return { ok: true, value: identity };
		},
	};
}

function recoveredRequest(
	f: Fixture,
	overrides: Partial<Parameters<typeof recoverDeadRun>[0]> = {},
) {
	return {
		record: f.record,
		runDirectory: f.runDirectory,
		origin: f.origin,
		latestEvent: null,
		workspaces: [f.target],
		filesystem: f.host,
		git: f.git,
		identity: deadIdentity(),
		async stopWriters() {
			return { ok: true as const, value: undefined };
		},
		now: () => 1_780_000_000_000,
		...overrides,
	};
}

function changeWorkspace(f: Fixture, marker = "new") {
	writeFileSync(join(f.workspace, "src.txt"), `${marker}\n`);
	unlinkSync(join(f.workspace, "delete.txt"));
	chmodSync(join(f.workspace, "script.sh"), 0o755);
	symlinkSync("src.txt", join(f.workspace, "shortcut"));
	writeFileSync(join(f.workspace, "new-file.txt"), `${marker} untracked\n`);
	writeFileSync(
		join(f.workspace, "ignored.cache"),
		"must not be snapshotted\n",
	);
}

function decodeRun(f: Fixture): RunRecord {
	const bytes = f.host.files.get(`${f.runDirectory}/run.json`);
	if (bytes === undefined) throw new Error("run.json not written");
	const result = parseRunRecord(bytes);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function listRecoveryRefs(f: Fixture): readonly string[] {
	return decoder
		.decode(
			git(
				gitExecutable,
				[
					"for-each-ref",
					"--format=%(refname)",
					`refs/kogen/candidates/${RUN_ID}/`,
				],
				f.origin,
				f.home,
			),
		)
		.trim()
		.split("\n")
		.filter((line) => line.includes("/recovery-") && line.length > 0);
}

function gitStatus(
	argv: readonly string[],
	cwd: string,
	home: string,
): number | null {
	const result = spawnSync(gitExecutable, [...argv], {
		cwd,
		env: testEnvironment(home),
		encoding: "buffer",
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	return result.status;
}

afterEach(() => {
	for (const root of tempRoots.splice(0))
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

test("owner identity distinguishes live, dead, reused pid, and unknown", () => {
	expect(recoveryOwnerDecision(OWNER, { kind: "dead" })).toBe("stale");
	expect(
		recoveryOwnerDecision(OWNER, { kind: "alive", startedMs: OWNER.startedMs }),
	).toBe("live");
	expect(
		recoveryOwnerDecision(OWNER, {
			kind: "alive",
			startedMs: OWNER.startedMs + 1,
		}),
	).toBe("stale");
	expect(recoveryOwnerDecision(OWNER, { kind: "unknown" })).toBe("unknown");
});

test("draft outcome and workspace transitions retain terminal outcome and require durable capture", () => {
	const run: RunRecord = {
		schema: 2,
		run_id: RUN_ID,
		slug: "greet",
		approval_sha256: "b".repeat(64),
		approval_commit: "c".repeat(40),
		target_branch: "main",
		status: "running" as const,
		landing: null,
		owner_pid: OWNER.pid,
		owner_started_ms: OWNER.startedMs,
		started_ms: 1,
		recovery: [],
		cleanup_pending: false,
	};
	expect(
		recoveryOutcomeTransition({
			record: run,
			lastEvent: "interrupted",
			onBase: false,
		}),
	).toMatchObject({
		status: "failed",
		reason: "interrupted",
	});
	expect(
		recoveryOutcomeTransition({
			record: run,
			lastEvent: "interrupted",
			onBase: true,
		}),
	).toMatchObject({
		status: "landed",
		reason: "reconciled",
	});
	expect(
		recoveryWorkspaceTransition({
			tree: "same",
			baseTree: "same",
			hasMatchingDurableSnapshot: false,
		}),
	).toEqual({ kind: "already_durable" });
	expect(
		recoveryWorkspaceTransition({
			tree: "later",
			baseTree: "base",
			hasMatchingDurableSnapshot: false,
		}),
	).toEqual({ kind: "publish_unverified" });
	expect(
		recoveryWorkspaceTransition({
			tree: "old",
			baseTree: "base",
			hasMatchingDurableSnapshot: true,
		}),
	).toEqual({ kind: "already_durable" });
});

test("dead recovery preserves tracked, untracked, executable, link, and deletion state before cleanup", async () => {
	const f = await fixture();
	changeWorkspace(f);
	let removed = false;
	const request = recoveredRequest(f, {
		async stopWriters() {
			return { ok: true as const, value: undefined };
		},
		workspaces: [
			{
				...f.target,
				async remove() {
					removed = true;
					return f.target.remove();
				},
			},
		],
	});
	const result = await recoverDeadRun(request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value.kind).toBe("recovered");
	expect(removed).toBe(true);
	const final = decodeRun(f);
	expect(final.status).toBe("failed");
	expect(final.cleanup_pending).toBe(false);
	expect(final.recovery).toHaveLength(1);
	expect(final.recovery[0]).toMatchObject({
		workspace: "r1",
		base: f.baseCommit,
		verification: "unverified",
	});
	const artifact = final.recovery[0];
	if (artifact?.ref === null || artifact?.ref === undefined)
		throw new Error("missing create-only recovery ref");
	expect(
		git(gitExecutable, ["show", `${artifact.ref}:src.txt`], f.origin, f.home),
	).toEqual(encoder.encode("new\n"));
	expect(
		gitStatus(
			["cat-file", "-e", `${artifact.ref}:delete.txt`],
			f.origin,
			f.home,
		),
	).toBe(128);
	expect(
		git(
			gitExecutable,
			["show", `${artifact.ref}:new-file.txt`],
			f.origin,
			f.home,
		),
	).toEqual(encoder.encode("new untracked\n"));
	expect(
		git(gitExecutable, ["show", `${artifact.ref}:shortcut`], f.origin, f.home),
	).toEqual(encoder.encode("src.txt"));
	expect(
		decoder.decode(
			git(
				gitExecutable,
				["ls-tree", artifact.ref, "script.sh"],
				f.origin,
				f.home,
			),
		),
	).toStartWith("100755 blob ");
	expect(
		gitStatus(
			["cat-file", "-e", `${artifact.ref}:ignored.cache`],
			f.origin,
			f.home,
		),
	).toBe(128);
	expect(existsSync(f.workspace)).toBe(false);
	const events = f.host.files.get(`${f.runDirectory}/events.jsonl`);
	if (events === undefined) throw new Error("events missing");
	const decoded = decodeJsonLines(events);
	if (!decoded.ok) throw new Error(decoded.error.message);
	expect(
		decoded.value.map((value) => (value as { event?: string }).event),
	).toEqual(["finished", "recovery_preserved"]);
	f.close();
});

test("live owner is untouched; a reused PID is stale and can be recovered", async () => {
	const f = await fixture();
	changeWorkspace(f);
	let stopped = false;
	const live = await recoverDeadRun(
		recoveredRequest(f, {
			identity: {
				current: () => OWNER,
				async inspect() {
					return {
						ok: true as const,
						value: { kind: "alive" as const, startedMs: OWNER.startedMs },
					};
				},
			},
			async stopWriters() {
				stopped = true;
				return { ok: true as const, value: undefined };
			},
		}),
	);
	if (!live.ok) throw new Error(live.error.message);
	expect(live.value.kind).toBe("live_owner");
	expect(stopped).toBe(false);
	expect(f.host.files.size).toBe(0);
	const reused = await recoverDeadRun(
		recoveredRequest(f, {
			identity: {
				current: () => ({ pid: 998877, startedMs: OWNER.startedMs + 10 }),
				async inspect() {
					return {
						ok: true as const,
						value: { kind: "alive" as const, startedMs: OWNER.startedMs + 10 },
					};
				},
			},
		}),
	);
	if (!reused.ok) throw new Error(reused.error.message);
	expect(reused.value.kind).toBe("recovered");
	expect(decodeRun(f).recovery).toHaveLength(1);
	f.close();
});

test("recovery adopts a ref after a run-record append failure and retains later progress separately", async () => {
	const f = await fixture({ failAppendNumber: 2 });
	changeWorkspace(f, "first");
	const first = await recoverDeadRun(recoveredRequest(f));
	if (!first.ok) throw new Error(first.error.message);
	expect(first.value.kind).toBe("cleanup_pending");
	expect(decodeRun(f).cleanup_pending).toBe(true);
	expect(decodeRun(f).recovery).toHaveLength(0);
	expect(listRecoveryRefs(f)).toHaveLength(1);
	writeFileSync(
		join(f.workspace, "later.txt"),
		"repair progress after the first snapshot\n",
	);
	const retry = await recoverDeadRun(
		recoveredRequest(f, {
			record: decodeRun(f),
			latestEvent: latestEvent(f.host, f.runDirectory),
			recordedOutcome: { status: "failed", reason: "crashed" },
		}),
	);
	if (!retry.ok) throw new Error(retry.error.message);
	expect(retry.value.kind).toBe("recovered");
	expect(listRecoveryRefs(f)).toHaveLength(2);
	expect(decodeRun(f).recovery).toHaveLength(2);
	expect(decodeRun(f).cleanup_pending).toBe(false);
	const refs = listRecoveryRefs(f);
	expect(refs[0]).toContain("recovery-r1");
	expect(refs[1]).toContain("recovery-r1-");
	f.close();
});

test("failed ref and archive preservation retains the workspace and retries terminal cleanup", async () => {
	const f = await fixture();
	changeWorkspace(f);
	const acquired = await acquireBuildClaim(
		f.git,
		f.origin,
		RUN_ID,
		OWNER,
		async () => ({ ok: true, value: "stale" }),
	);
	if (!acquired.ok || acquired.value.kind !== "acquired")
		throw new Error("could not install fixture claim");
	const failingGit: GitPort = {
		async command(request) {
			if (
				request.argv[0] === "update-ref" &&
				request.argv[1]?.includes("/recovery-")
			)
				return {
					ok: true,
					value: {
						exitCode: 1,
						signal: null,
						stdout: new Uint8Array(),
						stderr: encoder.encode("rejected"),
						timedOut: false,
					},
				};
			return f.git.command(request);
		},
	};
	let removed = false;
	const failed = await recoverDeadRun(
		recoveredRequest(f, {
			git: failingGit,
			workspaces: [
				{
					...f.target,
					async remove() {
						removed = true;
						return f.target.remove();
					},
				},
			],
		}),
	);
	if (!failed.ok) throw new Error(failed.error.message);
	expect(failed.value.kind).toBe("cleanup_pending");
	expect(removed).toBe(false);
	expect(existsSync(f.workspace)).toBe(true);
	expect(decodeRun(f).status).toBe("failed");
	expect(decodeRun(f).cleanup_pending).toBe(true);
	expect(decodeRun(f).recovery).toHaveLength(0);
	expect(
		gitStatus(
			["rev-parse", "--verify", "--quiet", "refs/kogen/claim"],
			f.origin,
			f.home,
		),
	).toBe(1);

	const archives = archivePort();
	const otherRunId = "c".repeat(32);
	const otherClaim = await acquireBuildClaim(
		f.git,
		f.origin,
		otherRunId,
		OWNER,
		async () => ({ ok: true, value: "stale" }),
	);
	if (!otherClaim.ok || otherClaim.value.kind !== "acquired")
		throw new Error("could not install replacement claim");
	const archived = await recoverDeadRun(
		recoveredRequest(f, {
			record: decodeRun(f),
			latestEvent: latestEvent(f.host, f.runDirectory),
			recordedOutcome: { status: "failed", reason: "crashed" },
			git: failingGit,
			archive: archives,
			workspaces: [
				{
					...f.target,
					async remove() {
						removed = true;
						return f.target.remove();
					},
				},
			],
		}),
	);
	if (!archived.ok) throw new Error(archived.error.message);
	if (archived.value.kind !== "recovered")
		throw new Error(`archive retry did not recover: ${archived.value.kind}`);
	if (failed.value.kind !== "cleanup_pending")
		throw new Error(
			`initial preservation did not stay pending: ${failed.value.kind}`,
		);
	expect(archived.value.outcome).toEqual(failed.value.outcome);
	expect(removed).toBe(true);
	expect(decodeRun(f).cleanup_pending).toBe(false);
	expect(decodeRun(f).recovery).toHaveLength(1);
	expect(decodeRun(f).recovery[0]?.tree).toBeNull();
	expect(decodeRun(f).recovery[0]?.ref).toBeNull();
	expect(decodeRun(f).recovery[0]?.archive).toStartWith(
		`/archives/${RUN_ID}/r1-`,
	);
	expect(
		git(gitExecutable, ["rev-parse", "refs/kogen/claim"], f.origin, f.home),
	).toEqual(encoder.encode(`${otherClaim.value.claim.commit}\n`));
	expect(await releaseRecoveryClaimIfOwned(f.git, f.origin, RUN_ID)).toEqual({
		ok: true,
		value: "not_owner",
	});
	f.close();
});

test("post-CAS recovery stays landed, preserves later workspace progress, and only removes its incoming ref", async () => {
	const f = await fixture();
	writeFileSync(join(f.workspace, "candidate.txt"), "landed candidate\n");
	git(gitExecutable, ["add", "-A"], f.workspace, f.home);
	git(gitExecutable, ["commit", "-m", "candidate"], f.workspace, f.home);
	const candidate = decoder
		.decode(git(gitExecutable, ["rev-parse", "HEAD"], f.workspace, f.home))
		.trim();
	const tree = decoder
		.decode(
			git(gitExecutable, ["rev-parse", "HEAD^{tree}"], f.workspace, f.home),
		)
		.trim();
	git(
		gitExecutable,
		["fetch", "--no-tags", f.workspace, candidate],
		f.origin,
		f.home,
	);
	git(
		gitExecutable,
		["update-ref", "refs/heads/main", candidate],
		f.origin,
		f.home,
	);
	git(
		gitExecutable,
		["update-ref", `refs/kogen/incoming/${RUN_ID}`, candidate],
		f.origin,
		f.home,
	);
	git(
		gitExecutable,
		["update-ref", `refs/kogen/candidates/${RUN_ID}/R1`, candidate],
		f.origin,
		f.home,
	);
	writeFileSync(
		join(f.workspace, "post-cas.txt"),
		"progress after publication\n",
	);
	const running: RunRecord = {
		...f.record,
		landing: {
			approval_commit: f.baseCommit,
			run_id: RUN_ID,
			expected_parent: f.baseCommit,
			final_tree: tree,
			candidate_commit: candidate,
		},
	};
	const result = await recoverDeadRun(
		recoveredRequest(f, {
			record: running,
			latestEvent: {
				event: "landing_prepared",
				ts: 1_780_000_000_000,
				landing: null,
			},
		}),
	);
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.kind !== "recovered")
		throw new Error(`post-CAS recovery did not complete: ${result.value.kind}`);
	expect(result.value.outcome.status).toBe("landed");
	expect(decodeRun(f).status).toBe("landed");
	expect(decodeRun(f).recovery).toHaveLength(1);
	expect(listRecoveryRefs(f)).toHaveLength(1);
	const incoming = spawnSync(
		gitExecutable,
		["rev-parse", "--verify", "--quiet", `refs/kogen/incoming/${RUN_ID}`],
		{
			cwd: f.origin,
			env: testEnvironment(f.home),
			encoding: "buffer",
		},
	);
	expect(incoming.status).toBe(1);
	expect(
		git(gitExecutable, ["rev-parse", "refs/heads/main"], f.origin, f.home),
	).toEqual(encoder.encode(`${candidate}\n`));
	expect(
		git(
			gitExecutable,
			["show", `${decodeRun(f).recovery[0]?.ref}:post-cas.txt`],
			f.origin,
			f.home,
		),
	).toEqual(encoder.encode("progress after publication\n"));
	expect(existsSync(f.workspace)).toBe(false);
	f.close();
});
