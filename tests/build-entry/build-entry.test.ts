import { expect, test } from "bun:test";
import type { BuildRungPort } from "../../packages/core/src/build/controller";
import {
	createSerializedRunStateWriter,
	runBuild,
} from "../../packages/core/src/build/controller";
import type { PlannerCompletionRequest } from "../../packages/core/src/build/planner";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	GitPort,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	FILESYSTEM_PUBLISH_ACTION,
	FILESYSTEM_PUBLISH_HOST_OPERATION,
} from "../../packages/core/src/fs/publish";
import type { FileSystemHostRequest } from "../../packages/core/src/fs/read";
import {
	hashApprovalBytes,
	hashIntentBytes,
} from "../../packages/core/src/intent/hash";
import type {
	MachineConfig,
	ProjectConfig,
} from "../../packages/core/src/project/schema";
import type {
	ProcessIdentityPort,
	QueueOwnerIdentity,
} from "../../packages/core/src/queue/lock";
import type { JournalEvent } from "../../packages/core/src/run/journal";
import {
	applyRunEventToRecord,
	type RunRecord,
} from "../../packages/core/src/run/store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const slug = "greet";
const runId = "a".repeat(32);
const approvalCommit = "c".repeat(40);
const approvedBase = "d".repeat(40);
const tree = "e".repeat(40);
const owner: QueueOwnerIdentity = { pid: 421, startedMs: 1_790_000_000_000 };
const intentBytes = encoder.encode(
	"---\ntitle: Greet\nsize: small\ndomains: [app]\n---\nDo the task.\n",
);
const acceptanceBytes = encoder.encode("test acceptance\n");
const at = "2026-10-08T08:00:00.000Z";

function response(
	stdout: Uint8Array | string = "",
	exitCode = 0,
): ProcessResult {
	return {
		exitCode,
		signal: null,
		stdout: typeof stdout === "string" ? encoder.encode(stdout) : stdout,
		stderr: new Uint8Array(),
		timedOut: false,
	};
}

function makeApprovalJson(by = "Alice <alice@example.invalid>"): string {
	return JSON.stringify({
		schema: 2,
		slug,
		approval_sha256: hashApprovalBytes(intentBytes, acceptanceBytes),
		intent_sha256: hashIntentBytes(intentBytes),
		target_branch: "main",
		base_sha: approvedBase,
		domains: ["app"],
		acceptance_paths: ["test/acceptance/greet.t.sh"],
		protected_manifest: {},
		check_baseline: [],
		witness: null,
		by,
		at,
	});
}

class FakeGit implements GitPort {
	readonly calls: string[][] = [];
	claimCommit: string | null = null;
	readonly claimIds = [
		"1".repeat(40),
		"2".repeat(40),
		"3".repeat(40),
		"4".repeat(40),
	];
	readonly claimBlob = "5".repeat(40);
	readonly claimTree = "6".repeat(40);
	readonly rootTree = "7".repeat(40);
	readonly claimObject = "8".repeat(40);
	readonly trailerBy: string;
	readonly approvalJson: string;

	constructor(
		input: { readonly approvalJson?: string; readonly trailerBy?: string } = {},
	) {
		this.approvalJson = input.approvalJson ?? makeApprovalJson();
		this.trailerBy = input.trailerBy ?? "Alice <alice@example.invalid>";
	}

