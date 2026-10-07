import { expect, test } from "bun:test";
import type {
	AcceptanceAdapter,
	AdapterRunResult,
} from "../../packages/core/src/adapters/interface";
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
import { formatGateFeedback } from "../../packages/core/src/gate/feedback";
import {
	countDistinctFindingIdentities,
	parseGateFindings,
} from "../../packages/core/src/gate/findings";
import {
	type GateCheckBaseline,
	isCheckExcused,
	verifyGate,
} from "../../packages/core/src/gate/verify";

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

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
			return { ok: false, error: portError("not_found", "file not found") };
		if (value.byteLength > request.maxBytes)
			return { ok: false, error: portError("invalid_input", "file too large") };
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
			return { ok: false, error: portError("not_found", "file not found") };
		return { ok: true, value: undefined };
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(this.key(root, path))?.slice();
	}
}

class MemoryTree implements GateTreePort {
	identity = "tree-0";
	readonly files = new Map<string, string>();
	readonly checkpoints = new Map<
		string,
		{ identity: string; files: Map<string, string> }
	>();
	restoreCount = 0;
	private nextToken = 0;

	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		this.nextToken += 1;
		const restoreToken = `snapshot-${this.nextToken}`;
		this.checkpoints.set(restoreToken, {
			identity: this.identity,
			files: new Map(this.files),
		});
		return { ok: true, value: { identity: this.identity, restoreToken } };
	}

	async changedPaths(
		before: GateTreeSnapshot,
		after: GateTreeSnapshot,
	): Promise<Result<readonly string[]>> {
		const a = this.checkpoints.get(before.restoreToken);
		const b = this.checkpoints.get(after.restoreToken);
		if (a === undefined || b === undefined)
			return { ok: false, error: portError("not_found", "snapshot not found") };
		const paths = new Set([...a.files.keys(), ...b.files.keys()]);
		return {
			ok: true,
			value: [...paths]
				.filter((path) => a.files.get(path) !== b.files.get(path))
				.sort(),
		};
	}

	async restore(snapshot: GateTreeSnapshot): Promise<Result<void>> {
		const saved = this.checkpoints.get(snapshot.restoreToken);
		if (saved === undefined)
			return { ok: false, error: portError("not_found", "snapshot not found") };
		this.identity = saved.identity;
		this.files.clear();
		for (const [path, value] of saved.files) this.files.set(path, value);
		this.restoreCount += 1;
		return { ok: true, value: undefined };
	}
}

function processResult(
	exitCode: number | null,
	stdout = "",
	stderr = "",
	options: { readonly timedOut?: boolean } = {},
): ProcessResult {
	return {
		exitCode,
		signal: null,
		stdout: bytes(stdout),
		stderr: bytes(stderr),
		timedOut: options.timedOut ?? false,
	};
}

function acceptedRun(
	exitStatus = 0,
	stdout = "",
	stderr = "",
): AdapterRunResult {
	return {
		exitStatus,
		timedOut: false,
		log: { stdout: bytes(stdout), stderr: bytes(stderr) },
	};
}

function adapterWithRows(
	filesystem: MemoryFileSystem,
	reportDirectory: string,
	reportFilename: string,
	options: {
		readonly rows?: readonly { tag: string; test: string; status: string }[];
		readonly run?: AdapterRunResult;
		readonly unavailable?: (log: {
			stdout: Uint8Array;
			stderr: Uint8Array;
		}) => boolean;
	} = {},
): AcceptanceAdapter {
	return {
		name: "fixture",
		sourcePath: (slug) => `.kogen/acceptance/${slug}.t.sh`,
		candidatePath: (slug) => `test/acceptance/${slug}.t.sh`,
		async stage() {
			return {
				ok: true,
				value: {
					sourcePath: ".kogen/acceptance/greet.t.sh",
					candidatePath: "test/acceptance/greet.t.sh",
					bytesWritten: 0,
				},
			};
		},
		async run(): Promise<Result<AdapterRunResult>> {
			const report = (
				options.rows ?? [
					{ tag: "greet/A1", test: "test greet", status: "passed" },
				]
			)
				.map((row) => JSON.stringify(row))
				.join("\n");
			const written = await filesystem.writeFileAtomically({
				root: reportDirectory,
				path: reportFilename,
				bytes: bytes(`${report}\n`),
				mode: 0o600,
			});
			if (!written.ok) return written;
			return { ok: true, value: options.run ?? acceptedRun() };
		},
		...(options.unavailable === undefined
			? {}
			: { unavailable: options.unavailable }),
	};
}

