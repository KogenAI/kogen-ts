import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedCommand } from "../../packages/cli/src/argv";
import {
	type DetachedQueueSpawnRequest,
	handleQueueStart,
	handleQueueStop,
	launchDetachedQueue,
	spawnDetachedQueue,
} from "../../packages/cli/src/handlers/queue";
import { installProcessSignalCustody } from "../../packages/cli/src/handlers/signals";
import type { Result } from "../../packages/core/src/contracts/errors";
import { projectStateRootPath } from "../../packages/core/src/project/resolve";
import {
	drainQueue,
	formatQueueBuildLine,
	type QueueBuildExecution,
	type QueueBuildResult,
	type QueueSignal,
	type QueueSignalSource,
	type QueueStatusSnapshot,
} from "../../packages/core/src/queue/drain";
import type {
	ProcessIdentityPort,
	QueueLockStorage,
	QueueOwnerIdentity,
} from "../../packages/core/src/queue/lock";
import type { QueueIntent } from "../../packages/core/src/queue/transition";

const OWNER: QueueOwnerIdentity = { pid: 101, startedMs: 1_000 };
const RUN_A = "1".repeat(32);
const RUN_B = "2".repeat(32);
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function ok<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

class MemoryQueueStorage implements QueueLockStorage {
	owner: QueueOwnerIdentity | null = null;
	stop = false;

	async readOwner() {
		return ok(this.owner);
	}

	async createOwnerAndClearStop(owner: QueueOwnerIdentity) {
		if (this.owner !== null) return ok<"created" | "exists">("exists");
		this.owner = owner;
		this.stop = false;
		return ok<"created" | "exists">("created");
	}

	async compareExchangeOwnerAndClearStop(
		expected: QueueOwnerIdentity,
		replacement: QueueOwnerIdentity,
	) {
		if (!sameOwner(this.owner, expected)) return ok(false);
		this.owner = replacement;
		this.stop = false;
		return ok(true);
	}

	async removeOwnerIf(owner: QueueOwnerIdentity) {
		if (!sameOwner(this.owner, owner)) return ok(false);
		this.owner = null;
		this.stop = false;
		return ok(true);
	}

	async requestStopIfOwner(owner: QueueOwnerIdentity) {
		if (!sameOwner(this.owner, owner)) return ok(false);
		this.stop = true;
		return ok(true);
	}

	async readStopRequest() {
		return ok(this.stop);
	}
}

function sameOwner(
	left: QueueOwnerIdentity | null,
	right: QueueOwnerIdentity,
): boolean {
	return left?.pid === right.pid && left.startedMs === right.startedMs;
}

const identity: ProcessIdentityPort = {
	current: () => OWNER,
	async inspect(_pid) {
		return ok({ kind: "alive" as const, startedMs: OWNER.startedMs });
	},
};

function queueIntent(
	slug: string,
	values: Partial<Omit<QueueIntent, "slug">> = {},
): QueueIntent {
	return {
		slug,
		approved: true,
		landed: false,
		priority: 0,
		approvedAt: slug === "alpha" ? 1 : 2,
		blocksOn: [],
		...values,
	};
}

