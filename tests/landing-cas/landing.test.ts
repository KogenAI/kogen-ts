import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandingCommit } from "../../packages/core/src/build/landing/commit";
import { createLandingCommit } from "../../packages/core/src/build/landing/commit";
import { publishLanding } from "../../packages/core/src/build/landing/publish";
import {
	initialLandingState,
	landingTransition,
} from "../../packages/core/src/build/landing/transition";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
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
import { createPublicGitPort } from "../../packages/core/src/git/command";
import {
	createPrivateGitRepository,
	type PrivateGitRepository,
} from "../../packages/core/src/git/repository";
import {
	parseRunRecord,
	type RunRecord,
} from "../../packages/core/src/run/store";
import { snapshotWorkspace } from "../../packages/core/src/workspace/snapshot";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RUN_ID = "a".repeat(32);
const INTENT = ".kogen/intents/greet/intent.md";
const ACCEPTANCE = ".kogen/acceptance/greet.t.sh";

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function testEnvironment(
	home: string,
	globalConfig: string,
): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: home,
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function makeProcessPort(): ProcessPort {
	return {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			const executable = request.argv[0];
			if (executable === undefined)
				return { ok: false, error: portError("invalid_input", "empty argv") };
			const result = spawnSync(executable, request.argv.slice(1), {
				cwd: request.cwd,
				env: { ...request.env },
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				timeout: request.timeoutMilliseconds,
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				encoding: "buffer",
			});
			const spawnError = result.error as NodeJS.ErrnoException | undefined;
			if (spawnError?.code === "ETIMEDOUT")
				return {
					ok: true,
					value: {
						exitCode: null,
						signal: result.signal ?? null,
						stdout: result.stdout ?? new Uint8Array(),
						stderr: result.stderr ?? new Uint8Array(),
						timedOut: true,
					},
				};
			if (result.error !== undefined)
				return {
					ok: false,
					error: portError("unavailable", result.error.message),
				};
			return {
				ok: true,
				value: {
					exitCode: result.status,
					signal: result.signal,
					stdout: result.stdout ?? new Uint8Array(),
					stderr: result.stderr ?? new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
}

class TestFilesystemHost implements FileSystemHostRequest {
	readonly files = new Map<string, Uint8Array>();
	readonly operations: string[];
	readonly failAtomicAt: number | null;
	private atomicWrites = 0;

	constructor(operations: string[], failAtomicAt: number | null = null) {
		this.operations = operations;
		this.failAtomicAt = failAtomicAt;
	}

	async request(operation: number, payload: Uint8Array): Promise<Uint8Array> {
		if (operation === FILESYSTEM_HOST_OPERATION) return this.read(payload);
		if (operation === FILESYSTEM_PUBLISH_HOST_OPERATION)
			return this.publish(payload);
		throw new Error(`unexpected filesystem operation ${operation}`);
	}

	private read(payload: Uint8Array): Uint8Array {
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
		const key = `${root}/${path}`;
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(readFileSync(join(root, path)));
		} catch {
			const saved = this.files.get(key);
			if (saved === undefined) return Uint8Array.of(FileSystemStatus.notFound);
			bytes = saved;
		}
		if (bytes.byteLength > maxBytes)
			return Uint8Array.of(FileSystemStatus.tooLarge);
		const response = new Uint8Array(bytes.byteLength + 1);
		response.set(bytes, 1);
		return response;
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
		const value = payload.subarray(16 + rootLength + pathLength);
		if (value.byteLength !== bytesLength) throw new Error("bad fixture frame");
		const key = `${root}/${path}`;
		if (action === FILESYSTEM_PUBLISH_ACTION.append) {
			this.operations.push(`append:${path}`);
			const before = this.files.get(key) ?? new Uint8Array();
			const after = new Uint8Array(before.byteLength + value.byteLength);
			after.set(before);
			after.set(value, before.byteLength);
			this.files.set(key, after);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action === FILESYSTEM_PUBLISH_ACTION.atomicWrite) {
			this.operations.push(`atomic:${path}`);
			this.atomicWrites += 1;
			if (this.atomicWrites === this.failAtomicAt)
				return Uint8Array.of(FileSystemStatus.io);
			this.files.set(key, value.slice());
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action === FILESYSTEM_PUBLISH_ACTION.remove) {
			this.files.delete(key);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		throw new Error(`unexpected publish action ${action}`);
	}

	readPublished(root: string, path: string): Uint8Array | undefined {
		return this.files.get(`${root}/${path}`);
	}
}

interface Fixture {
	readonly root: string;
	readonly home: string;
	readonly origin: string;
	readonly workspace: string;
	readonly runDirectory: string;
	readonly baseCommit: string;
	readonly process: ProcessPort;
	readonly git: GitPort;
	readonly privateGit: PrivateGitRepository;
	readonly host: TestFilesystemHost;
	readonly run: RunRecord;
	readonly candidate: LandingCommit;
	readonly operations: string[];
	close(): void;
}

async function gitText(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
): Promise<string> {
	const result = await git.command({
		repository,
		argv,
		...(stdin === undefined ? {} : { stdin }),
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 900 * 1024,
	});
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.timedOut || result.value.exitCode !== 0)
		throw new Error(
			`git ${argv[0]} failed with exit ${String(result.value.exitCode)}: ${decoder.decode(result.value.stderr)}`,
		);
	return decoder.decode(result.value.stdout);
}

async function createFixture(
	options: {
		readonly objectFormat?: "sha1" | "sha256";
		readonly failAtomicAt?: number;
	} = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "kogen-landing-cas-"));
	const home = join(root, "home");
	const origin = join(root, "origin");
	const workspace = join(root, "workspace");
	const metadata = join(root, "private-git");
	const runDirectory = join(root, "runs", RUN_ID);
	const hooks = join(root, "global-hooks");
	for (const directory of [home, origin, hooks, join(root, "runs")])
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	const globalConfig = join(home, ".gitconfig");
	writeFileSync(
		globalConfig,
		`[user]\n\tname = Public Test User\n\temail = public@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = ${hooks}\n`,
		{ mode: 0o600 },
	);
	const hookMarker = join(root, "hook-ran");
	writeFileSync(
		join(hooks, "pre-commit"),
		`#!/bin/sh\ntouch '${hookMarker}'\n`,
		{
			mode: 0o700,
		},
	);
	const process = makeProcessPort();
	const executable = Bun.which("git");
	if (executable === null) throw new Error("Git is unavailable");
	const baseEnvironment = testEnvironment(home, globalConfig);
	const git = createPublicGitPort(process, {
		executable,
		environment: baseEnvironment,
	});
	await gitText(git, origin, [
		"init",
		"--initial-branch=main",
		...(options.objectFormat === undefined
			? []
			: [`--object-format=${options.objectFormat}`]),
		".",
	]);
	writeFileSync(join(origin, "source.txt"), "base\n", { mode: 0o600 });
	await gitText(git, origin, ["add", "-A"]);
	await gitText(git, origin, ["commit", "-m", "base"]);
	const baseCommit = (await gitText(git, origin, ["rev-parse", "HEAD"])).trim();
	await gitText(git, root, ["clone", "--no-hardlinks", origin, workspace]);
	mkdirSync(metadata, { mode: 0o700 });
	const privateResult = await createPrivateGitRepository(process, {
		sourceRepository: origin,
		gitDirectory: metadata,
		workTree: workspace,
		executable,
		environment: baseEnvironment,
	});
	if (!privateResult.ok) throw new Error(privateResult.error.message);
	writeFileSync(join(workspace, "source.txt"), "verified candidate\n", {
		mode: 0o600,
	});
	mkdirSync(join(workspace, ".kogen", "intents", "greet"), { recursive: true });
	mkdirSync(join(workspace, ".kogen", "acceptance"), { recursive: true });
	writeFileSync(join(workspace, INTENT), "approved intent\n", { mode: 0o600 });
	writeFileSync(join(workspace, ACCEPTANCE), "approved test\n", {
		mode: 0o600,
	});
	const operations: string[] = [];
	const host = new TestFilesystemHost(operations, options.failAtomicAt ?? null);
	const snapshot = await snapshotWorkspace({
		repository: privateResult.value,
		sourceRepository: origin,
		baseCommit,
		filesystem: host,
	});
	if (!snapshot.ok) throw new Error(snapshot.error.message);
	const commit = await createLandingCommit({
		origin,
		runId: RUN_ID,
		slug: "greet",
		title: "Greet by name",
		expectedParent: baseCommit,
		verifiedTree: snapshot.value.tree,
		source: privateResult.value,
		git,
	});
	if (!commit.ok) throw new Error(commit.error.message);
	const run: RunRecord = {
		schema: 2,
		run_id: RUN_ID,
		slug: "greet",
		approval_sha256: "b".repeat(64),
		approval_commit: baseCommit,
		target_branch: "main",
		status: "running",
		landing: null,
		owner_pid: 100,
		owner_started_ms: 1_800_000_000_000,
		started_ms: 1_800_000_000_001,
		recovery: [],
		cleanup_pending: false,
	};
	return {
		root,
		home,
		origin,
		workspace,
		runDirectory,
		baseCommit,
		process,
		git,
		privateGit: privateResult.value,
		host,
		run,
		candidate: commit.value,
		operations,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function recordingGit(
	fixture: Fixture,
	options: {
		readonly failBaseCas?: boolean;
		readonly failIncomingDelete?: boolean;
		readonly editBeforeBaseCas?: boolean;
	} = {},
): GitPort {
	return {
		async command(request: GitRequest) {
			fixture.operations.push(`git:${request.argv.join(" ")}`);
			if (
				options.editBeforeBaseCas &&
				request.argv[0] === "update-ref" &&
				request.argv[1] === "refs/heads/main"
			) {
				options = { ...options, editBeforeBaseCas: false };
				writeFileSync(
					join(fixture.origin, "source.txt"),
					"concurrent user edit\n",
				);
			}
			if (
				options.failBaseCas &&
				request.argv[0] === "update-ref" &&
				request.argv[1] === "refs/heads/main"
			)
				return {
					ok: true as const,
					value: {
						exitCode: 1,
						signal: null,
						stdout: new Uint8Array(),
						stderr: encoder.encode("simulated lost base CAS\n"),
						timedOut: false,
					},
				};
			if (
				options.failIncomingDelete &&
				request.argv[0] === "update-ref" &&
				request.argv[1] === "-d" &&
				request.argv[2]?.startsWith("refs/kogen/incoming/")
			)
				return {
					ok: true as const,
					value: {
						exitCode: 1,
						signal: null,
						stdout: new Uint8Array(),
						stderr: encoder.encode("simulated cleanup failure\n"),
						timedOut: false,
					},
				};
			return fixture.git.command(request);
		},
	};
}

async function publish(
	fixture: Fixture,
	git: Pick<GitPort, "command"> = recordingGit(fixture),
): Promise<Awaited<ReturnType<typeof publishLanding>>> {
	return publishLanding({
		origin: fixture.origin,
		runDirectory: fixture.runDirectory,
		run: fixture.run,
		candidate: fixture.candidate,
		filesystem: fixture.host,
		git,
		now: () => 1_800_000_000_100,
	});
}

async function refText(fixture: Fixture, ref: string): Promise<string> {
	const result = await fixture.git.command({
		repository: fixture.origin,
		argv: ["rev-parse", "--verify", "--quiet", ref],
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 1024,
	});
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.exitCode !== 0) return "";
	return decoder.decode(result.value.stdout).trim();
}

test.each([
	"sha1",
	"sha256",
] as const)("creates a sole-parent verified-tree commit and lands it on %s with public identity", async (objectFormat) => {
	const fixture = await createFixture({ objectFormat });
	try {
		const result = await publish(fixture);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("landed");
		if (result.value.kind !== "landed") return;
		const expectedLength = objectFormat === "sha1" ? 40 : 64;
		expect(result.value.candidateCommit).toHaveLength(expectedLength);
		expect(await refText(fixture, "refs/heads/main")).toBe(
			fixture.candidate.commit,
		);
		expect(await refText(fixture, result.value.incomingRef)).toBe("");
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show",
				"-s",
				"--format=%P",
				fixture.candidate.commit,
			]),
		).toBe(`${fixture.baseCommit}\n`);
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show",
				"-s",
				"--format=%T",
				fixture.candidate.commit,
			]),
		).toBe(`${fixture.candidate.tree}\n`);
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show",
				"-s",
				"--format=%B",
				fixture.candidate.commit,
			]),
		).toBe("Greet by name\n\nKogen-Intent: greet\n\n");
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show",
				"-s",
				"--format=%an <%ae>",
				fixture.candidate.commit,
			]),
		).toBe("Public Test User <public@example.invalid>\n");
		expect(
			await gitText(fixture.git, fixture.origin, ["status", "--porcelain"]),
		).toBe("");
		expect(existsSync(join(fixture.root, "hook-ran"))).toBe(false);
		expect(result.value.record.status).toBe("landed");
		expect(result.value.record.landing).toMatchObject({
			expected_parent: fixture.baseCommit,
			final_tree: fixture.candidate.tree,
			candidate_commit: fixture.candidate.commit,
		});
		expect(readFileSync(join(fixture.origin, "source.txt"), "utf8")).toBe(
			"verified candidate\n",
		);
		expect(readFileSync(join(fixture.origin, INTENT), "utf8")).toBe(
			"approved intent\n",
		);
		expect(readFileSync(join(fixture.origin, ACCEPTANCE), "utf8")).toBe(
			"approved test\n",
		);
		const events = fixture.host.readPublished(
			fixture.runDirectory,
			"events.jsonl",
		);
		expect(events).toBeDefined();
		if (events === undefined) return;
		expect(
			decoder
				.decode(events)
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { readonly event: string }).event),
		).toEqual(["commit_result", "landing_prepared", "finished"]);
		expect(fixture.host.operations.indexOf("append:events.jsonl")).toBeLessThan(
			fixture.operations.findIndex((operation) =>
				operation.startsWith("git:update-ref refs/kogen/incoming/"),
			),
		);
		expect(fixture.host.operations.indexOf("atomic:run.json")).toBeLessThan(
			fixture.operations.findIndex((operation) =>
				operation.startsWith("git:update-ref refs/kogen/incoming/"),
			),
		);
	} finally {
		fixture.close();
	}
});