	async command(
		request: Parameters<GitPort["command"]>[0],
	): Promise<Result<ProcessResult>> {
		const args = [...request.argv];
		this.calls.push(args);
		const [command, ...rest] = args;
		if (
			command === "for-each-ref" &&
			args.at(-1) === `refs/kogen/intents/${slug}`
		)
			return {
				ok: true,
				value: response(`refs/kogen/intents/${slug}\0${approvalCommit}\0\n`),
			};
		if (command === "for-each-ref" && args.at(-1) === "refs/kogen/claim") {
			if (args[1] === "--format=%(objectname)")
				return {
					ok: true,
					value: response(
						this.claimCommit === null ? "" : `${this.claimCommit}\n`,
					),
				};
			return {
				ok: true,
				value: response(
					this.claimCommit === null
						? ""
						: `refs/kogen/claim\0${this.claimCommit}\0\n`,
				),
			};
		}
		if (
			command === "cat-file" &&
			rest[0] === "-p" &&
			rest[1] === approvalCommit
		) {
			const text = [
				`tree ${tree}`,
				"author Alice <alice@example.invalid> 1791446400 +0000",
				"committer Alice <alice@example.invalid> 1791446400 +0000",
				"",
				"Greet",
				"",
				`Kogen-Approval: ${slug}`,
				`Kogen-Approved-By: ${this.trailerBy}`,
				`Kogen-Approved-Hash: ${hashApprovalBytes(intentBytes, acceptanceBytes)}`,
				`Kogen-Approved-At: ${at}`,
				"",
			].join("\n");
			return { ok: true, value: response(text) };
		}
		if (command === "cat-file" && rest[0] === "blob") {
			const path = rest[1] ?? "";
			if (path === `${approvalCommit}:.kogen/intents/${slug}/approval.json`)
				return { ok: true, value: response(this.approvalJson) };
			if (path === `${approvalCommit}:.kogen/intents/${slug}/intent.md`)
				return { ok: true, value: response(intentBytes) };
			if (path === `${approvalCommit}:test/acceptance/greet.t.sh`)
				return { ok: true, value: response(acceptanceBytes) };
			if (path === this.claimBlob)
				return { ok: true, value: response(`${runId}\n`) };
			return { ok: true, value: response("", 1) };
		}
		if (command === "hash-object" && request.stdin !== undefined) {
			if (args.includes("commit")) {
				this.claimCommit = this.claimObject;
				return { ok: true, value: response(`${this.claimObject}\n`) };
			}
			if (this.claimCommit === null)
				return { ok: true, value: response(`${this.claimBlob}\n`) };
			return { ok: true, value: response(`${this.claimIds[0]}\n`) };
		}
		if (command === "mktree") {
			const id =
				this.claimCommit === null && this.claimIds[0] !== undefined
					? (this.claimIds.shift() ?? this.claimTree)
					: this.claimTree;
			return { ok: true, value: response(`${id}\n`) };
		}
		if (
			command === "update-ref" &&
			args[1] === "-d" &&
			args[2] === "refs/kogen/claim"
		) {
			this.claimCommit = null;
			return { ok: true, value: response() };
		}
		if (command === "update-ref" && args[1] === "refs/kogen/claim") {
			this.claimCommit = args[2] ?? this.claimObject;
			return { ok: true, value: response() };
		}
		if (
			command === "cat-file" &&
			rest[0] === "commit" &&
			rest[1] === this.claimObject
		)
			return {
				ok: true,
				value: response(
					`tree ${this.rootTree}\nauthor Kogen <kogen@invalid> 0 +0000\ncommitter Kogen <kogen@invalid> 0 +0000\n\nKogen project claim\n\nKogen-Run: ${runId}\n`,
				),
			};
		if (command === "ls-tree")
			return {
				ok: true,
				value: response(`100644 blob ${this.claimBlob}\t.kogen/claim\0`),
			};
		return { ok: true, value: response("", 1) };
	}
}

class MemoryRunHost implements FileSystemHostRequest {
	readonly files = new Map<string, Uint8Array>();
	async request(operation: number, payload: Uint8Array): Promise<Uint8Array> {
		if (operation !== FILESYSTEM_PUBLISH_HOST_OPERATION)
			throw new Error(`Unexpected filesystem operation ${operation}`);
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
			throw new Error("Malformed filesystem frame");
		const key = `${root}/${path}`;
		if (action === FILESYSTEM_PUBLISH_ACTION.append) {
			const previous = this.files.get(key) ?? new Uint8Array();
			const combined = new Uint8Array(previous.byteLength + bytes.byteLength);
			combined.set(previous);
			combined.set(bytes, previous.byteLength);
			this.files.set(key, combined);
		} else if (action === FILESYSTEM_PUBLISH_ACTION.atomicWrite) {
			this.files.set(key, bytes.slice());
		} else {
			throw new Error(`Unexpected filesystem action ${action}`);
		}
		return Uint8Array.of(0);
	}
}