function bus(): {
	source: QueueSignalSource;
	send(signal: QueueSignal): void;
} {
	const listeners = new Set<(signal: QueueSignal) => void>();
	return {
		source: {
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		send(signal) {
			for (const listener of listeners) listener(signal);
		},
	};
}

function execution(
	result: QueueBuildResult,
	interrupt: (signal: QueueSignal) => void | Promise<void> = () => {},
): QueueBuildExecution {
	return {
		completion: Promise.resolve(result),
		async interrupt(signal) {
			await interrupt(signal);
		},
	};
}

function landed(runId: string, commit: string): QueueBuildResult {
	return { outcome: "landed", runId, commit };
}

function drainPorts(
	storage: MemoryQueueStorage,
	options: {
		readonly snapshots: readonly QueueStatusSnapshot[];
		readonly startBuild: (slug: string) => Promise<QueueBuildExecution>;
		readonly signals?: QueueSignalSource;
		readonly lines?: string[];
		readonly recover?: () => Promise<Result<void>>;
	},
) {
	let snapshotIndex = 0;
	return {
		storage,
		identity,
		signals: options.signals ?? bus().source,
		async recover() {
			return options.recover?.() ?? ok(undefined);
		},
		async status() {
			const index = Math.min(snapshotIndex, options.snapshots.length - 1);
			snapshotIndex += 1;
			const snapshot = options.snapshots[index];
			if (snapshot === undefined)
				throw new Error("Missing test status snapshot.");
			return ok(snapshot);
		},
		startBuild: options.startBuild,
		writeLine(line: string) {
			options.lines?.push(line);
		},
	};
}

function snapshot(
	queue: readonly QueueIntent[],
	landedSlugs: ReadonlySet<string> = new Set(),
): QueueStatusSnapshot {
	return { queue, landedSlugs };
}

describe("queue command effects", () => {
	test("starts real Build effects serially and refreshes newly unblocked approvals", async () => {
		const storage = new MemoryQueueStorage();
		const lines: string[] = [];
		const started: string[] = [];
		let concurrent = 0;
		let maximumConcurrent = 0;
		const first = queueIntent("alpha");
		const dependent = queueIntent("bravo", { blocksOn: ["alpha"] });
		const result = await drainQueue(
			drainPorts(storage, {
				lines,
				snapshots: [
					snapshot([first, dependent]),
					snapshot(
						[queueIntent("alpha", { landed: true }), dependent],
						new Set(["alpha"]),
					),
					snapshot(
						[
							queueIntent("alpha", { landed: true }),
							queueIntent("bravo", { landed: true, blocksOn: ["alpha"] }),
						],
						new Set(["alpha", "bravo"]),
					),
				],
				async startBuild(slug) {
					started.push(slug);
					concurrent += 1;
					maximumConcurrent = Math.max(maximumConcurrent, concurrent);
					await Promise.resolve();
					concurrent -= 1;
					return execution(
						slug === "alpha"
							? landed(RUN_A, COMMIT_A)
							: landed(RUN_B, COMMIT_B),
					);
				},
			}),
		);

		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("Expected completed drain.");
		expect(result.exitCode).toBe(0);
		expect(result.state.builds).toBe(2);
		expect(result.state.landed).toBe(2);
		expect(started).toEqual(["alpha", "bravo"]);
		expect(maximumConcurrent).toBe(1);
		expect(storage.owner).toBeNull();
		expect(lines).toEqual([
			"building alpha",
			`landed alpha ${COMMIT_A.slice(0, 8)} (Build ${RUN_A.slice(0, 8)})`,
			"building bravo",
			`landed bravo ${COMMIT_B.slice(0, 8)} (Build ${RUN_B.slice(0, 8)})`,
			"queue: done; 2 Build(s), 2 landed, 0 not",
		]);
	});

	test("stop marker stops after the active Build and preserves the next approval", async () => {
		const storage = new MemoryQueueStorage();
		const lines: string[] = [];
		const started: string[] = [];
		const result = await drainQueue(
			drainPorts(storage, {
				lines,
				snapshots: [
					snapshot([queueIntent("alpha"), queueIntent("bravo")]),
					snapshot([
						queueIntent("alpha", { landed: true }),
						queueIntent("bravo"),
					]),
				],
				async startBuild(slug) {
					started.push(slug);
					storage.stop = true;
					return execution(landed(RUN_A, COMMIT_A));
				},
			}),
		);

		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("Expected completed drain.");
		expect(result.state.line).toBe("stopped_on_request");
		expect(result.state.builds).toBe(1);
		expect(result.state.landed).toBe(1);
		expect(result.state.pending.map((intent) => intent.slug)).toEqual([
			"bravo",
		]);
		expect(started).toEqual(["alpha"]);
		expect(lines.at(-1)).toBe(
			"queue: stopped on request; 1 Build(s), 1 landed, 0 not",
		);
		expect(storage.owner).toBeNull();
	});

	test("SIGTERM awaits Build custody, returns 143, and prints no final queue line", async () => {
		const storage = new MemoryQueueStorage();
		const signals = bus();
		const lines: string[] = [];
		let resolveBuild: (result: QueueBuildResult) => void = () => {};
		let interrupted: QueueSignal | null = null;
		const draining = drainQueue(
			drainPorts(storage, {
				lines,
				signals: signals.source,
				snapshots: [snapshot([queueIntent("alpha")])],
				async startBuild() {
					return {
						completion: new Promise((resolve) => {
							resolveBuild = resolve;
						}),
						async interrupt(signal) {
							interrupted = signal;
							resolveBuild({
								outcome: "stopped_controller",
								runId: RUN_A,
								reason: "interrupted",
							});
						},
					};
				},
			}),
		);
		while (lines.length === 0) await Promise.resolve();
		signals.send("SIGTERM");
		const result = await draining;

		expect(result.kind).toBe("signal");
		if (result.kind !== "signal") throw new Error("Expected signal exit.");
		expect(result.exitCode).toBe(143);
		expect(interrupted as QueueSignal | null).toBe("SIGTERM");
		expect(lines).toEqual(["building alpha"]);
		expect(storage.owner).toBeNull();
	});

	test("a skipped approval does not count as a Build", async () => {
		const lines: string[] = [];
		const result = await drainQueue(
			drainPorts(new MemoryQueueStorage(), {
				lines,
				snapshots: [snapshot([queueIntent("alpha")]), snapshot([])],
				async startBuild() {
					return {
						...execution({
							outcome: "skipped",
							runId: null,
							reason: "environment/approval_branch_mismatch",
						}),
						started: false,
					};
				},
			}),
		);

		expect(result.kind).toBe("finished");
		if (result.kind !== "finished")
			throw new Error("Expected completed drain.");
		expect(result.state.builds).toBe(0);
		expect(result.state.line).toBe("nothing_to_build");
		expect(lines).toEqual([
			"skipped alpha: environment/approval_branch_mismatch",
			"queue: nothing to build",
		]);
	});

	test("stopped Build lines keep the Intent queued and B0 refusals have no run suffix", () => {
		expect(
			formatQueueBuildLine("alpha", {
				outcome: "stopped_environment",
				runId: null,
				reason: "environment/approval_invalid",
			}),
		).toBe("stopped alpha: environment/approval_invalid; it stays queued");
		expect(
			formatQueueBuildLine("alpha", {
				outcome: "stopped_provider",
				runId: RUN_A,
				reason: "provider/usage_limit_exhausted",
			}),
		).toBe(
			`stopped alpha: provider/usage_limit_exhausted; it stays queued (Build ${RUN_A.slice(0, 8)})`,
		);
	});

	test("a reduced outcome alone cannot claim landing without a real commit and run id", () => {
		expect(
			formatQueueBuildLine("alpha", { outcome: "landed", runId: null }),
		).toBe("stopped alpha: controller/build_result_invalid; it stays queued");
	});
});

describe("CLI signal and detach custody", () => {
	test("signal custody forwards only the first signal and removes listeners", () => {
		const target = new EventEmitter();
		const custody = installProcessSignalCustody(target);
		const received: QueueSignal[] = [];
		custody.source.subscribe((signal) => received.push(signal));
		target.emit("SIGINT");
		target.emit("SIGTERM");
		expect(received).toEqual(["SIGINT"]);
		custody.dispose();
		expect(target.listenerCount("SIGINT")).toBe(0);
		expect(target.listenerCount("SIGTERM")).toBe(0);
	});

	test("detached parent returns only after a matching owner handshake", async () => {
		const root = mkdtempSync(join(tmpdir(), "kts-queue-detach-"));
		tempRoots.push(root);
		const command: Extract<ParsedCommand, { name: "queue start" }> = {
			name: "queue start",
			detach: true,
			project: "/tmp/checkout-a",
			origin: "/tmp/origin",
			base: "main",
		};
		const spawnRequests: DetachedQueueSpawnRequest[] = [];
		let terminated = false;
		const launched = await launchDetachedQueue({
			command,
			stateRoot: root,
			invocation: {
				executable: "/private/bin/kogen",
				prefixArgs: [],
				cwd: root,
			},
			spawn: async (request) => {
				spawnRequests.push(request);
				return {
					pid: 55,
					ready: Promise.resolve("ready:55"),
					closeHandshake() {},
					async terminate() {
						terminated = true;
					},
				};
			},
		});

		expect(launched.ok).toBe(true);
		if (!launched.ok) throw new Error("Expected detached child startup.");
		expect(launched.value.pid).toBe(55);
		expect(launched.value.logPath).toBe(join(realpathSync(root), "queue.log"));
		expect(spawnRequests[0]?.args).toEqual([
			"queue",
			"start",
			"--project",
			"/tmp/checkout-a",
			"--origin",
			"/tmp/origin",
			"--base",
			"main",
		]);
		expect(terminated).toBe(false);
	});

	test("bad detach handshake terminates the orphan and returns unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "kts-queue-detach-"));
		tempRoots.push(root);
		const command: Extract<ParsedCommand, { name: "queue start" }> = {
			name: "queue start",
			detach: true,
			project: "/tmp/checkout-a",
		};
		let terminated = false;
		const launched = await launchDetachedQueue({
			command,
			stateRoot: root,
			invocation: {
				executable: "/private/bin/kogen",
				prefixArgs: [],
				cwd: root,
			},
			spawn: () => ({
				pid: 55,
				ready: Promise.resolve("ready:56"),
				closeHandshake() {},
				async terminate() {
					terminated = true;
				},
			}),
		});

		expect(launched.ok).toBe(false);
		expect(terminated).toBe(true);
	});

	test("production detach spawn receives a startup handshake over its private pipe", async () => {
		const root = mkdtempSync(join(tmpdir(), "kts-queue-detach-process-"));
		tempRoots.push(root);
		const writeHandshake =
			"require('node:fs').writeSync(3, 'ready:' + process.pid + '\\n'); setInterval(() => {}, 1000);";
		const child = await spawnDetachedQueue(root)({
			invocation: {
				executable: process.execPath,
				prefixArgs: ["-e", writeHandshake],
				cwd: root,
			},
			args: ["queue", "start"],
			logPath: join(realpathSync(root), "queue.log"),
		});
		try {
			expect(await child.ready).toBe(`ready:${child.pid}`);
			expect(child.pid).toBeGreaterThan(0);
		} finally {
			child.closeHandshake();
			await child.terminate();
		}
	});

	test("public start handler streams the production drain result", async () => {
		const storage = new MemoryQueueStorage();
		const signals = bus();
		const lines: string[] = [];
		const command: Extract<ParsedCommand, { name: "queue start" }> = {
			name: "queue start",
			detach: false,
			project: "/tmp/checkout-a",
		};
		const ports = drainPorts(storage, {
			lines,
			signals: signals.source,
			snapshots: [snapshot([queueIntent("alpha")]), snapshot([])],
			async startBuild() {
				return execution(landed(RUN_A, COMMIT_A));
			},
		});
		const output = await handleQueueStart(command, {
			...ports,
			stateRoot: "/tmp/kogen-queue-state",
		});

		expect(output).toEqual({ stdout: "", stderr: "", exitCode: 0 });
		expect(lines.at(-1)).toBe("queue: done; 1 Build(s), 1 landed, 0 not");
	});

	test("public stop handler marks a verified live queue owner", async () => {
		const storage = new MemoryQueueStorage();
		storage.owner = OWNER;
		const output = await handleQueueStop(
			{ name: "queue stop", project: "/tmp/checkout-a" },
			{ storage, identity },
		);

		expect(output).toEqual({
			stdout: `queue: stopping after the current Build (pid ${OWNER.pid})\n`,
			stderr: "",
			exitCode: 0,
		});
		expect(storage.stop).toBe(true);
	});

	test("two checkouts have separate queue owners while the Build claim is shared", async () => {
		const home = "/tmp/kogen-queue-home";
		const rootA = projectStateRootPath(home, "/tmp/checkout-a");
		const rootB = projectStateRootPath(home, "/tmp/checkout-b");
		expect(rootA).not.toBe(rootB);

		const storageA = new MemoryQueueStorage();
		const storageB = new MemoryQueueStorage();
		let buildClaimed = false;
		let releaseWinningBuild: (result: QueueBuildResult) => void = () => {};
		let buildStarts = 0;
		let resolveBothStarted: () => void = () => {};
		const bothStarted = new Promise<void>((resolve) => {
			resolveBothStarted = resolve;
		});
		const startBuild = async () => {
			buildStarts += 1;
			if (buildStarts === 2) resolveBothStarted();
			if (buildClaimed)
				return execution({
					outcome: "stopped_environment",
					runId: null,
					reason: "build_already_claimed",
				});
			buildClaimed = true;
			return {
				completion: new Promise<QueueBuildResult>((resolve) => {
					releaseWinningBuild = (result) => {
						buildClaimed = false;
						resolve(result);
					};
				}),
				async interrupt() {
					buildClaimed = false;
				},
			};
		};
		const queue = [queueIntent("alpha")];
		const drainA = drainQueue(
			drainPorts(storageA, {
				snapshots: [snapshot(queue), snapshot([])],
				startBuild,
			}),
		);
		const drainB = drainQueue(
			drainPorts(storageB, {
				snapshots: [snapshot(queue), snapshot(queue)],
				startBuild,
			}),
		);
		await bothStarted;
		releaseWinningBuild(landed(RUN_A, COMMIT_A));
		const results = await Promise.all([drainA, drainB]);

		expect(results.map((result) => result.exitCode).sort()).toEqual([0, 3]);
		expect(storageA.owner).toBeNull();
		expect(storageB.owner).toBeNull();
		expect(buildStarts).toBe(2);
	});
});