function baseRequest(
	overrides: {
		readonly tree?: MemoryTree;
		readonly filesystem?: MemoryFileSystem;
		readonly process?: Pick<
			{ run(request: ProcessRequest): Promise<Result<ProcessResult>> },
			"run"
		>;
		readonly checks?: readonly {
			name: string;
			argv: readonly string[];
			timeoutMs: number;
		}[];
		readonly fixes?: readonly {
			name: string;
			argv: readonly string[];
			timeoutMs: number;
		}[];
		readonly baselines?: readonly GateCheckBaseline[];
		readonly adapter?: AcceptanceAdapter;
	} = {},
) {
	const filesystem = overrides.filesystem ?? new MemoryFileSystem();
	const tree = overrides.tree ?? new MemoryTree();
	const reportDirectory = "/run";
	const reportFilename = "acceptance.jsonl";
	const process = overrides.process ?? {
		async run() {
			return { ok: true as const, value: processResult(0) };
		},
	};
	return {
		filesystem,
		tree,
		request: {
			process,
			filesystem,
			tree,
			workdir: "/work",
			runDirectory: reportDirectory,
			runId: "run-18",
			slug: "greet",
			itemIds: ["A1"],
			environment: {},
			fixes: overrides.fixes ?? [],
			checks: overrides.checks ?? [],
			baselines: overrides.baselines ?? [],
			acceptance: {
				adapter:
					overrides.adapter ??
					adapterWithRows(filesystem, reportDirectory, reportFilename),
				reportDirectory,
				reportFilename,
				timeoutMilliseconds: 1_000,
			},
		},
	};
}

test("test symbols participate in stable finding identity and unique failure counts", () => {
	const findings = parseGateFindings(
		bytes(
			[
				"test/unit/greet.t.sh:1:1: error: [kt/test] beta: failed",
				"test/unit/greet.t.sh:9:4: error: [kt/test] beta: still failed",
				"test/unit/greet.t.sh:10:1: error: [kt/test] alpha: failed",
				"lib/note.txt:1:1: error: [lint/todo] note.txt: TODO found",
			].join("\n"),
		),
		new Uint8Array(),
		"unit",
	);

	expect(findings[0]?.symbol).toBe("beta");
	expect(findings[0]?.message).toBe("failed");
	expect(findings[3]?.symbol).toBe("");
	expect(countDistinctFindingIdentities(findings.slice(0, 2))).toBe(1);
	const distinctPair = findings.filter(
		(_, index) => index === 0 || index === 2,
	);
	expect(countDistinctFindingIdentities(distinctPair)).toBe(2);
});

test("unavailable checks are excused only when the base had the same status and exit", () => {
	const baseline: GateCheckBaseline = {
		name: "ghost",
		status: "unavailable",
		exitStatus: 127,
		findings: [],
	};
	expect(
		isCheckExcused(baseline, {
			status: "unavailable",
			exitStatus: 127,
			findings: [],
		}),
	).toBe(true);
	expect(
		isCheckExcused(baseline, {
			status: "unavailable",
			exitStatus: 126,
			findings: [],
		}),
	).toBe(false);
	expect(
		isCheckExcused(
			{ ...baseline, status: "green", exitStatus: 0 },
			{
				status: "unavailable",
				exitStatus: 127,
				findings: [],
			},
		),
	).toBe(false);
});

test("a mutating base-red check is restored to the post-fix verification tree", async () => {
	const tree = new MemoryTree();
	tree.files.set("lib/greet.txt", "Hello!\n");
	const request = baseRequest({
		tree,
		checks: [{ name: "touchy", argv: ["touchy"], timeoutMs: 500 }],
		baselines: [
			{
				name: "touchy",
				status: "mutating",
				exitStatus: 0,
				findings: [],
			},
		],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				tree.identity = "mutated-tree";
				tree.files.set("lib/generated.txt", "check artifact\n");
				return { ok: true, value: processResult(0) };
			},
		},
	});

	const result = await verifyGate(request.request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value.checks[0]?.status).toBe("mutating");
	expect(result.value.checks[0]?.excused).toBe(true);
	expect(result.value.checks[0]?.changedPaths).toEqual(["lib/generated.txt"]);
	expect(result.value.checks[0]?.restoredTree).toBe("tree-0");
	expect(tree.identity).toBe("tree-0");
	expect(tree.files.has("lib/generated.txt")).toBe(false);
	expect(tree.restoreCount).toBe(1);
	expect(result.value.status).toBe("green");
	expect(formatGateFeedback(result.value)).toContain(
		"raw log: /run/gate-000001.stdout.log",
	);
});

