import { expect, test } from "bun:test";
import { createCommandAdapter } from "../../packages/core/src/adapters/command";
import {
	type ApprovalBaselineCacheEntry,
	type ApprovalBaselineCachePort,
	type ApprovalPreflightRequest,
	type ApprovalScratchWorkspace,
	type ApprovalWorkspacePort,
	approvalBaselineCacheKey,
	preflightApproval,
} from "../../packages/core/src/approval/preflight";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import type {
	GateTreePort,
	GateTreeSnapshot,
} from "../../packages/core/src/gate/checks";
import { hashApprovalBytes } from "../../packages/core/src/intent/hash";
import type { CheckSpec } from "../../packages/core/src/project/schema";

const CHECKOUT = "/tmp/approval-preflight-checkout";
const SCRATCH = "/tmp/approval-preflight-scratch/greet";
const RUN_DIRECTORY = "/tmp/approval-preflight-run";
const BASE_COMMIT = "c".repeat(40);
const BASE_TREE = "a".repeat(40);

const INTENT = new TextEncoder().encode(
	"---\ntitle: Greet Almir by name\nsize: small\ndomains: [app]\n---\nChange the greeting in lib/greet.txt so that it names Almir,\nand keep lib/greet.txt a single line.\n\n## Acceptance\n- A1: lib/greet.txt contains the line Hello, Almir!\n- A2: lib/greet.txt has exactly one line.\n\n## Verify\n- A1: test\n- A2: test keep\n\n## Request\nMake the greeting in lib/greet.txt say Hello, Almir! instead of Hello!\n",
);
const ACCEPTANCE = new TextEncoder().encode(
	"t_A1() { grep -qx 'Hello, Almir!' lib/greet.txt; }\nt_A2() { [ \"$(wc -l < lib/greet.txt | tr -d ' ')\" = 1 ]; }\n",
);

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

class MemoryFileSystem
	implements
		Pick<FileSystemPort, "readFile" | "writeFileAtomically" | "removeFile">
{
	readonly files = new Map<string, Uint8Array>();

	private key(root: string, path: string): string {
		return `${root}\0${path}`;
	}

	async readFile(request: {
		readonly root: string;
		readonly path: string;
		readonly maxBytes: number;
	}): Promise<Result<Uint8Array>> {
		const value = this.files.get(this.key(request.root, request.path));
		if (value === undefined)
			return { ok: false, error: error("not_found", "file does not exist") };
		if (value.byteLength > request.maxBytes)
			return { ok: false, error: error("invalid_input", "file too large") };
		return { ok: true, value: value.slice() };
	}

	async writeFileAtomically(request: {
		readonly root: string;
		readonly path: string;
		readonly bytes: Uint8Array;
		readonly mode: number;
	}): Promise<Result<void>> {
		this.files.set(this.key(request.root, request.path), request.bytes.slice());
		return { ok: true, value: undefined };
	}

	async removeFile(root: string, path: string): Promise<Result<void>> {
		if (!this.files.delete(this.key(root, path)))
			return { ok: false, error: error("not_found", "file does not exist") };
		return { ok: true, value: undefined };
	}

	put(root: string, path: string, value: Uint8Array): void {
		this.files.set(this.key(root, path), value.slice());
	}

	removeRoot(root: string): void {
		for (const key of this.files.keys())
			if (key.startsWith(`${root}\0`)) this.files.delete(key);
	}
}

class MemoryTree implements GateTreePort {
	identity: string;
	restoreCount = 0;
	private sequence = 0;
	private readonly checkpoints = new Map<string, string>();

	constructor(identity: string) {
		this.identity = identity;
	}

	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		this.sequence += 1;
		const restoreToken = `snapshot-${this.sequence}`;
		this.checkpoints.set(restoreToken, this.identity);
		return {
			ok: true,
			value: { identity: this.identity, restoreToken },
		};
	}

	async changedPaths(): Promise<Result<readonly string[]>> {
		return { ok: true, value: [] };
	}

	async restore(snapshot: GateTreeSnapshot): Promise<Result<void>> {
		const identity = this.checkpoints.get(snapshot.restoreToken);
		if (identity === undefined)
			return {
				ok: false,
				error: error("not_found", "snapshot does not exist"),
			};
		this.identity = identity;
		this.restoreCount += 1;
		return { ok: true, value: undefined };
	}
}

