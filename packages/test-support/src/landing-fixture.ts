import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LandingCommit } from "../../core/src/build/landing/commit";
import type {
	GitPort,
	GitRequest,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../core/src/contracts/ports";
import {
	FILESYSTEM_PUBLISH_ACTION,
	FILESYSTEM_PUBLISH_HOST_OPERATION,
} from "../../core/src/fs/publish";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
	FileSystemStatus,
} from "../../core/src/fs/read";
import {
	createPrivateGitRepository,
	type PrivateGitRepository,
} from "../../core/src/git/repository";
import type { RecoveryWorkspaceTarget } from "../../core/src/recovery/recover";
import type { RecoveryRecord, RunRecord } from "../../core/src/run/store";
import { cloneFreshWorkspace } from "../../core/src/workspace/clone";
import { snapshotWorkspace } from "../../core/src/workspace/snapshot";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface LandingFixtureWorkspace extends RecoveryWorkspaceTarget {
	readonly path: string;
	readonly repository: PrivateGitRepository;
}

export interface LandingFixture {
	readonly root: string;
	readonly home: string;
	readonly origin: string;
	readonly checkout: string;
	readonly baseCommit: string;
	readonly baseTree: string;
	readonly gitExecutable: string;
	readonly git: GitPort;
	readonly process: ProcessPort;
	readonly filesystem: FileSystemHostRequest;
	readonly filesystemOperations: readonly string[];
	readonly filesystemFiles: ReadonlyMap<string, Uint8Array>;
	createWorkspace(
		id: string,
		baseCommit?: string,
	): Promise<LandingFixtureWorkspace>;
	makeCommit(parent: string, tree?: string, message?: string): string;
	createCandidate(parent?: string, message?: string): Promise<LandingCommit>;
	publishRecoverySnapshot(
		runId: string,
		workspace: LandingFixtureWorkspace,
	): Promise<RecoveryRecord>;
	readRef(ref: string): string | null;
	moveRef(ref: string, expected: string, replacement: string): boolean;
	setGitFault(
		fault: ((request: GitRequest) => ProcessResult | null) | null,
	): void;
	setFilesystemFault(input: {
		readonly failAppendNumber?: number | null;
		readonly failAtomicWriteNumber?: number | null;
	}): void;
	createRunRecord(input: {
		readonly runId: string;
		readonly slug?: string;
		readonly status?: RunRecord["status"];
		readonly landing?: RunRecord["landing"];
		readonly recovery?: readonly RecoveryRecord[];
	}): RunRecord;
	runDirectory(runId: string): string;
	close(): void;
}

