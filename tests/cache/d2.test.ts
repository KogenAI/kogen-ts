import { expect, test } from "bun:test";
import { createCommandAdapter } from "../../packages/core/src/adapters/command";
import {
	type ApprovalPreflightRequest,
	type ApprovalScratchWorkspace,
	type ApprovalWorkspacePort,
	preflightApproval,
} from "../../packages/core/src/approval/preflight";
import { createApprovalBaselineCache } from "../../packages/core/src/cache/baseline";
import {
	fingerprintSetupInput,
	type SetupCacheKeyInput,
	setupCacheKey,
} from "../../packages/core/src/cache/keys";
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
import {
	type GateCheckBaseline,
	isCheckExcused,
} from "../../packages/core/src/gate/verify";
import type { CheckSpec } from "../../packages/core/src/project/schema";

const CHECKOUT = "/tmp/cache-d2-checkout";
const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);
const INTENT = new TextEncoder().encode(
	"---\ntitle: Add a greeting\nsize: small\ndomains: [app]\n---\nAdd a greeting.\n\n## Acceptance\n- A1: lib/greet.txt contains Hello\n\n## Verify\n- A1: test\n\n## Request\nAdd a greeting.\n",
);
const TEST_BYTES = new TextEncoder().encode(
	"t_A1() { grep Hello lib/greet.txt; }\n",
);
const CHECK: CheckSpec = {
	name: "lint",
	argv: ["sh", "checks/lint.sh"],
	timeoutMs: 60_000,
};

function portError(code: PortError["code"], message: string): PortError {
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
			return {
				ok: false,
				error: portError("not_found", "file does not exist"),
			};
		if (value.byteLength > request.maxBytes)
			return {
				ok: false,
				error: portError("invalid_input", "file exceeds limit"),
			};
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
			return {
				ok: false,
				error: portError("not_found", "file does not exist"),
			};
		return { ok: true, value: undefined };
	}

	put(root: string, path: string, bytes: Uint8Array): void {
		this.files.set(this.key(root, path), bytes.slice());
	}
}

class MemoryTree implements GateTreePort {
	identity: string;
	private next = 0;
	private readonly saved = new Map<string, string>();

	constructor(identity: string) {
		this.identity = identity;
	}

	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		this.next += 1;
		const restoreToken = `snapshot-${this.next}`;
		this.saved.set(restoreToken, this.identity);
		return { ok: true, value: { identity: this.identity, restoreToken } };
	}

	async changedPaths(): Promise<Result<readonly string[]>> {
		return { ok: true, value: [] };
	}

	async restore(snapshot: GateTreeSnapshot): Promise<Result<void>> {
		const identity = this.saved.get(snapshot.restoreToken);
		if (identity === undefined)
			return { ok: false, error: portError("not_found", "snapshot missing") };
		this.identity = identity;
		return { ok: true, value: undefined };
	}
}

class MemoryWorkspace implements ApprovalWorkspacePort {
	readonly checkoutPath = CHECKOUT;
	readonly checkoutTree: GateTreePort = new MemoryTree("c".repeat(40));

	constructor(private readonly filesystem: MemoryFileSystem) {}

	async createScratch(request: {
		readonly baseCommit: string;
		readonly expectedTree: string;
		readonly scratchRoot: string;
		readonly slug: string;
	}): Promise<Result<ApprovalScratchWorkspace>> {
		const path = `${request.scratchRoot}/${request.slug}`;
		const tree = new MemoryTree(request.expectedTree);
		const scratch: ApprovalScratchWorkspace = {
			path,
			baseTree: request.expectedTree,
			tree,
			remove: async () => {
				for (const key of this.filesystem.files.keys())
					if (key.startsWith(`${path}\0`)) this.filesystem.files.delete(key);
				return { ok: true, value: undefined };
			},
		};
		return { ok: true, value: scratch };
	}
}

class FakeProcess {
	readonly calls: string[] = [];
	baselineStatus = 1;

	async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
		const baseline = request.argv.some((argument) =>
			argument.endsWith("lint.sh"),
		);
		this.calls.push(baseline ? "check" : "acceptance");
		return {
			ok: true,
			value: {
				exitCode: baseline ? this.baselineStatus : 0,
				signal: null,
				stdout:
					baseline && this.baselineStatus !== 0
						? new TextEncoder().encode(
								"lib/greet.txt:1:1: error: [lint/todo] greet.txt: TODO remains\n",
							)
						: new Uint8Array(),
				stderr: new Uint8Array(),
				timedOut: false,
			},
		};
	}
}