class FixtureWorkspace implements ApprovalWorkspacePort {
	readonly checkoutPath = CHECKOUT;
	readonly checkoutTree: GateTreePort;
	createCount = 0;
	removeCount = 0;
	lastScratch: ApprovalScratchWorkspace | null = null;
	private readonly filesystem: MemoryFileSystem;
	private scratchTree: MemoryTree | null = null;

	constructor(filesystem: MemoryFileSystem, checkoutTree = "b".repeat(40)) {
		this.filesystem = filesystem;
		this.checkoutTree = new MemoryTree(checkoutTree);
	}

	async createScratch(request: {
		readonly baseCommit: string;
		readonly expectedTree: string;
		readonly scratchRoot: string;
		readonly slug: string;
	}): Promise<Result<ApprovalScratchWorkspace>> {
		this.createCount += 1;
		const path = `${request.scratchRoot}/${request.slug}`;
		const tree = new MemoryTree(request.expectedTree);
		this.scratchTree = tree;
		this.filesystem.put(path, ".kogen/acceptance/greet.t.sh", ACCEPTANCE);
		const scratch: ApprovalScratchWorkspace = {
			path,
			baseTree: request.expectedTree,
			tree,
			remove: async () => {
				this.filesystem.removeRoot(path);
				this.removeCount += 1;
				return { ok: true, value: undefined };
			},
		};
		this.lastScratch = scratch;
		return { ok: true, value: scratch };
	}

	get scratchTreeValue(): MemoryTree | null {
		return this.scratchTree;
	}
}

class FixtureProcess {
	readonly requests: ProcessRequest[] = [];
	setupStatus = 0;
	baselineStatus = 0;
	acceptanceStatus = 0;
	readonly order: string[] = [];
	baselineStdout = "";
	setupStdout = "";
	acceptanceStdout = "";

	async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
		this.requests.push(request);
		const argv = request.argv.join(" ");
		let exitCode = 0;
		let stdout = "";
		if (argv.includes("setup")) {
			this.order.push("setup");
			exitCode = this.setupStatus;
			stdout = this.setupStdout;
		} else if (argv.includes("-n") || argv.includes("syntax")) {
			this.order.push("acceptance");
			exitCode = this.acceptanceStatus;
			stdout = this.acceptanceStdout;
		} else {
			this.order.push("check");
			exitCode = this.baselineStatus;
			stdout = this.baselineStdout;
		}
		return {
			ok: true,
			value: {
				exitCode,
				signal: null,
				stdout: bytes(stdout),
				stderr: new Uint8Array(),
				timedOut: false,
			},
		};
	}
}

class MemoryBaselineCache implements ApprovalBaselineCachePort {
	readonly entries = new Map<string, ApprovalBaselineCacheEntry>();
	readonly lookups: { key: string; checkedBaseTree: string }[] = [];

	async get(request: {
		readonly key: string;
		readonly checkedBaseTree: string;
	}): Promise<Result<ApprovalBaselineCacheEntry | null>> {
		this.lookups.push(request);
		return { ok: true, value: this.entries.get(request.key) ?? null };
	}

	async put(entry: ApprovalBaselineCacheEntry): Promise<Result<void>> {
		this.entries.set(entry.key, entry);
		return { ok: true, value: undefined };
	}
}

const emptyBaselineIdentity = {
	childEnv: { PATH: "/usr/bin" },
	toolchain: { shell: "bash-5" },
	os: "test-os",
	arch: "test-arch",
	adapterVersion: "command-v1",
} as const;