function createRequest(
	options: {
		readonly approvalJson?: string;
		readonly trailerBy?: string;
		readonly setupFailures?: number;
		readonly runnerUnavailable?: boolean;
		readonly serialRed?: boolean;
	} = {},
) {
	const git = new FakeGit(options);
	const host = new MemoryRunHost();
	const roles = new Map([
		["builder" as const, { model: "gpt-6-luna", effort: "max" }],
	]);
	const machineRoles = new Map([
		["planner" as const, { model: "machine-planner", effort: "low" }],
	]);
	const project = {
		build: {
			roles,
			modelFallback: true,
			planMaxWords: 500,
			...(options.serialRed
				? {
						recipe: "ladder",
						ladder: {
							maxRungs: 2,
							experimentalR4: false,
							repeatFrom: null,
						},
					}
				: {}),
		},
	} as unknown as ProjectConfig;
	const machine = { build: { roles: machineRoles } } as MachineConfig;
	let plannerRequests = 0;
	let setupCalls = 0;
	let rungCalls = 0;
	const goodPlan =
		"Difficulty: easy\n\n## Acceptance criteria\n- A1: do it\n\n## Technical approach\nMake the change.\n\n## Implementation steps\n1. Make the change.\n";
	const identity: ProcessIdentityPort = {
		current: () => owner,
		async inspect() {
			return {
				ok: true as const,
				value: { kind: "alive" as const, startedMs: owner.startedMs },
			};
		},
	};
	return {
		get plannerRequests() {
			return plannerRequests;
		},
		get setupCalls() {
			return setupCalls;
		},
		get rungCalls() {
			return rungCalls;
		},
		git,
		host,
		request: {
			git,
			origin: "/fixture/origin",
			slug,
			targetBranch: "main",
			runId,
			owner,
			identity,
			inspectClaimOwner: async () => ({
				ok: true as const,
				value: "stale" as const,
			}),
			provider: "chatgpt" as const,
			project,
			machine,
			runDirectory: {
				host,
				async create() {
					return { ok: true as const, value: "/runs/greet" };
				},
			},
			sandbox: {
				async probe() {
					return {
						ok: true as const,
						value: { mode: "confined" as const, unavailableReason: null },
					};
				},
			},
			base: {
				async resolve() {
					return {
						ok: true as const,
						value: {
							commit: approvedBase,
							tree,
							trackedPaths: ["lib/greet.txt", "test/acceptance/greet.t.sh"],
						},
					};
				},
				async checkMovedBase() {
					return { ok: true as const, value: undefined };
				},
			},
			planner: {
				async complete(input: PlannerCompletionRequest) {
					plannerRequests += 1;
					if (
						input.role.requested.model !== "machine-planner" ||
						input.role.requested.effort !== "low"
					)
						throw new Error("Machine planner role was not resolved.");
					if (
						input.modelFallback !== false ||
						input.toolChoice !== "none" ||
						input.tools.length !== 0
					)
						throw new Error("Planner fallback/tools were enabled.");
					return { ok: true as const, value: { text: goodPlan } };
				},
			},
			rung: {
				async createWorkspace(
					input: Parameters<BuildRungPort["createWorkspace"]>[0],
				) {
					return {
						ok: true as const,
						value: { id: input.rung, root: `/work/${input.rung}` },
					};
				},
				async setup() {
					setupCalls += 1;
					if (setupCalls <= (options.setupFailures ?? 0))
						return {
							ok: false as const,
							error: {
								code: "environment/setup_failed",
								message: "Fixture setup failed.",
								exitCode: 3 as const,
							},
						};
					return { ok: true as const, value: undefined };
				},
				async baseAcceptance() {
					if (options.runnerUnavailable)
						return {
							ok: true as const,
							value: { kind: "unavailable" as const },
						};
					return {
						ok: true as const,
						value: {
							items: [
								{
									id: "A1",
									kind: "test" as const,
									status: "failed" as const,
									output: ["failure"],
								},
							],
						},
					};
				},
				async run(input: Parameters<BuildRungPort["run"]>[0]) {
					rungCalls += 1;
					await input.emit("model_stage", {
						stage: "builder",
						provider: "chatgpt",
						model: "gpt-6-luna",
						effort: "max",
					});
					return {
						ok: true as const,
						value: {
							kind:
								options.serialRed && input.attempt?.rung === "R1"
									? ("red" as const)
									: ("green" as const),
							reason:
								options.serialRed && input.attempt?.rung === "R1"
									? "verification/red"
									: "green",
							candidate: {
								rung: input.attempt?.rung ?? "R1",
								workspace: input.workspace,
								verifiedTree: tree,
								verdict:
									options.serialRed && input.attempt?.rung === "R1"
										? ("red" as const)
										: ("green" as const),
							},
						},
					};
				},
				async parkCandidate() {
					return { ok: true as const, value: undefined };
				},
				async cleanup() {
					return { ok: true as const, value: undefined };
				},
			},
			landing: {
				async prepare() {
					return {
						ok: true as const,
						value: {
							candidateCommit: "9".repeat(40),
							record: {
								approval_commit: approvalCommit,
								run_id: runId,
								expected_parent: approvedBase,
								final_tree: tree,
								candidate_commit: "9".repeat(40),
							},
						},
					};
				},
				async publish() {
					return { ok: true as const, value: "landed" as const };
				},
			},
			clock: { unixMilliseconds: () => 1_790_000_000_100 },
			...(options.serialRed
				? { remainingBuildBudgetMilliseconds: () => 60_000 }
				: {}),
		},
	};
}