test("public commit signing configuration is forwarded to commit-tree", async () => {
	const fixture = await createFixture();
	try {
		let commitTreeArgv: readonly string[] | null = null;
		const git: Pick<GitPort, "command"> = {
			async command(request) {
				if (
					request.argv[0] === "config" &&
					request.argv.includes("commit.gpgsign")
				)
					return {
						ok: true as const,
						value: {
							exitCode: 0,
							signal: null,
							stdout: encoder.encode("true\n"),
							stderr: new Uint8Array(),
							timedOut: false,
						},
					};
				if (request.argv[0] === "commit-tree") {
					commitTreeArgv = request.argv;
					return {
						ok: true as const,
						value: {
							exitCode: 1,
							signal: null,
							stdout: new Uint8Array(),
							stderr: encoder.encode("simulated signing failure\n"),
							timedOut: false,
						},
					};
				}
				return fixture.git.command(request);
			},
		};
		const result = await createLandingCommit({
			origin: fixture.origin,
			runId: RUN_ID,
			slug: "greet",
			title: "Greet by name",
			expectedParent: fixture.baseCommit,
			verifiedTree: fixture.candidate.tree,
			git,
		});
		expect(result.ok).toBe(false);
		expect(commitTreeArgv).not.toBeNull();
		if (commitTreeArgv === null) throw new Error("commit-tree was not called");
		expect(commitTreeArgv[1] === "-S").toBe(true);
	} finally {
		fixture.close();
	}
});