function requestFixture(
	options: {
		readonly expectedHash?: string;
		readonly checks?: readonly CheckSpec[];
		readonly setup?: readonly CheckSpec[];
		readonly acceptanceChecks?: readonly CheckSpec[];
		readonly filesystem?: MemoryFileSystem;
		readonly workspace?: FixtureWorkspace;
		readonly process?: FixtureProcess;
		readonly cache?: MemoryBaselineCache;
		readonly setupKey?: string | null;
		readonly baselineStatus?: number;
		readonly acceptanceStatus?: number;
		readonly setupStatus?: number;
		readonly baselineStdout?: string;
		readonly setupStdout?: string;
		readonly acceptanceStdout?: string;
		readonly baseTree?: string;
		readonly shapeWarnings?: Uint8Array;
	} = {},
): {
	readonly request: ApprovalPreflightRequest;
	readonly filesystem: MemoryFileSystem;
	readonly workspace: FixtureWorkspace;
	readonly process: FixtureProcess;
	readonly cache: MemoryBaselineCache;
} {
	const filesystem = options.filesystem ?? new MemoryFileSystem();
	const workspace =
		options.workspace ?? new FixtureWorkspace(filesystem, "b".repeat(40));
	const process = options.process ?? new FixtureProcess();
	process.baselineStatus = options.baselineStatus ?? 0;
	process.acceptanceStatus = options.acceptanceStatus ?? 0;
	process.setupStatus = options.setupStatus ?? 0;
	if (options.baselineStdout !== undefined)
		Object.assign(process, { baselineStdout: options.baselineStdout });
	if (options.setupStdout !== undefined)
		Object.assign(process, { setupStdout: options.setupStdout });
	if (options.acceptanceStdout !== undefined)
		Object.assign(process, { acceptanceStdout: options.acceptanceStdout });
	filesystem.put(CHECKOUT, ".kogen/intents/greet/intent.md", INTENT);
	filesystem.put(CHECKOUT, ".kogen/acceptance/greet.t.sh", ACCEPTANCE);
	if (options.shapeWarnings !== undefined)
		filesystem.put(
			CHECKOUT,
			".kogen/intents/greet/shape-warnings.json",
			options.shapeWarnings,
		);
	const cache = options.cache ?? new MemoryBaselineCache();
	const adapter = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "checks/acceptance.sh", "{path}"],
	});
	if (!adapter.ok) throw new Error(adapter.error.message);
	const request: ApprovalPreflightRequest = {
		slug: "greet",
		intentPath: ".kogen/intents/greet/intent.md",
		base: "main",
		baseCommit: BASE_COMMIT,
		baseTree: options.baseTree ?? BASE_TREE,
		approver: "Kogen Test <test@kogen.invalid>",
		scratchRoot: "/tmp/approval-preflight-scratch",
		runDirectory: RUN_DIRECTORY,
		environment: { PATH: "/usr/bin" },
		project: {
			setup: options.setup ?? [],
			checks: options.checks ?? [],
			acceptanceChecks: options.acceptanceChecks ?? [],
		},
		setupKey: options.setupKey ?? "setup-key-v1",
		baselineIdentity: emptyBaselineIdentity,
		adapter: adapter.value,
		process,
		filesystem,
		workspace,
		baselineCache: cache,
		...(options.expectedHash === undefined
			? {}
			: { expectedHash: options.expectedHash }),
	};
	return { request, filesystem, workspace, process, cache };
}

const oneCheck: CheckSpec = {
	name: "lint",
	argv: ["sh", "checks/lint.sh"],
	timeoutMs: 60_000,
};

const setupCheck: CheckSpec = {
	name: "setup",
	argv: ["sh", "checks/setup.sh"],
	timeoutMs: 60_000,
};

const syntaxCheck: CheckSpec = {
	name: "syntax",
	argv: ["sh", "-n", "{path}"],
	timeoutMs: 60_000,
};

test("approval card renders the frozen card fields and exact approval hash", async () => {
	const { request } = requestFixture();
	const result = await preflightApproval(request);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.exitCode).toBe(5);
	expect(result.value.approvalSha256).toBe(
		hashApprovalBytes(INTENT, ACCEPTANCE),
	);
	expect(result.value.card?.split("\n")).toEqual([
		"Intent: greet — Greet Almir by name",
		`SHA-256: ${hashApprovalBytes(INTENT, ACCEPTANCE)}`,
		"Approver: Kogen Test <test@kogen.invalid>",
		`Base: main at ${BASE_COMMIT}`,
		"Feasibility: not checked",
		"",
		"Brief",
		"  Change the greeting in lib/greet.txt so that it names Almir,",
		"  and keep lib/greet.txt a single line.",
		"",
		"Acceptance",
		"  - [A1] lib/greet.txt contains the line Hello, Almir! (test)",
		"  - [A2] lib/greet.txt has exactly one line. (test keep)",
		"",
		"Approve with:",
		`  kogen intent approve greet ${hashApprovalBytes(INTENT, ACCEPTANCE).slice(0, 8)}`,
	]);
});

