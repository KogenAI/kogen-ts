import { expect, test } from "bun:test";
import { createCommandAdapter } from "../../packages/core/src/adapters/command";
import type {
	AcceptanceLedgerRow,
	AdapterRunResult,
} from "../../packages/core/src/adapters/interface";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	evaluateAcceptanceLedger,
	runAcceptanceLedger,
} from "../../packages/core/src/gate/ledger";

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
				error: {
					code: "not_found",
					message: "fixture file not found",
					retryable: false,
				},
			};
		if (value.byteLength > request.maxBytes)
			return {
				ok: false,
				error: {
					code: "invalid_input",
					message: "fixture file exceeds byte limit",
					retryable: false,
				},
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
				error: {
					code: "not_found",
					message: "fixture file not found",
					retryable: false,
				},
			};
		return { ok: true, value: undefined };
	}

	put(root: string, path: string, bytes: Uint8Array): void {
		this.files.set(this.key(root, path), bytes.slice());
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(this.key(root, path))?.slice();
	}
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function rows(...values: readonly AcceptanceLedgerRow[]): Uint8Array {
	return bytes(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function runResult(
	exitStatus: number | null,
	options: { readonly timedOut?: boolean } = {},
): AdapterRunResult {
	return {
		exitStatus,
		timedOut: options.timedOut ?? false,
		log: { stdout: new Uint8Array(), stderr: new Uint8Array() },
	};
}

function classifications(result: ReturnType<typeof evaluateAcceptanceLedger>) {
	if (!result.ok) throw new Error(result.error.message);
	return result.value.failures.map((item) => item.classification);
}

const common = {
	slug: "hello-world",
	itemIds: ["A1", "A2"],
	treeBefore: "a".repeat(40),
	treeAfter: "a".repeat(40),
} as const;

test("command adapter paths and staging move the approved source into the candidate tree", async () => {
	const adapter = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "run-acceptance.sh", "{path}"],
	});
	expect(adapter.ok).toBe(true);
	if (!adapter.ok) throw new Error(adapter.error.message);
	expect(adapter.value.sourcePath("hello-world")).toBe(
		".kogen/acceptance/hello-world.t.sh",
	);
	expect(adapter.value.candidatePath("hello-world")).toBe(
		"test/acceptance/hello-world.t.sh",
	);

	const filesystem = new MemoryFileSystem();
	filesystem.put(
		"/workspace",
		".kogen/acceptance/hello-world.t.sh",
		bytes("t_A1() { true; }\n"),
	);
	const staged = await adapter.value.stage({
		filesystem,
		sourceRoot: "/workspace",
		workdir: "/workspace",
		slug: "hello-world",
	});
	expect(staged).toEqual({
		ok: true,
		value: {
			sourcePath: ".kogen/acceptance/hello-world.t.sh",
			candidatePath: "test/acceptance/hello-world.t.sh",
			bytesWritten: bytes("t_A1() { true; }\n").byteLength,
		},
	});
	expect(
		filesystem.get("/workspace", ".kogen/acceptance/hello-world.t.sh"),
	).toBe(undefined);
	expect(
		new TextDecoder().decode(
			filesystem.get("/workspace", "test/acceptance/hello-world.t.sh"),
		),
	).toBe("t_A1() { true; }\n");
});

test("command adapter refuses an occupied candidate path without replacing it", async () => {
	const adapter = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "{path}"],
	});
	if (!adapter.ok) throw new Error(adapter.error.message);
	const filesystem = new MemoryFileSystem();
	filesystem.put(
		"/source",
		".kogen/acceptance/hello-world.t.sh",
		bytes("source"),
	);
	filesystem.put(
		"/workspace",
		"test/acceptance/hello-world.t.sh",
		bytes("kept"),
	);
	const staged = await adapter.value.stage({
		filesystem,
		sourceRoot: "/source",
		workdir: "/workspace",
		slug: "hello-world",
	});
	expect(staged.ok).toBe(false);
	if (staged.ok) throw new Error("occupied candidate path was accepted");
	expect(staged.error.code).toBe("conflict");
	expect(
		new TextDecoder().decode(
			filesystem.get("/workspace", "test/acceptance/hello-world.t.sh"),
		),
	).toBe("kept");
});

