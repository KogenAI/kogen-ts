import { expect, test } from "bun:test";
import { checkBuildPrestart } from "../../packages/core/src/build/prestart";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { parseIntent } from "../../packages/core/src/intent/parse";
import { validateApprovalPredicates } from "../../packages/core/src/intent/predicates";
import type { JournalEvent } from "../../packages/core/src/run/journal";
import type { RunRecord } from "../../packages/core/src/run/store";
import { deriveStatus } from "../../packages/core/src/status/derive";

const encoder = new TextEncoder();
const slug = "greet-task";
const dependency = "base-api";
const baseCommit = "a".repeat(40);
const baseTree = "b".repeat(40);
const dependencyCommit = "c".repeat(40);
const approvalCommit = "d".repeat(40);
const staleIntentBytes = encoder.encode(
	[
		"---",
		"title: Greet",
		"size: small",
		"domains: [app]",
		"assumptions:",
		"  - name: Public API remains v2",
		"    path: contracts/api.md",
		'    contains: "version: 2"',
		"---",
		"Do the task.",
	].join("\n"),
);
const dependencyIntentBytes = encoder.encode(
	[
		"---",
		"title: Greet",
		"size: small",
		"domains: [app]",
		"blocks_on: [base-api]",
		"assumptions:",
		"  - name: Public API remains v2",
		"    path: contracts/api.md",
		'    contains: "version: 2"',
		"shared_contracts:",
		"  - name: Shared response envelope",
		"    path: contracts/response.md",
		"    contains: ResponseEnvelope",
		"---",
		"Do the task.",
	].join("\n"),
);

function parsedIntent(bytes: Uint8Array) {
	const result = parseIntent(bytes);
	if (!result.ok) throw new Error("Fixture Intent did not parse.");
	return result.intent;
}