test("hash mismatch refuses before setup, cache access, checks, or scratch creation", async () => {
	const { request, process, workspace, cache } = requestFixture({
		expectedHash: "abcdef00",
		setup: [setupCheck],
		checks: [oneCheck],
		acceptanceChecks: [syntaxCheck],
	});
	const result = await preflightApproval(request);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("intent/hash_mismatch");
	expect(result.error.exitCode).toBe(1);
	expect(result.error.message).toContain("not abcdef00");
	expect(process.requests).toHaveLength(0);
	expect(workspace.createCount).toBe(0);
	expect(cache.lookups).toHaveLength(0);
});

test("setup runs before checks in an exact-base scratch when the checkout differs", async () => {
	const { request, process, workspace, filesystem } = requestFixture({
		setup: [setupCheck],
		checks: [oneCheck],
		acceptanceChecks: [syntaxCheck],
	});
	const originalCheckoutIntent = filesystem.files
		.get(`${CHECKOUT}\0.kogen/intents/greet/intent.md`)
		?.slice();
	const result = await preflightApproval(request);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.checkedInScratch).toBe(true);
	expect(result.value.checkoutTree).toBe("b".repeat(40));
	expect(workspace.createCount).toBe(1);
	expect(process.order).toEqual(["setup", "check", "acceptance"]);
	expect(process.requests.every((call) => call.cwd === SCRATCH)).toBe(true);
	expect(workspace.scratchTreeValue?.restoreCount).toBe(1);
	expect(workspace.removeCount).toBe(1);
	expect(
		filesystem.files.get(`${CHECKOUT}\0.kogen/intents/greet/intent.md`),
	).toEqual(originalCheckoutIntent);
	expect(filesystem.files.has(`${CHECKOUT}\0test/acceptance/greet.t.sh`)).toBe(
		false,
	);
});