test("a base CAS interruption leaves the durable landing record and incoming ref for recovery", async () => {
	const fixture = await createFixture({ objectFormat: "sha256" });
	try {
		const result = await publish(
			fixture,
			recordingGit(fixture, { failBaseCas: true }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("durable landing record");
		expect(await refText(fixture, "refs/heads/main")).toBe(fixture.baseCommit);
		expect(await refText(fixture, `refs/kogen/incoming/${RUN_ID}`)).toBe(
			fixture.candidate.commit,
		);
		const runBytes = fixture.host.readPublished(
			fixture.runDirectory,
			"run.json",
		);
		expect(runBytes).toBeDefined();
		if (runBytes === undefined) return;
		const parsed = parseRunRecord(runBytes);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.landing).toMatchObject({
			expected_parent: fixture.baseCommit,
			final_tree: fixture.candidate.tree,
			candidate_commit: fixture.candidate.commit,
		});
	} finally {
		fixture.close();
	}
});

test("a run snapshot failure prevents incoming publication after the prepared event", async () => {
	const fixture = await createFixture({
		objectFormat: "sha256",
		failAtomicAt: 2,
	});
	try {
		const result = await publish(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("Could not durably record landing");
		expect(await refText(fixture, "refs/heads/main")).toBe(fixture.baseCommit);
		expect(await refText(fixture, `refs/kogen/incoming/${RUN_ID}`)).toBe("");
		const events = fixture.host.readPublished(
			fixture.runDirectory,
			"events.jsonl",
		);
		expect(events).toBeDefined();
		if (events === undefined) return;
		expect(decoder.decode(events)).toContain('"event":"landing_prepared"');
		expect(decoder.decode(events)).toContain('"event":"commit_result"');
		const runBytes = fixture.host.readPublished(
			fixture.runDirectory,
			"run.json",
		);
		expect(runBytes).toBeDefined();
		if (runBytes === undefined) return;
		const parsed = parseRunRecord(runBytes);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.status).toBe("running");
		expect(parsed.value.landing).toBeNull();
	} finally {
		fixture.close();
	}
});

test("a post-CAS run snapshot failure still returns landed and cleans the incoming ref", async () => {
	const fixture = await createFixture({
		objectFormat: "sha256",
		failAtomicAt: 3,
	});
	try {
		const result = await publish(fixture);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "landed") return;
		expect(result.value.record.status).toBe("landed");
		expect(result.value.terminalRecordPersisted).toBe(false);
		expect(await refText(fixture, "refs/heads/main")).toBe(
			fixture.candidate.commit,
		);
		expect(await refText(fixture, result.value.incomingRef)).toBe("");
		const events = fixture.host.readPublished(
			fixture.runDirectory,
			"events.jsonl",
		);
		expect(events).toBeDefined();
		if (events === undefined) return;
		expect(decoder.decode(events)).toContain('"event":"finished"');
	} finally {
		fixture.close();
	}
});