test("B0 rejects a changed approval trailer before claim or model work", async () => {
	const setup = createRequest({
		approvalJson: makeApprovalJson("Mallory <m@example.invalid>"),
	});
	const result = await runBuild(setup.request);
	expect(result).toMatchObject({
		outcome: "stopped",
		runId: null,
		exitCode: 70,
		reason: "controller/approval_invalid",
	});
	expect(setup.plannerRequests).toBe(0);
	expect(
		setup.git.calls.some(
			(args) => args[0] === "update-ref" && args.includes("refs/kogen/claim"),
		),
	).toBe(false);
});

test("B0–B10 runs one planned R1, verifies base acceptance, lands, and releases its claim", async () => {
	const setup = createRequest();
	const result = await runBuild(setup.request);
	expect(result).toMatchObject({
		outcome: "landed",
		runId,
		exitCode: 0,
		reason: null,
	});
	expect(setup.plannerRequests).toBe(1);
	expect(setup.setupCalls).toBe(1);
	expect(setup.rungCalls).toBe(1);
	const rows = decoder
		.decode(
			setup.host.files.get("/runs/greet/events.jsonl") ?? new Uint8Array(),
		)
		.trim()
		.split("\n")
		.map((row) => JSON.parse(row) as JournalEvent);
	expect(rows.map((row) => row.event)).toEqual([
		"started",
		"model_stage",
		"plan",
		"rung_started",
		"base_acceptance",
		"model_stage",
		"verification",
		"rung_finished",
		"commit_result",
		"landing_prepared",
		"finished",
	]);
	expect(rows.find((row) => row.event === "plan")).toMatchObject({
		difficulty: "easy",
	});
	expect(rows[0]).toMatchObject({
		roles: {
			builder: { model: "gpt-6-luna", effort: "max" },
			planner: { model: "machine-planner", effort: "low" },
		},
		effective_roles: {
			planner: { provider: "chatgpt", model: "machine-planner", effort: "low" },
		},
	});
	expect(setup.git.claimCommit).toBeNull();
});

test("public Build escalates a red R1 into a fresh R2 workspace", async () => {
	const setup = createRequest({ serialRed: true });
	const result = await runBuild(setup.request);
	expect(result).toMatchObject({ outcome: "landed", exitCode: 0 });
	expect(setup.rungCalls).toBe(2);
	expect(setup.setupCalls).toBe(2);
	const rows = decoder
		.decode(
			setup.host.files.get("/runs/greet/events.jsonl") ?? new Uint8Array(),
		)
		.trim()
		.split("\n")
		.map((row) => JSON.parse(row) as JournalEvent);
	expect(
		rows.filter((row) => row.event === "rung_started").map((row) => row.rung),
	).toEqual(["R1", "R2"]);
	expect(rows.find((row) => row.event === "commit_result")?.rung).toBe("R2");
});