test("a red acceptance check refuses approval and still restores and removes scratch", async () => {
	const { request, process, workspace } = requestFixture({
		checks: [oneCheck],
		acceptanceChecks: [syntaxCheck],
		acceptanceStatus: 1,
		acceptanceStdout: "syntax error near unexpected token\n",
	});
	const result = await preflightApproval({
		...request,
		expectedHash: hashApprovalBytes(INTENT, ACCEPTANCE).slice(0, 8),
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("check/acceptance_check_failed");
	expect(result.error.exitCode).toBe(1);
	expect(result.error.details).toContain("syntax error near unexpected token");
	expect(process.order).toEqual(["check", "acceptance"]);
	expect(workspace.scratchTreeValue?.restoreCount).toBe(1);
	expect(workspace.removeCount).toBe(1);
});

test("setup failure stops before checks and preserves the setup diagnostics", async () => {
	const { request, process, workspace } = requestFixture({
		setup: [setupCheck],
		checks: [oneCheck],
		acceptanceChecks: [syntaxCheck],
		setupStatus: 7,
		setupStdout: "setup broke: no build dir\n",
	});
	const result = await preflightApproval(request);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("environment/setup_failed");
	expect(result.error.exitCode).toBe(3);
	expect(result.error.message).toContain("status=7, timed_out=false");
	expect(result.error.details).toContain("setup broke: no build dir");
	expect(process.order).toEqual(["setup"]);
	expect(workspace.scratchTreeValue?.restoreCount).toBe(1);
	expect(workspace.removeCount).toBe(1);
});

test("unavailable acceptance check uses the environment refusal class", async () => {
	const { request } = requestFixture({
		acceptanceChecks: [syntaxCheck],
	});
	const process = new FixtureProcess();
	const requestWithMissingTool = { ...request, process };
	process.run = async (call) => {
		process.requests.push(call);
		return {
			ok: true,
			value: {
				exitCode: 127,
				signal: null,
				stdout: new Uint8Array(),
				stderr: bytes("missing tool\n"),
				timedOut: false,
			},
		};
	};
	const result = await preflightApproval(requestWithMissingTool);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe("environment/acceptance_check_unavailable");
	expect(result.error.exitCode).toBe(3);
});

test("baseline cache v3 binds the exact checked tree and refuses unknown identities", () => {
	const material = {
		checkedBaseTree: BASE_TREE,
		setupKey: "setup-key-v1",
		checks: [oneCheck],
		childEnv: { PATH: "/usr/bin" },
		toolchain: { shell: "bash-5" },
		os: "darwin",
		arch: "arm64",
		adapterVersion: "command-v1",
	};
	const baseKey = approvalBaselineCacheKey(material);
	const changedTreeKey = approvalBaselineCacheKey({
		...material,
		checkedBaseTree: "d".repeat(40),
	});
	expect(baseKey).not.toBeNull();
	expect(changedTreeKey).not.toBe(baseKey);
	expect(approvalBaselineCacheKey({ ...material, toolchain: null })).toBeNull();
});

test("cached baseline is reused only for its exact checked-base identity", async () => {
	const cache = new MemoryBaselineCache();
	const first = requestFixture({ checks: [oneCheck], cache });
	const firstResult = await preflightApproval(first.request);
	expect(firstResult.ok).toBe(true);
	const firstKey = firstResult.ok ? firstResult.value.baselineCacheKey : null;
	expect(firstKey).not.toBeNull();
	const second = requestFixture({ checks: [oneCheck], cache });
	const secondResult = await preflightApproval(second.request);
	expect(secondResult.ok).toBe(true);
	if (secondResult.ok) expect(secondResult.value.baselineCacheHit).toBe(true);
	expect(second.process.order).toEqual([]);

	const changed = requestFixture({
		checks: [oneCheck],
		cache,
		baseTree: "d".repeat(40),
	});
	const changedResult = await preflightApproval(changed.request);
	expect(changedResult.ok).toBe(true);
	if (changedResult.ok)
		expect(changedResult.value.baselineCacheHit).toBe(false);
	expect(changed.process.order).toEqual(["check"]);
	expect(cache.lookups.at(-1)?.checkedBaseTree).toBe("d".repeat(40));
});

test("matching shape warnings are shown and stale warning bytes are ignored", async () => {
	const digest = hashApprovalBytes(INTENT, ACCEPTANCE);
	const fresh = requestFixture({
		shapeWarnings: bytes(
			JSON.stringify({
				approval_sha256: digest,
				warnings: [
					{
						code: "feasibility_concern",
						item_ids: [],
						message: "The fixture cannot render emoji",
					},
				],
			}),
		),
	});
	const freshResult = await preflightApproval(fresh.request);
	expect(freshResult.ok).toBe(true);
	if (freshResult.ok)
		expect(freshResult.value.card).toContain(
			"  - feasibility_concern: - — The fixture cannot render emoji",
		);

	const stale = requestFixture({
		shapeWarnings: bytes(
			JSON.stringify({
				approval_sha256: "0".repeat(64),
				warnings: [
					{
						code: "shape_reclassified",
						item_ids: ["A1"],
						message: "stale warning text",
					},
				],
			}),
		),
	});
	const staleResult = await preflightApproval(stale.request);
	expect(staleResult.ok).toBe(true);
	if (staleResult.ok) {
		expect(staleResult.value.card).not.toContain("Warnings");
		expect(staleResult.value.card).not.toContain("stale warning text");
	}
});

test("red baseline renders the finding row but does not refuse approval", async () => {
	const { request } = requestFixture({
		checks: [oneCheck],
		baselineStatus: 1,
		baselineStdout:
			"lib/greet.txt:2:1: error: [lint/todo] greet.txt: TODO found\n",
	});
	const result = await preflightApproval(request);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.exitCode).toBe(5);
	expect(result.value.checkBaseline[0]?.status).toBe("red");
	expect(result.value.card).toContain(
		"  - lint: [lint/todo] lib/greet.txt:2: greet.txt: TODO found",
	);
});