function environment(
	home: string,
	gitExecutable: string,
): Record<string, string> {
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

function processResult(result: ReturnType<typeof spawnSync>): ProcessResult {
	const error = result.error as NodeJS.ErrnoException | undefined;
	const stdout =
		typeof result.stdout === "string"
			? encoder.encode(result.stdout)
			: new Uint8Array(result.stdout ?? []);
	const stderr =
		typeof result.stderr === "string"
			? encoder.encode(result.stderr)
			: new Uint8Array(result.stderr ?? []);
	return {
		exitCode: error?.code === "ETIMEDOUT" ? null : result.status,
		signal: result.signal,
		stdout,
		stderr,
		timedOut: error?.code === "ETIMEDOUT",
	};
}

function failedResult(error: unknown): ProcessResult {
	return {
		exitCode: 127,
		signal: null,
		stdout: new Uint8Array(),
		stderr: encoder.encode(
			error instanceof Error ? error.message : "fixture effect failed",
		),
		timedOut: false,
	};
}

function spawnProcess(
	argv: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
	stdin: Uint8Array | undefined,
	timeoutMilliseconds: number,
	outputLimitBytes: number,
): ProcessResult {
	const executable = argv[0];
	if (executable === undefined) return failedResult(new Error("empty argv"));
	try {
		const result = spawnSync(executable, argv.slice(1), {
			cwd,
			env: { ...env },
			...(stdin === undefined ? {} : { input: stdin }),
			maxBuffer: Math.max(1024, outputLimitBytes + 1),
			timeout: timeoutMilliseconds,
			encoding: "buffer",
		});
		if (
			result.error !== undefined &&
			(result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT"
		)
			return failedResult(result.error);
		return processResult(result);
	} catch (error) {
		return failedResult(error);
	}
}

function gitSync(
	gitExecutable: string,
	argv: readonly string[],
	cwd: string,
	home: string,
	stdin?: Uint8Array,
): Uint8Array {
	const result = spawnSync(gitExecutable, [...argv], {
		cwd,
		env: environment(home, gitExecutable),
		...(stdin === undefined ? {} : { input: stdin }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: 30_000,
		encoding: "buffer",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`fixture Git failed (${String(result.status)}): ${argv.join(" ")}\n${result.stderr?.toString() ?? ""}`,
		);
	return new Uint8Array(result.stdout ?? []);
}

class LandingFixtureFilesystem implements FileSystemHostRequest {
	readonly files = new Map<string, Uint8Array>();
	readonly operations: string[] = [];
	failAppendNumber: number | null = null;
	failAtomicWriteNumber: number | null = null;
	private appendCount = 0;
	private atomicWriteCount = 0;

	async request(operation: number, payload: Uint8Array): Promise<Uint8Array> {
		if (operation === FILESYSTEM_PUBLISH_HOST_OPERATION)
			return this.publish(payload);
		if (operation === FILESYSTEM_HOST_OPERATION) return this.read(payload);
		throw new Error(`unexpected filesystem operation ${operation}`);
	}

	private publish(payload: Uint8Array): Uint8Array {
		if (payload.byteLength < 16)
			return Uint8Array.of(FileSystemStatus.invalidPath);
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const action = payload[0];
		const rootLength = view.getUint32(4, false);
		const pathLength = view.getUint32(8, false);
		const bytesLength = view.getUint32(12, false);
		const start = 16 + rootLength + pathLength;
		if (start + bytesLength !== payload.byteLength)
			return Uint8Array.of(FileSystemStatus.invalidPath);
		const root = decoder.decode(payload.subarray(16, 16 + rootLength));
		const path = decoder.decode(payload.subarray(16 + rootLength, start));
		const key = `${root}/${path}`;
		const bytes = payload.subarray(start);
		if (action === FILESYSTEM_PUBLISH_ACTION.append) {
			this.appendCount += 1;
			this.operations.push(`append:${path}`);
			if (this.appendCount === this.failAppendNumber)
				return Uint8Array.of(FileSystemStatus.io);
			const previous = this.files.get(key) ?? new Uint8Array();
			const next = new Uint8Array(previous.byteLength + bytes.byteLength);
			next.set(previous);
			next.set(bytes, previous.byteLength);
			this.files.set(key, next);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action === FILESYSTEM_PUBLISH_ACTION.atomicWrite) {
			this.atomicWriteCount += 1;
			this.operations.push(`atomic:${path}`);
			if (this.atomicWriteCount === this.failAtomicWriteNumber)
				return Uint8Array.of(FileSystemStatus.io);
			this.files.set(key, bytes.slice());
			return Uint8Array.of(FileSystemStatus.ok);
		}
		if (action === FILESYSTEM_PUBLISH_ACTION.remove) {
			this.operations.push(`remove:${path}`);
			this.files.delete(key);
			return Uint8Array.of(FileSystemStatus.ok);
		}
		return Uint8Array.of(FileSystemStatus.invalidPath);
	}

	private read(payload: Uint8Array): Uint8Array {
		if (payload.byteLength < 17)
			return Uint8Array.of(FileSystemStatus.invalidPath);
		const view = new DataView(
			payload.buffer,
			payload.byteOffset,
			payload.byteLength,
		);
		const maxBytes = view.getUint32(1, false);
		const rootLength = view.getUint32(9, false);
		const pathLength = view.getUint32(13, false);
		const end = 17 + rootLength + pathLength;
		if (end !== payload.byteLength)
			return Uint8Array.of(FileSystemStatus.invalidPath);
		const root = decoder.decode(payload.subarray(17, 17 + rootLength));
		const path = decoder.decode(payload.subarray(17 + rootLength, end));
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

	setFault(input: {
		readonly failAppendNumber?: number | null;
		readonly failAtomicWriteNumber?: number | null;
	}): void {
		this.failAppendNumber = input.failAppendNumber ?? null;
		this.failAtomicWriteNumber = input.failAtomicWriteNumber ?? null;
	}
}

/**
 * A hermetic temporary bare origin and file/process ports for landing tests.
 * Git identities and signing changes are confined to these private fixture repos.
 */
export async function createLandingFixture(): Promise<LandingFixture> {
	const foundGit = Bun.which("git");
	if (foundGit === null) throw new Error("Git is not available in PATH");
	const gitExecutable = resolve(foundGit);
	const root = mkdtempSync(join(tmpdir(), "kogen-landing-"));
	const home = join(root, "home");
	const origin = join(root, "origin");
	const checkout = join(root, "checkout");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(origin, { mode: 0o700 });
	const env = environment(home, gitExecutable);
	const process: ProcessPort = {
		async run(request: ProcessRequest) {
			return {
				ok: true,
				value: spawnProcess(
					request.argv,
					request.cwd,
					{ ...env, ...request.env },
					request.stdin,
					request.timeoutMilliseconds,
					request.outputLimitBytes,
				),
			};
		},
	};
	let gitFault: ((request: GitRequest) => ProcessResult | null) | null = null;
	const git: GitPort = {
		async command(request) {
			const injected = gitFault?.(request) ?? null;
			if (injected !== null) return { ok: true, value: injected };
			const result = spawnSync(gitExecutable, [...request.argv], {
				cwd: request.repository,
				env,
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				timeout: request.timeoutMilliseconds,
				encoding: "buffer",
			});
			if (
				result.error !== undefined &&
				(result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT"
			)
				return {
					ok: false,
					error: {
						code: "unavailable",
						message: result.error.message,
						retryable: false,
					},
				};
			return { ok: true, value: processResult(result) };
		},
	};

	try {
		gitSync(
			gitExecutable,
			["init", "--initial-branch=main", "."],
			origin,
			home,
		);
		gitSync(
			gitExecutable,
			["config", "user.name", "Kogen Landing Fixture"],
			origin,
			home,
		);
		gitSync(
			gitExecutable,
			["config", "user.email", "landing@kogen.invalid"],
			origin,
			home,
		);
		gitSync(gitExecutable, ["config", "commit.gpgsign", "false"], origin, home);
		gitSync(
			gitExecutable,
			["config", "core.hooksPath", "/dev/null"],
			origin,
			home,
		);
		writeFileSync(join(origin, "README.md"), "base\n", { mode: 0o644 });
		writeFileSync(join(origin, "src.txt"), "base\n", { mode: 0o644 });
		writeFileSync(join(origin, "run.sh"), "#!/bin/sh\necho base\n", {
			mode: 0o644,
		});
		chmodSync(join(origin, "run.sh"), 0o644);
		gitSync(gitExecutable, ["add", "-A"], origin, home);
		gitSync(gitExecutable, ["commit", "-m", "Fixture base"], origin, home);
		const baseCommit = decoder
			.decode(
				gitSync(gitExecutable, ["rev-parse", "refs/heads/main"], origin, home),
			)
			.trim();
		const baseTree = decoder
			.decode(
				gitSync(
					gitExecutable,
					["rev-parse", `${baseCommit}^{tree}`],
					origin,
					home,
				),
			)
			.trim();
		const cloned = await cloneFreshWorkspace(process, {
			sourceRepository: origin,
			destination: checkout,
			baseCommit,
			executable: gitExecutable,
			environment: env,
		});
		if (!cloned.ok) throw new Error(cloned.error.message);
		gitSync(
			gitExecutable,
			["config", "user.name", "Checkout Fixture"],
			checkout,
			home,
		);
		gitSync(
			gitExecutable,
			["config", "user.email", "checkout@kogen.invalid"],
			checkout,
			home,
		);
		const filesystem = new LandingFixtureFilesystem();
		const filesystemFiles = filesystem.files;
		const filesystemOperations = filesystem.operations;
		const workspaces = new Set<string>();
		const createFixtureCommit = (
			parent: string,
			tree = baseTree,
			message = "Fixture candidate",
		): string => {
			const bytes = gitSync(
				gitExecutable,
				[
					"-c",
					"user.name=Kogen Fixture",
					"-c",
					"user.email=fixture@kogen.invalid",
					"commit-tree",
					tree,
					"-p",
					parent,
				],
				origin,
				home,
				encoder.encode(`${message}\n`),
			);
			return decoder.decode(bytes).trim();
		};
		return {
			root,
			home,
			origin,
			checkout,
			baseCommit,
			baseTree,
			gitExecutable,
			git,
			process,
			filesystem,
			filesystemFiles,
			filesystemOperations,
			async createWorkspace(id, savedBase = baseCommit) {
				if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id) || workspaces.has(id))
					throw new TypeError("workspace id is invalid or already allocated");
				workspaces.add(id);
				const path = join(root, "workspaces", id);
				const gitDirectory = join(root, "private-git", id);
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				mkdirSync(dirname(gitDirectory), { recursive: true, mode: 0o700 });
				const workspaceClone = await cloneFreshWorkspace(process, {
					sourceRepository: origin,
					destination: path,
					baseCommit: savedBase,
					executable: gitExecutable,
					environment: env,
				});
				if (!workspaceClone.ok) throw new Error(workspaceClone.error.message);
				gitSync(
					gitExecutable,
					["config", "user.name", "Workspace Fixture"],
					path,
					home,
				);
				gitSync(
					gitExecutable,
					["config", "user.email", "workspace@kogen.invalid"],
					path,
					home,
				);
				mkdirSync(gitDirectory, { mode: 0o700 });
				const metadata = await createPrivateGitRepository(process, {
					sourceRepository: origin,
					gitDirectory,
					workTree: path,
					executable: gitExecutable,
					environment: env,
				});
				if (!metadata.ok) throw new Error(metadata.error.message);
				const target: LandingFixtureWorkspace = {
					id,
					path,
					baseCommit: savedBase,
					sourceRepository: origin,
					repository: metadata.value,
					async present() {
						return { ok: true, value: existsSync(path) };
					},
					async remove() {
						rmSync(path, { recursive: true, force: true });
						return { ok: true, value: undefined };
					},
				};
				return target;
			},
			makeCommit: createFixtureCommit,
			async createCandidate(
				parent = baseCommit,
				message = "Fixture candidate",
			) {
				const tree = decoder
					.decode(
						gitSync(
							gitExecutable,
							["rev-parse", `${parent}^{tree}`],
							origin,
							home,
						),
					)
					.trim();
				const commit = createFixtureCommit(parent, tree, message);
				return {
					commit,
					parent,
					tree,
					objectFormat: "sha1",
					transferCleanupWarning: null,
				};
			},
			async publishRecoverySnapshot(runId, workspace) {
				if (!/^[a-f0-9]{32}$/u.test(runId))
					throw new TypeError(
						"recovery run id must be a 32-digit lowercase hex value",
					);
				const snapshot = await snapshotWorkspace({
					repository: workspace.repository,
					sourceRepository: origin,
					baseCommit: workspace.baseCommit,
					filesystem,
				});
				if (!snapshot.ok) throw new Error(snapshot.error.message);
				const message = [
					"Kogen recovery snapshot",
					"",
					`Kogen-Run: ${runId}`,
					`Kogen-Workspace: ${workspace.id}`,
					`Kogen-Base: ${workspace.baseCommit}`,
					`Kogen-Tree: ${snapshot.value.tree}`,
					"Kogen-Verification: unverified",
					"",
				].join("\n");
				const created = await workspace.repository.command(
					[
						"-c",
						"user.name=Kogen Recovery",
						"-c",
						"user.email=recovery@kogen.invalid",
						"commit-tree",
						snapshot.value.tree,
						"-p",
						workspace.baseCommit,
					],
					{ stdin: encoder.encode(message), outputLimitBytes: 128 },
				);
				if (!created.ok || created.value.exitCode !== 0)
					throw new Error("could not create fixture recovery commit");
				const commit = decoder.decode(created.value.stdout).trim();
				const fetched = await git.command({
					repository: origin,
					argv: [
						"fetch",
						"--no-tags",
						"--no-recurse-submodules",
						workspace.repository.gitDirectory,
						commit,
					],
					timeoutMilliseconds: 30_000,
					outputLimitBytes: 256 * 1024,
				});
				if (!fetched.ok || fetched.value.exitCode !== 0)
					throw new Error("could not fetch fixture recovery commit");
				const ref = `refs/kogen/candidates/${runId}/recovery-${workspace.id}`;
				const installed = await git.command({
					repository: origin,
					argv: ["update-ref", ref, commit, "0".repeat(commit.length)],
					timeoutMilliseconds: 30_000,
					outputLimitBytes: 4096,
				});
				if (!installed.ok || installed.value.exitCode !== 0)
					throw new Error("could not install fixture recovery ref");
				return {
					workspace: workspace.id,
					base: workspace.baseCommit,
					tree: snapshot.value.tree,
					ref,
					archive: null,
					verification: "unverified",
				};
			},
			readRef(ref) {
				const result = spawnSync(
					gitExecutable,
					["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
					{ cwd: origin, env, timeout: 30_000, encoding: "buffer" },
				);
				if (result.status === 1) return null;
				if (result.error !== undefined) throw result.error;
				if (result.status !== 0)
					throw new Error(`could not read temporary ref ${ref}`);
				return decoder.decode(new Uint8Array(result.stdout ?? [])).trim();
			},
			moveRef(ref, expected, replacement) {
				const result = spawnSync(
					gitExecutable,
					["update-ref", ref, replacement, expected],
					{ cwd: origin, env, timeout: 30_000, encoding: "buffer" },
				);
				if (result.error !== undefined) throw result.error;
				return result.status === 0;
			},
			setGitFault(fault) {
				gitFault = fault;
			},
			setFilesystemFault(input) {
				filesystem.setFault(input);
			},
			createRunRecord(input) {
				return {
					schema: 2,
					run_id: input.runId,
					slug: input.slug ?? "alpha",
					approval_sha256: "b".repeat(64),
					approval_commit: baseCommit,
					target_branch: "main",
					status: input.status ?? "running",
					landing: input.landing ?? null,
					owner_pid: 424242,
					owner_started_ms: 1_750_000_000_000,
					started_ms: 1_740_000_000_000,
					recovery: input.recovery === undefined ? [] : [...input.recovery],
					cleanup_pending: false,
				};
			},
			runDirectory(runId) {
				return join(root, "state", "runs", runId);
			},
			close() {
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