function setupInput(baseTree: string): SetupCacheKeyInput {
	const input = fingerprintSetupInput(
		"lockfile",
		0o644,
		new TextEncoder().encode("same dependencies\n"),
	);
	if (input === null) throw new Error("fixture input fingerprint invalid");
	return {
		baseTree,
		setup: [
			{ name: "setup", argv: ["sh", "checks/setup.sh"], timeoutMs: 60_000 },
		],
		setupOutputs: ["build"],
		setupInputs: ["lockfile"],
		inputs: [input],
		childEnv: { PATH: "/usr/bin" },
		os: "test-os",
		arch: "test-arch",
		elixir: "1.18.4",
		otp: "27.3.4",
	};
}

function request(
	filesystem: MemoryFileSystem,
	workspace: MemoryWorkspace,
	process: FakeProcess,
	baseTree: string,
	setupKey: string,
): ApprovalPreflightRequest {
	const adapter = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "checks/acceptance.sh", "{path}"],
	});
	if (!adapter.ok) throw new Error(adapter.error.message);
	return {
		slug: "greet",
		intentPath: ".kogen/intents/greet/intent.md",
		base: "main",
		baseCommit: "d".repeat(40),
		baseTree,
		approver: "Test <test@kogen.invalid>",
		scratchRoot: "/tmp/cache-d2-scratch",
		runDirectory: "/tmp/cache-d2-run",
		environment: { PATH: "/usr/bin" },
		project: { setup: [], checks: [CHECK], acceptanceChecks: [] },
		setupKey,
		baselineIdentity: {
			childEnv: { PATH: "/usr/bin" },
			toolchain: { shell: "test-shell-v1" },
			os: "test-os",
			arch: "test-arch",
			adapterVersion: "command-v1",
		},
		adapter: adapter.value,
		process,
		filesystem,
		workspace,
	};
}

test("D2: unchanged setup inputs reuse products while a new checked tree reruns baseline checks", async () => {
	const setupKeyA = setupCacheKey(setupInput(BASE_A));
	const setupKeyB = setupCacheKey(setupInput(BASE_B));
	expect(setupKeyA).not.toBeNull();
	expect(setupKeyB).toBe(setupKeyA);
	const setupKey = setupKeyA;
	if (setupKey === null) return;

	const filesystem = new MemoryFileSystem();
	filesystem.put(CHECKOUT, ".kogen/intents/greet/intent.md", INTENT);
	filesystem.put(CHECKOUT, ".kogen/acceptance/greet.t.sh", TEST_BYTES);
	const cache = createApprovalBaselineCache(filesystem, "/tmp/cache-d2-state");
	const processA = new FakeProcess();
	const workspaceA = new MemoryWorkspace(filesystem);
	const first = await preflightApproval({
		...request(filesystem, workspaceA, processA, BASE_A, setupKey),
		baselineCache: cache,
	});
	expect(first.ok).toBe(true);
	expect(processA.calls).toEqual(["check"]);
	if (!first.ok) return;
	expect(first.value.checkBaseline[0]?.status).toBe("red");

	const repeatedProcess = new FakeProcess();
	const repeated = await preflightApproval({
		...request(
			filesystem,
			new MemoryWorkspace(filesystem),
			repeatedProcess,
			BASE_A,
			setupKey,
		),
		baselineCache: cache,
	});
	expect(repeated.ok).toBe(true);
	if (repeated.ok) expect(repeated.value.baselineCacheHit).toBe(true);
	expect(repeatedProcess.calls).toEqual([]);

	const changedProcess = new FakeProcess();
	changedProcess.baselineStatus = 0;
	const changed = await preflightApproval({
		...request(
			filesystem,
			new MemoryWorkspace(filesystem),
			changedProcess,
			BASE_B,
			setupKey,
		),
		baselineCache: cache,
	});
	expect(changed.ok).toBe(true);
	if (!changed.ok) return;
	expect(changed.value.baselineCacheHit).toBe(false);
	expect(changed.value.checkBaseline[0]?.status).toBe("green");
	expect(changedProcess.calls).toEqual(["check"]);
	const baseline = changed.value.checkBaseline[0];
	if (baseline === undefined) throw new Error("baseline row missing");
	const gateBaseline: GateCheckBaseline = {
		name: baseline.name,
		status: baseline.status,
		exitStatus: baseline.exit_status,
		findings: baseline.findings,
	};
	expect(
		isCheckExcused(gateBaseline, {
			status: "red",
			exitStatus: 1,
			findings: [{ path: "lib/greet.txt", rule: "lint/todo", symbol: "TODO" }],
		}),
	).toBe(false);
});