test("post-CAS incoming cleanup failure stays landed and marks cleanup pending", async () => {
	const fixture = await createFixture({ objectFormat: "sha256" });
	try {
		const result = await publish(
			fixture,
			recordingGit(fixture, { failIncomingDelete: true }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "landed") return;
		expect(await refText(fixture, "refs/heads/main")).toBe(
			fixture.candidate.commit,
		);
		expect(await refText(fixture, result.value.incomingRef)).toBe(
			fixture.candidate.commit,
		);
		expect(result.value.record.status).toBe("landed");
		expect(result.value.record.cleanup_pending).toBe(true);
		expect(result.value.cleanupPending).toBe(true);
		expect(result.value.cleanupFailurePersisted).toBe(true);
	} finally {
		fixture.close();
	}
});

test("checkout edits racing after the clean check are preserved and warned", async () => {
	const fixture = await createFixture();
	try {
		const result = await publish(
			fixture,
			recordingGit(fixture, { editBeforeBaseCas: true }),
		);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.ok).toBe(true);
		if (!result.ok || result.value.kind !== "landed") return;
		expect(result.value.warnings).toEqual([
			`land: warning: landed ${fixture.candidate.commit} on main; your checkout at ${realpathSync(fixture.origin)} has local changes and was not updated; run \`git reset --keep ${fixture.candidate.commit}\`, or merge it yourself`,
		]);
		expect(readFileSync(join(fixture.origin, "source.txt"), "utf8")).toBe(
			"concurrent user edit\n",
		);
		expect(await refText(fixture, "refs/heads/main")).toBe(
			fixture.candidate.commit,
		);
	} finally {
		fixture.close();
	}
});