test("unavailable Build sandbox is visible in the started event and report source", async () => {
	const setup = createRequest();
	await runBuild({
		...setup.request,
		sandbox: {
			async probe() {
				return {
					ok: true as const,
					value: {
						mode: "unconfined" as const,
						unavailableReason: "forced unavailable by test",
					},
				};
			},
		},
	});
	const rows = decoder
		.decode(
			setup.host.files.get("/runs/greet/events.jsonl") ?? new Uint8Array(),
		)
		.trim()
		.split("\n")
		.map((row) => JSON.parse(row) as JournalEvent);
	expect(rows[0]).toMatchObject({ event: "started", sandbox: "unconfined" });
	expect(rows[1]).toMatchObject({
		event: "sandbox_unavailable",
		reason: "forced unavailable by test",
	});
});

test("setup retries once and stops without invoking a rung after the second failure", async () => {
	const setup = createRequest({ setupFailures: 2 });
	const result = await runBuild(setup.request);
	expect(result).toMatchObject({
		outcome: "stopped",
		exitCode: 3,
		reason: "environment/setup_failed",
	});
	expect(setup.plannerRequests).toBe(1);
	expect(setup.setupCalls).toBe(2);
	expect(setup.rungCalls).toBe(0);
	expect(setup.git.claimCommit).toBeNull();
});

test("queue interruption durably records the signal before releasing the claim", async () => {
	const setup = createRequest();
	const controller = new AbortController();
	const result = await runBuild({
		...setup.request,
		signal: controller.signal,
		planner: {
			async complete() {
				controller.abort("SIGTERM");
				return {
					ok: false as const,
					error: {
						code: "provider/cancelled",
						message: "Provider request cancelled.",
						exitCode: 4 as const,
					},
				};
			},
		},
	});
	const rows = decoder
		.decode(
			setup.host.files.get("/runs/greet/events.jsonl") ?? new Uint8Array(),
		)
		.trim()
		.split("\n")
		.map((row) => JSON.parse(row) as JournalEvent);
	expect(rows.at(-1)).toMatchObject({
		event: "interrupted",
		reason: "sigterm",
	});
	expect(rows.some((row) => row.event === "finished")).toBe(false);
	expect(result.record?.status).toBe("running");
	expect(setup.git.claimCommit).toBeNull();
});

test("missing base acceptance runner stops before the builder request", async () => {
	const setup = createRequest({ runnerUnavailable: true });
	const result = await runBuild(setup.request);
	expect(result).toMatchObject({
		outcome: "stopped",
		exitCode: 3,
		reason: "environment/tool_missing",
	});
	expect(setup.plannerRequests).toBe(1);
	expect(setup.setupCalls).toBe(1);
	expect(setup.rungCalls).toBe(0);
	expect(setup.git.claimCommit).toBeNull();
});

test("serialized run writer applies concurrent events to the latest durable record", async () => {
	const initial: RunRecord = {
		schema: 2,
		run_id: runId,
		slug,
		approval_sha256: "b".repeat(64),
		approval_commit: approvalCommit,
		target_branch: "main",
		status: "running",
		landing: null,
		owner_pid: owner.pid,
		owner_started_ms: owner.startedMs,
		started_ms: owner.startedMs,
		recovery: [],
		cleanup_pending: false,
	};
	let releaseFirst: () => void = () => undefined;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted: () => void = () => undefined;
	const firstStartedGate = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const observed: RunRecord[] = [];
	const writer = createSerializedRunStateWriter(
		initial,
		async (current, row) => {
			observed.push(current);
			if (row.event === "cleanup_failure") {
				firstStarted();
				await firstGate;
			}
			const updated = applyRunEventToRecord(current, row);
			return { ok: true as const, value: { record: updated, event: row } };
		},
	);
	const a = writer.append({
		event: "cleanup_failure",
		ts: 10,
		message: "pending",
	});
	await firstStartedGate;
	const b = writer.append({ event: "finished", ts: 11, status: "stopped" });
	expect(observed).toHaveLength(1);
	releaseFirst();
	await Promise.all([a, b]);
	expect(observed).toHaveLength(2);
	expect(observed[1]).toMatchObject({ cleanup_pending: true });
	expect(writer.current()).toMatchObject({
		cleanup_pending: true,
		status: "stopped",
	});
});