test("fixes run once before checks and acceptance, in configured order", async () => {
	const order: string[] = [];
	const filesystem = new MemoryFileSystem();
	const reportDirectory = "/run";
	const reportFilename = "acceptance.jsonl";
	const request = baseRequest({
		filesystem,
		fixes: [{ name: "format", argv: ["fix"], timeoutMs: 100 }],
		checks: [{ name: "unit", argv: ["check"], timeoutMs: 100 }],
		process: {
			async run(input: ProcessRequest): Promise<Result<ProcessResult>> {
				order.push(input.argv[0] ?? "");
				return { ok: true, value: processResult(0) };
			},
		},
		adapter: {
			...adapterWithRows(filesystem, reportDirectory, reportFilename),
			async run(): Promise<Result<AdapterRunResult>> {
				order.push("acceptance");
				const write = await filesystem.writeFileAtomically({
					root: reportDirectory,
					path: reportFilename,
					bytes: bytes('{"tag":"greet/A1","test":"greet","status":"passed"}\n'),
					mode: 0o600,
				});
				return write.ok ? { ok: true, value: acceptedRun() } : write;
			},
		},
	});

	const result = await verifyGate(request.request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(order).toEqual(["fix", "check", "acceptance"]);
	expect(result.value.fixes).toHaveLength(1);
	expect(result.value.status).toBe("green");
	expect(request.filesystem.get("/run", "gate-000001.stdout.log")).toEqual(
		new Uint8Array(),
	);
	expect(
		request.filesystem.get("/run", "gate-findings-run-18.json"),
	).toBeDefined();
});

test("an unavailable current check is red unless the same unavailable result was recorded on base", async () => {
	const baseline: GateCheckBaseline = {
		name: "ghost",
		status: "unavailable",
		exitStatus: 127,
		findings: [],
	};
	const same = baseRequest({
		checks: [{ name: "ghost", argv: ["missing"], timeoutMs: 100 }],
		baselines: [baseline],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				return {
					ok: true,
					value: processResult(127, "", "sh: missing: not found\n"),
				};
			},
		},
	});
	const sameResult = await verifyGate(same.request);
	expect(sameResult.ok).toBe(true);
	if (!sameResult.ok) throw new Error(sameResult.error.message);
	expect(sameResult.value.checks[0]?.status).toBe("unavailable");
	expect(sameResult.value.checks[0]?.excused).toBe(true);
	expect(sameResult.value.status).toBe("green");

	const currentOnly = baseRequest({
		checks: [{ name: "ghost", argv: ["missing"], timeoutMs: 100 }],
		baselines: [{ ...baseline, status: "green", exitStatus: 0 }],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				return {
					ok: true,
					value: processResult(127, "", "sh: missing: not found\n"),
				};
			},
		},
	});
	const currentResult = await verifyGate(currentOnly.request);
	expect(currentResult.ok).toBe(true);
	if (!currentResult.ok) throw new Error(currentResult.error.message);
	expect(currentResult.value.checks[0]?.excused).toBe(false);
	expect(currentResult.value.status).toBe("red");
	expect(formatGateFeedback(currentResult.value)).toContain(
		"missing is not available, but it ran on the base",
	);
});