function processResult(
	stdout: Uint8Array | string = new Uint8Array(),
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

class MemoryFileSystem implements Pick<FileSystemPort, "readFile"> {
	readonly files = new Map<string, Uint8Array>();
	readonly reads: { root: string; path: string; maxBytes: number }[] = [];

	async readFile(request: {
		readonly root: string;
		readonly path: string;
		readonly maxBytes: number;
	}): Promise<Result<Uint8Array>> {
		this.reads.push(request);
		const value = this.files.get(`${request.root}\0${request.path}`);
		if (value === undefined)
			return {
				ok: false,
				error: { code: "not_found", message: "missing", retryable: false },
			};
		if (value.byteLength > request.maxBytes)
			return {
				ok: false,
				error: {
					code: "invalid_input",
					message: "too large",
					retryable: false,
				},
			};
		return { ok: true, value: value.slice() };
	}

	put(root: string, path: string, value: string): void {
		this.files.set(`${root}\0${path}`, encoder.encode(value));
	}
}

class FakeGit implements Pick<GitPort, "command"> {
	readonly calls: string[][] = [];
	readonly baseFiles = new Map<string, Uint8Array>();
	dependencyLog = new Uint8Array();

	async command(
		request: Parameters<GitPort["command"]>[0],
	): Promise<Result<ProcessResult>> {
		const args = [...request.argv];
		this.calls.push(args);
		if (args[0] === "log")
			return { ok: true, value: processResult(this.dependencyLog) };
		if (args[0] === "cat-file" && args[1] === "blob") {
			const objectPath = args[2] ?? "";
			const path = objectPath.slice(objectPath.indexOf(":") + 1);
			const bytes = this.baseFiles.get(path);
			return bytes === undefined
				? { ok: true, value: processResult("missing", 1) }
				: { ok: true, value: processResult(bytes) };
		}
		return {
			ok: true,
			value: processResult("unsupported fake Git request", 1),
		};
	}
}

test("approval checks assumptions and shared contracts against the exact base", async () => {
	const filesystem = new MemoryFileSystem();
	filesystem.put(
		"/base/greet",
		"contracts/api.md",
		"API version: 2\nother text\n",
	);
	filesystem.put(
		"/base/greet",
		"contracts/response.md",
		"type ResponseEnvelope = {}\n",
	);
	const result = await validateApprovalPredicates({
		intent: parsedIntent(dependencyIntentBytes),
		baseRoot: "/base/greet",
		filesystem,
	});

	expect(result.ok).toBe(true);
	if (result.ok)
		expect(result.value).toEqual([
			{ name: "Public API remains v2", path: "contracts/api.md" },
			{ name: "Shared response envelope", path: "contracts/response.md" },
		]);
	expect(filesystem.reads.map(({ root, path }) => [root, path])).toEqual([
		["/base/greet", "contracts/api.md"],
		["/base/greet", "contracts/response.md"],
	]);
});

test("approval refuses a missing or changed base predicate", async () => {
	const missing = await validateApprovalPredicates({
		intent: parsedIntent(staleIntentBytes),
		baseRoot: "/base/greet",
		filesystem: new MemoryFileSystem(),
	});
	expect(missing).toMatchObject({
		ok: false,
		error: {
			code: "intent/predicate_missing",
			predicate: { path: "contracts/api.md" },
		},
	});

	const changedFs = new MemoryFileSystem();
	changedFs.put("/base/greet", "contracts/api.md", "API version: 3\n");
	const changed = await validateApprovalPredicates({
		intent: parsedIntent(staleIntentBytes),
		baseRoot: "/base/greet",
		filesystem: changedFs,
	});
	expect(changed).toMatchObject({
		ok: false,
		error: {
			code: "intent/predicate_changed",
			predicate: { name: "Public API remains v2" },
		},
	});
});

test("empty predicates skip approval reads and unsafe predicate paths are rejected", async () => {
	const filesystem = new MemoryFileSystem();
	const empty = await validateApprovalPredicates({
		intent: parsedIntent(
			encoder.encode("---\ntitle: Empty\nsize: small\ndomains: [app]\n---\n"),
		),
		baseRoot: "",
		filesystem,
	});
	expect(empty).toEqual({ ok: true, value: [] });
	expect(filesystem.reads).toHaveLength(0);

	const unsafeIntent = parsedIntent(
		encoder.encode(
			"---\ntitle: Unsafe\nsize: small\ndomains: [app]\nassumptions:\n  - name: Escape\n    path: ../outside\n    contains: secret\n---\n",
		),
	);
	const unsafe = await validateApprovalPredicates({
		intent: unsafeIntent,
		baseRoot: "/base/greet",
		filesystem,
	});
	expect(unsafe).toMatchObject({
		ok: false,
		error: { code: "intent/predicate_invalid" },
	});
	expect(filesystem.reads).toHaveLength(0);

	const emptyTextIntent = parsedIntent(
		encoder.encode(
			'---\ntitle: Empty text\nsize: small\ndomains: [app]\nassumptions:\n  - name: No expected text\n    path: contracts/api.md\n    contains: ""\n---\n',
		),
	);
	const emptyText = await validateApprovalPredicates({
		intent: emptyTextIntent,
		baseRoot: "/base/greet",
		filesystem,
	});
	expect(emptyText).toMatchObject({
		ok: false,
		error: { code: "intent/predicate_invalid" },
	});
	expect(filesystem.reads).toHaveLength(0);
});

test("pre-start records a recheck with the landed blocks_on commit", async () => {
	const git = new FakeGit();
	git.baseFiles.set("contracts/api.md", encoder.encode("API version: 2\n"));
	git.baseFiles.set(
		"contracts/response.md",
		encoder.encode("ResponseEnvelope\n"),
	);
	git.dependencyLog = encoder.encode(
		`${dependencyCommit}\u001f${dependency}\u001e\n`,
	);
	const result = await checkBuildPrestart({
		git,
		origin: "/repo",
		approval: { intentBytes: dependencyIntentBytes },
		base: { commit: baseCommit, tree: baseTree },
	});

	expect(result).toMatchObject({
		kind: "ready",
		event: {
			event: "shaping_rechecked",
			base: baseCommit,
			dependency_commits: [{ slug: dependency, commit: dependencyCommit }],
			predicates: [
				{
					name: "Public API remains v2",
					path: "contracts/api.md",
					contains: "version: 2",
				},
				{
					name: "Shared response envelope",
					path: "contracts/response.md",
					contains: "ResponseEnvelope",
				},
			],
		},
	});
	expect(git.calls.filter((args) => args[0] === "log")).toHaveLength(1);
});

test("pre-start blocks an unlanded blocks_on dependency before predicate reads", async () => {
	const git = new FakeGit();
	const result = await checkBuildPrestart({
		git,
		origin: "/repo",
		approval: { intentBytes: dependencyIntentBytes },
		base: { commit: baseCommit, tree: baseTree },
	});

	expect(result).toMatchObject({
		kind: "blocked",
		missingDependencies: [dependency],
		statusDetail: `waiting for delivered dependencies: ${dependency}`,
	});
	expect(git.calls.map((args) => args[0])).toEqual(["log"]);
});

test("pre-start emits shaping_stale and preserves the explanation in status", async () => {
	const git = new FakeGit();
	git.baseFiles.set("contracts/api.md", encoder.encode("API version: 3\n"));
	const result = await checkBuildPrestart({
		git,
		origin: "/repo",
		approval: { intentBytes: staleIntentBytes },
		base: { commit: baseCommit, tree: baseTree },
	});
	expect(result).toMatchObject({
		kind: "stale",
		event: {
			event: "shaping_stale",
			name: "Public API remains v2",
			path: "contracts/api.md",
		},
		reason: "intent/shaping_stale",
	});
	if (result.kind !== "stale")
		throw new Error("Expected a stale Build pre-start.");

	const runRecord: RunRecord = {
		schema: 2,
		run_id: "e".repeat(32),
		slug,
		approval_sha256: "f".repeat(64),
		approval_commit: approvalCommit,
		target_branch: "main",
		status: "failed",
		landing: null,
		owner_pid: 123,
		owner_started_ms: 1,
		started_ms: 2,
		recovery: [],
		cleanup_pending: false,
	};
	const events: JournalEvent[] = [
		{ event: "started", ts: 2 },
		{ ...result.event, ts: 3 },
		{ event: "finished", ts: 4, status: "failed", reason: result.statusDetail },
	];
	const status = deriveStatus({
		intents: [
			{
				slug,
				priority: 0,
				blocksOn: [],
				approval: {
					commit: approvalCommit,
					sha256: "f".repeat(64),
					approvedAt: 1,
					approvedBy: "Test",
					baseSha: baseCommit,
				},
			},
		],
		reachableLandings: [],
		runs: [
			{
				record: runRecord,
				events,
				journalPath: "/run/events.jsonl",
				ownerLiveness: "dead",
			},
		],
		claimRunId: null,
		queuePid: null,
		agents: [],
		nowMs: 4,
	});
	expect(status.bySlug.get(slug)?.status).toBe("failed");
	expect(status.bySlug.get(slug)?.detail).toBe(result.statusDetail);
});

test("pre-start skips empty predicates and dependencies without Git effects", async () => {
	const git = new FakeGit();
	const result = await checkBuildPrestart({
		git,
		origin: "/repo",
		approval: {
			intentBytes: encoder.encode(
				"---\ntitle: Empty\nsize: small\ndomains: [app]\n---\n",
			),
		},
		base: { commit: baseCommit, tree: baseTree },
	});

	expect(result).toEqual({ kind: "skipped" });
	expect(git.calls).toHaveLength(0);
});