test("ledger runner expands argv, overrides ledger variables, clears stale rows, and compares trees", async () => {
	const adapterResult = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "run-acceptance.sh", "{path}"],
	});
	if (!adapterResult.ok) throw new Error(adapterResult.error.message);
	const adapter = adapterResult.value;
	const filesystem = new MemoryFileSystem();
	filesystem.put("/run", "ledger.jsonl", bytes("stale row\n"));
	const calls: ProcessRequest[] = [];
	const process = {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			calls.push(request);
			filesystem.put(
				"/run",
				"ledger.jsonl",
				rows({ tag: "hello-world/A1", test: "greets", status: "passed" }),
			);
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: bytes("ok\n"),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	let snapshots = 0;
	const result = await runAcceptanceLedger({
		adapter,
		process,
		filesystem,
		tree: {
			async snapshot() {
				snapshots += 1;
				return { ok: true, value: "b".repeat(40) };
			},
		},
		workdir: "/workspace",
		slug: "hello-world",
		itemIds: ["A1", "A2"],
		reportDirectory: "/run",
		reportFilename: "ledger.jsonl",
		environment: { PATH: "/bin", KOGEN_INTENT_SLUG: "wrong" },
		timeoutMilliseconds: 1200,
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(snapshots).toBe(2);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.argv).toEqual([
		"sh",
		"run-acceptance.sh",
		"test/acceptance/hello-world.t.sh",
	]);
	expect(calls[0]?.cwd).toBe("/workspace");
	expect(calls[0]?.timeoutMilliseconds).toBe(1200);
	expect(calls[0]?.env.KOGEN_LEDGER_REPORT).toBe("/run/ledger.jsonl");
	expect(calls[0]?.env.KOGEN_INTENT_SLUG).toBe("hello-world");
	expect(result.value.items).toEqual([
		{
			id: "A1",
			status: "pass",
			rows: [{ tag: "hello-world/A1", test: "greets", status: "passed" }],
		},
		{ id: "A2", status: "fail", rows: [] },
	]);
});

test("ledger runner detects a real pre/post tree identity difference", async () => {
	const adapterResult = createCommandAdapter({
		extension: ".t.sh",
		candidateDirectory: "test/acceptance",
		run: ["sh", "{path}"],
	});
	if (!adapterResult.ok) throw new Error(adapterResult.error.message);
	const filesystem = new MemoryFileSystem();
	const process = {
		async run(): Promise<Result<ProcessResult>> {
			filesystem.put(
				"/run",
				"ledger.jsonl",
				rows({ tag: "hello-world/A1", test: "greets", status: "passed" }),
			);
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
	let snapshots = 0;
	const result = await runAcceptanceLedger({
		adapter: adapterResult.value,
		process,
		filesystem,
		tree: {
			async snapshot() {
				snapshots += 1;
				return {
					ok: true,
					value: snapshots === 1 ? "d".repeat(40) : "e".repeat(40),
				};
			},
		},
		workdir: "/workspace",
		slug: "hello-world",
		itemIds: ["A1"],
		reportDirectory: "/run",
		reportFilename: "ledger.jsonl",
		environment: {},
		timeoutMilliseconds: 1000,
	});
	if (!result.ok) throw new Error(result.error.message);
	expect(snapshots).toBe(2);
	expect(result.value.items[0]?.status).toBe("pass");
	expect(result.value.failures.map((item) => item.classification)).toEqual([
		"tree_mutated",
	]);
});

test("missing, empty and malformed reports follow the unavailable/compile/empty matrix", () => {
	const missingUnavailable = evaluateAcceptanceLedger({
		...common,
		run: runResult(null),
		report: null,
	});
	expect(classifications(missingUnavailable)).toEqual(["tool_missing"]);
	if (!missingUnavailable.ok) throw new Error(missingUnavailable.error.message);
	expect(missingUnavailable.value.failures[0]?.scope).toBe("environment");

	const emptyUnavailable = evaluateAcceptanceLedger({
		...common,
		run: runResult(127),
		report: new Uint8Array(),
	});
	expect(classifications(emptyUnavailable)).toEqual(["tool_missing"]);

	const emptyNonzero = evaluateAcceptanceLedger({
		...common,
		run: runResult(1),
		report: new Uint8Array(),
	});
	expect(classifications(emptyNonzero)).toEqual(["acceptance_compile_failed"]);

	const emptySuccess = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: new Uint8Array(),
	});
	expect(classifications(emptySuccess)).toEqual(["no_tagged_tests"]);

	const malformed = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: bytes('{"tag":"hello-world/A1","test":"bad","status":"ok"}\n'),
	});
	expect(classifications(malformed)).toEqual(["ledger_invalid"]);

	const malformedUnavailable = evaluateAcceptanceLedger({
		...common,
		run: runResult(126),
		report: bytes("not json\n"),
	});
	expect(classifications(malformedUnavailable)).toEqual(["tool_missing"]);
});