test("timeout and non-excused mutation feedback names the exact timeout and changed paths", async () => {
	const timed = baseRequest({
		checks: [{ name: "unit", argv: ["sh", "check.sh"], timeoutMs: 3_000 }],
		baselines: [{ name: "unit", status: "green", exitStatus: 0, findings: [] }],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				return {
					ok: true,
					value: processResult(null, "", "last test output\n", {
						timedOut: true,
					}),
				};
			},
		},
	});
	const timedResult = await verifyGate(timed.request);
	expect(timedResult.ok).toBe(true);
	if (!timedResult.ok) throw new Error(timedResult.error.message);
	expect(formatGateFeedback(timedResult.value)).toContain(
		"timed out after 3 s",
	);

	const tree = new MemoryTree();
	const mutating = baseRequest({
		tree,
		checks: [{ name: "unit", argv: ["unit"], timeoutMs: 3_000 }],
		baselines: [{ name: "unit", status: "green", exitStatus: 0, findings: [] }],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				tree.identity = "mutated-tree";
				tree.files.set("lib/generated.txt", "generated\n");
				return { ok: true, value: processResult(0) };
			},
		},
	});
	const mutatedResult = await verifyGate(mutating.request);
	expect(mutatedResult.ok).toBe(true);
	if (!mutatedResult.ok) throw new Error(mutatedResult.error.message);
	expect(formatGateFeedback(mutatedResult.value)).toContain(
		"changed paths: lib/generated.txt",
	);
});

test("feedback clips findings per tool and keeps private directories in the raw tail", async () => {
	const output = Array.from({ length: 21 }, (_, index) => {
		const message = index === 0 ? "x".repeat(220) : `finding ${index}`;
		return `lib/file-${index}.txt:${index + 1}:1: error: [lint/todo] ${message}`;
	}).join("\n");
	const request = baseRequest({
		checks: [{ name: "lint", argv: ["lint"], timeoutMs: 100 }],
		process: {
			async run(): Promise<Result<ProcessResult>> {
				return {
					ok: true,
					value: processResult(
						1,
						"",
						`${output}\n/tmp/worker/log\n/Users/fixture/.cache\n`,
					),
				};
			},
		},
	});
	const result = await verifyGate(request.request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	const feedback = formatGateFeedback(result.value, {
		tmpDirectory: "/tmp/worker",
		homeDirectory: "/Users/fixture",
	});
	const findingBlock = feedback.split("\nraw log:")[0] ?? "";
	expect(findingBlock.match(/^lib\/file-[0-9]+\.txt:[^\n]+$/gmu)).toHaveLength(
		10,
	);
	expect(feedback).toContain("… 11 more lint findings");
	expect(feedback).toContain(`: error: [lint/todo] ${"x".repeat(200)}`);
	expect(feedback).toContain("raw tail (first failed step lint):");
	expect(feedback).toContain("$TMPDIR/log");
	expect(feedback).toContain("$HOME/.cache");
	expect(feedback).toContain(
		"gate: 21 errors, 0 warnings (lint=21); checks lint=red; acceptance 1/1",
	);
	expect(request.filesystem.get("/run", "gate-000001.stderr.log")).toEqual(
		bytes(`${output}\n/tmp/worker/log\n/Users/fixture/.cache\n`),
	);
});

test("a new test symbol prevents a base-red finding from being excused", () => {
	const baseFinding = {
		path: "test/unit/greet.t.sh",
		rule: "kt/test",
		symbol: "alpha",
		message: "failed on base",
	};
	const baseline: GateCheckBaseline = {
		name: "unit",
		status: "red",
		exitStatus: 1,
		findings: [baseFinding],
	};
	const current = parseGateFindings(
		bytes("test/unit/greet.t.sh:1:1: error: [kt/test] beta: failed"),
		new Uint8Array(),
		"unit",
	);
	expect(
		isCheckExcused(baseline, {
			status: "red",
			exitStatus: 1,
			findings: current,
		}),
	).toBe(false);
});

test("acceptance item failures retain identities but are reported as acceptance rows", async () => {
	const filesystem = new MemoryFileSystem();
	const reportDirectory = "/run";
	const reportFilename = "acceptance.jsonl";
	const request = baseRequest({
		filesystem,
		adapter: adapterWithRows(filesystem, reportDirectory, reportFilename, {
			rows: [{ tag: "greet/A1", test: "test greet", status: "failed" }],
			run: acceptedRun(1, "", "test failed\n"),
		}),
	});
	const result = await verifyGate(request.request);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value.status).toBe("red");
	expect(result.value.failureCount).toBeGreaterThan(0);
	const feedback = formatGateFeedback(result.value);
	expect(feedback).toContain("acceptance A1: failed");
	expect(feedback).toContain(
		"gate: 0 errors, 0 warnings (none); checks ; acceptance 0/1",
	);
});