test("a pre-existing branch lock refuses before publishing incoming", async () => {
	const fixture = await createFixture();
	try {
		mkdirSync(join(fixture.origin, ".git", "refs", "heads"), {
			recursive: true,
		});
		writeFileSync(
			join(fixture.origin, ".git", "refs", "heads", "main.lock"),
			"held\n",
		);
		const result = await publish(fixture);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("not_landed");
		if (result.value.kind !== "not_landed") return;
		expect(result.value.reason).toBe("branch_locked");
		expect(await refText(fixture, `refs/kogen/incoming/${RUN_ID}`)).toBe("");
		const incomingUpdate = fixture.operations.findIndex((operation) =>
			operation.startsWith("git:update-ref refs/kogen/incoming/"),
		);
		expect(incomingUpdate).toBe(-1);
	} finally {
		fixture.close();
	}
});

test("landing reducer keeps cleanup failures after the landed transition", () => {
	const record = {
		approval_commit: "c".repeat(40),
		run_id: RUN_ID,
		expected_parent: "d".repeat(40),
		final_tree: "e".repeat(40),
		candidate_commit: "f".repeat(40),
	} as const;
	let state = initialLandingState(record);
	state = landingTransition(state, { type: "record_persisted" }).state;
	state = landingTransition(state, { type: "incoming_published" }).state;
	state = landingTransition(state, { type: "base_cas_succeeded" }).state;
	state = landingTransition(state, {
		type: "checkouts_synchronized",
		warnings: [],
	}).state;
	state = landingTransition(state, {
		type: "cleanup_failed",
		warning: "ref deletion failed",
	}).state;
	expect(state.phase).toBe("cleanup_pending");
	expect(state.cleanupPending).toBe(true);
	expect(() => landingTransition(state, { type: "incoming_deleted" })).toThrow(
		"invalid during cleanup_pending",
	);
});