test("timeout and any workspace tree change are independently reported", () => {
	const timeout = evaluateAcceptanceLedger({
		...common,
		run: runResult(null, { timedOut: true }),
		report: null,
	});
	expect(classifications(timeout)).toEqual(["acceptance_timeout"]);

	const mutation = evaluateAcceptanceLedger({
		...common,
		treeAfter: "c".repeat(40),
		run: runResult(0),
		report: rows({ tag: "hello-world/A1", test: "greets", status: "passed" }),
	});
	expect(classifications(mutation)).toEqual(["tree_mutated"]);

	const timeoutAndMutation = evaluateAcceptanceLedger({
		...common,
		treeAfter: "c".repeat(40),
		run: runResult(null, { timedOut: true }),
		report: null,
	});
	expect(classifications(timeoutAndMutation)).toEqual([
		"tree_mutated",
		"acceptance_timeout",
	]);
});

test("item status requires rows and every row must pass; unknown tags and inconsistent exit fail suite", () => {
	const mixed = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: rows(
			{ tag: "hello-world/A1", test: "passes", status: "passed" },
			{ tag: "hello-world/A1", test: "skipped", status: "skipped" },
			{ tag: "hello-world/A2", test: "passes", status: "passed" },
		),
	});
	if (!mixed.ok) throw new Error(mixed.error.message);
	expect(mixed.value.items.map((item) => item.status)).toEqual([
		"fail",
		"pass",
	]);
	expect(mixed.value.failures).toEqual([]);

	const unknown = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: rows(
			{ tag: "hello-world/A1", test: "passes", status: "passed" },
			{ tag: "hello-world/A2", test: "passes", status: "passed" },
			{ tag: "hello-world/A9", test: "unexpected", status: "passed" },
		),
	});
	if (!unknown.ok) throw new Error(unknown.error.message);
	expect(unknown.value.unknownTags).toEqual(["hello-world/A9"]);
	expect(unknown.value.failures.map((item) => item.classification)).toEqual([
		"suite",
	]);

	const nonzeroAllPass = evaluateAcceptanceLedger({
		...common,
		run: runResult(1),
		report: rows(
			{ tag: "hello-world/A1", test: "one", status: "passed" },
			{ tag: "hello-world/A2", test: "two", status: "passed" },
		),
	});
	expect(classifications(nonzeroAllPass)).toEqual(["suite"]);
});

test("invalid UTF-8 and non-exact JSONL row schemas are malformed", () => {
	const invalidUtf8 = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: new Uint8Array([0xff, 0x0a]),
	});
	expect(classifications(invalidUtf8)).toEqual(["ledger_invalid"]);

	const extraField = evaluateAcceptanceLedger({
		...common,
		run: runResult(0),
		report: bytes(
			'{"tag":"hello-world/A1","test":"greets","status":"passed","extra":true}\n',
		),
	});
	expect(classifications(extraField)).toEqual(["ledger_invalid"]);
});
