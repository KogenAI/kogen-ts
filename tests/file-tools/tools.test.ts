import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessPort } from "../../packages/core/src/contracts/ports";
import { createPublicationFileSystemPort } from "../../packages/core/src/fs/publish";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
} from "../../packages/core/src/fs/read";
import {
	assembleResponses,
	type ResponseAssembly,
	type ResponseToolCall,
} from "../../packages/core/src/provider/sse/assemble";
import {
	dispatchToolCalls,
	INVALID_TOOL_ARGUMENTS_RESULT,
	TOOL_NOT_ALLOWED_RESULT,
} from "../../packages/core/src/provider/tools/dispatch";
import type { FileToolContext } from "../../packages/core/src/provider/tools/files";
import {
	CANONICAL_TOOL_SCHEMAS,
	hasValidToolArguments,
	roleToolAuthorizationForRecipe,
} from "../../packages/core/src/provider/tools/schema";

const repositoryRoot = resolve(import.meta.dir, "../..");
const encoder = new TextEncoder();
let scratch = "";
let workspace = "";
let outside = "";
let readDriver = "";
let publishDriver = "";

function compile(
	output: string,
	sourceFiles: readonly string[],
	defines: readonly string[] = [],
): void {
	const result = spawnSync(
		"/usr/bin/cc",
		[
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			...defines,
			"-I",
			"native",
			...sourceFiles,
			"-o",
			output,
		],
		{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`filesystem driver compile failed: ${result.stderr || result.stdout}`,
		);
}

function runDriver(driver: string, payload: Uint8Array): Uint8Array {
	const result = spawnSync(driver, [], {
		input: payload,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`filesystem driver failed (${result.status}): ${result.stderr.toString()}`,
		);
	return new Uint8Array(result.stdout);
}

const host: FileSystemHostRequest = {
	async request(operation, payload) {
		if (operation === FILESYSTEM_HOST_OPERATION)
			return runDriver(readDriver, payload);
		if (operation === 0x0302) return runDriver(publishDriver, payload);
		throw new Error(`unexpected filesystem host operation ${operation}`);
	},
};

const processPort: ProcessPort = {
	async run() {
		return {
			ok: true,
			value: {
				exitCode: 1,
				signal: null,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				timedOut: false,
			},
		};
	},
};

function fileContext(
	overrides: Partial<FileToolContext> = {},
): FileToolContext {
	return {
		workspaceRoot: workspace,
		filesystemHost: host,
		filesystem: createPublicationFileSystemPort(host),
		process: processPort,
		processEnvironment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		role: "shaper",
		shaperWritePaths: [
			".kogen/intents/greet/intent.md",
			".kogen/acceptance/greet.t.sh",
		],
		...overrides,
	};
}

function completeResponse(
	calls: readonly ResponseToolCall[],
): ResponseAssembly {
	return {
		ok: true,
		id: "response-complete",
		text: "",
		tool_calls: calls,
		usage: null,
		raw_items: [],
		raw_item_json: [],
	};
}

function call(
	id: string,
	name: string,
	argumentsValue: Record<string, unknown>,
): ResponseToolCall {
	return { id, name, arguments: argumentsValue };
}

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-file-tools-"));
	workspace = join(scratch, "workspace");
	outside = join(scratch, "outside");
	readDriver = join(scratch, "fs-read-driver");
	publishDriver = join(scratch, "fs-publish-driver");
	mkdirSync(workspace, { mode: 0o700 });
	mkdirSync(outside, { mode: 0o700 });
	compile(
		readDriver,
		["native/paths.c", "native/read.c", "tests/fs-read/read-driver.c"],
		["-Dopenat=kogen_test_openat"],
	);
	compile(
		publishDriver,
		["native/paths.c", "native/publish.c", "tests/fs-publish/publish-driver.c"],
		["-DKOGEN_FS_PUBLISH_TESTING"],
	);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("canonical schemas are shared and role allowlists restrict calls", () => {
	expect(CANONICAL_TOOL_SCHEMAS.map((schema) => schema.name)).toEqual([
		"read",
		"search",
		"edit",
		"write",
		"shell",
		"finish",
		"tool_output",
	]);
	expect(roleToolAuthorizationForRecipe("ladder").builder).toEqual([
		"shell",
		"finish",
		"tool_output",
	]);
	expect(roleToolAuthorizationForRecipe("direct").builder).toEqual([
		"read",
		"search",
		"edit",
		"write",
		"shell",
		"finish",
		"tool_output",
	]);
	expect(roleToolAuthorizationForRecipe("ladder").shaper).toEqual([
		"read",
		"search",
		"write",
	]);
	expect(roleToolAuthorizationForRecipe("direct").planner).toEqual([]);
	expect(hasValidToolArguments("read", { path: "file", timeout_ms: 10 })).toBe(
		true,
	);
	expect(hasValidToolArguments("read", { limit: 5, timeout_ms: 10 })).toBe(
		false,
	);
	expect(hasValidToolArguments("finish", {})).toBe(true);
	expect(hasValidToolArguments("unknown", {})).toBe(false);
});

test("read numbers lines, preserves continuation offsets, and follows only in-root links", async () => {
	mkdirSync(join(workspace, "lib"), { recursive: true });
	writeFileSync(join(workspace, "lib", "three.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(workspace, "lib", "target.txt"), "inside\n");
	symlinkSync("target.txt", join(workspace, "lib", "inside-link.txt"));
	symlinkSync(
		join(outside, "secret.txt"),
		join(workspace, "lib", "outside-link.txt"),
	);
	writeFileSync(join(outside, "secret.txt"), "outside secret\n");

	const context = fileContext();
	const response = completeResponse([
		call("r1", "read", { path: "lib/three.txt", limit: 2 }),
		call("r2", "read", { path: "lib/three.txt", offset: 3, limit: 1 }),
		call("r3", "read", { path: "lib/inside-link.txt" }),
		call("r4", "read", { path: "lib/outside-link.txt" }),
		call("r5", "read", { path: "../outside/secret.txt" }),
	]);
	const results = await dispatchToolCalls(response, {
		authorizedTools: ["read"],
		fileTools: context,
	});
	expect(results.map((result) => result.output)).toEqual([
		"lib/three.txt:\n1: one\n2: two\n[continue with offset=3]",
		"lib/three.txt:\n3: three",
		"lib/inside-link.txt:\n1: inside",
		"Path escapes the worktree.",
		"Path escapes the worktree.",
	]);
});

test("read distinguishes missing, binary and out-of-range line limits", async () => {
	mkdirSync(join(workspace, "read-errors"), { recursive: true });
	writeFileSync(
		join(workspace, "read-errors", "binary"),
		Buffer.from([0, 255, 1]),
	);
	writeFileSync(join(workspace, "read-errors", "text"), "one\n");
	const results = await dispatchToolCalls(
		completeResponse([
			call("missing", "read", { path: "read-errors/missing" }),
			call("binary", "read", { path: "read-errors/binary" }),
			call("limit", "read", { path: "read-errors/text", limit: 401 }),
		]),
		{ authorizedTools: ["read"], fileTools: fileContext() },
	);
	expect(results.map((result) => result.output)).toEqual([
		"ERROR: File does not exist.",
		"ERROR: File is binary or is not UTF-8 text.",
		"ERROR: limit must be between 1 and 400.",
	]);
});

test("search has no line cap, uses argv safely, and refuses an escaping link", async () => {
	mkdirSync(join(workspace, "search"), { recursive: true });
	writeFileSync(join(workspace, "search", "match.txt"), "needle\n");
	symlinkSync(
		join(outside, "secret.txt"),
		join(workspace, "search", "escape.txt"),
	);
	const requests: string[][] = [];
	let missingRg = false;
	const process: ProcessPort = {
		async run(request) {
			requests.push([...request.argv]);
			if (missingRg && request.argv[0] === "rg")
				return {
					ok: false,
					error: { code: "not_found", message: "not found", retryable: false },
				};
			return {
				ok: true,
				value: {
					exitCode: request.argv[0] === "grep" ? 0 : 1,
					signal: null,
					stdout:
						request.argv[0] === "grep"
							? bytes("search/match.txt:1:needle\n")
							: new Uint8Array(),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const context = fileContext({ process });
	const noMatches = await dispatchToolCalls(
		completeResponse([call("none", "search", { pattern: "nope" })]),
		{ authorizedTools: ["search"], fileTools: context },
	);
	expect(noMatches[0]?.output).toBe("No matches.");
	expect(requests[0]).toContain("--");
	expect(requests[0]?.at(-2)).toBe("nope");

	const escaped = await dispatchToolCalls(
		completeResponse([
			call("escape", "search", {
				pattern: "secret",
				path: "search/escape.txt",
			}),
		]),
		{ authorizedTools: ["search"], fileTools: context },
	);
	expect(escaped[0]?.output).toBe("Path escapes the worktree.");
	expect(requests).toHaveLength(1);

	missingRg = true;
	const fallback = await dispatchToolCalls(
		completeResponse([
			call("fallback", "search", { pattern: "needle", path: "search" }),
		]),
		{ authorizedTools: ["search"], fileTools: context },
	);
	expect(fallback[0]?.output).toContain("search/match.txt:1:needle");
	expect(requests[1]?.[0]).toBe("rg");
	expect(requests[2]?.[0]).toBe("grep");
});

test("writes preserve full content, enforce the shaper's exact paths and 200-line cap", async () => {
	mkdirSync(join(workspace, ".kogen", "intents", "greet"), { recursive: true });
	mkdirSync(join(workspace, ".kogen", "acceptance", "greet"), {
		recursive: true,
	});
	mkdirSync(join(workspace, "lib"), { recursive: true });
	const longText = `${Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
	const exactlyAtLimit = `${Array.from({ length: 200 }, (_, index) => `old ${index + 1}`).join("\n")}\n`;
	writeFileSync(
		join(workspace, ".kogen", "intents", "greet", "intent.md"),
		longText,
	);
	writeFileSync(
		join(workspace, ".kogen", "acceptance", "greet.t.sh"),
		exactlyAtLimit,
	);
	writeFileSync(join(workspace, "lib", "greet.txt"), "Hello!\n");
	const output = await dispatchToolCalls(
		completeResponse([
			call("outside-scope", "write", {
				path: "lib/greet.txt",
				content: "changed\n",
			}),
			call("too-many", "write", {
				path: ".kogen/intents/greet/intent.md",
				content: "short\n",
			}),
			call("ok", "write", {
				path: ".kogen/acceptance/greet.t.sh",
				content: "full bytes\n",
			}),
		]),
		{
			authorizedTools: ["write"],
			fileTools: fileContext(),
		},
	);
	expect(output.map((result) => result.output)).toEqual([
		"ERROR: Write target is outside the shaper's two-file scope. Allowed paths: .kogen/intents/greet/intent.md, .kogen/acceptance/greet.t.sh.",
		"ERROR: File has more than 200 lines; write refused.",
		"Wrote .kogen/acceptance/greet.t.sh.",
	]);
	expect(
		readFileSync(
			join(workspace, ".kogen", "intents", "greet", "intent.md"),
			"utf8",
		),
	).toBe(longText);
	expect(
		readFileSync(join(workspace, ".kogen", "acceptance", "greet.t.sh"), "utf8"),
	).toBe("full bytes\n");
});

test("edit requires one exact match and shapers cannot replace protected files", async () => {
	mkdirSync(join(workspace, "edit"), { recursive: true });
	writeFileSync(join(workspace, "edit", "unique.txt"), "before value\nafter\n");
	writeFileSync(join(workspace, "edit", "repeat.txt"), "same same\n");
	const results = await dispatchToolCalls(
		completeResponse([
			call("unique", "edit", {
				path: "edit/unique.txt",
				old_text: "before",
				new_text: "after",
			}),
			call("repeat", "edit", {
				path: "edit/repeat.txt",
				old_text: "same",
				new_text: "new",
			}),
		]),
		{
			authorizedTools: ["edit"],
			fileTools: fileContext({
				role: "builder",
				protectedPaths: ["edit/unique.txt"],
			}),
		},
	);
	expect(results.map((result) => result.output)).toEqual([
		"Wrote edit/unique.txt.",
		"ERROR: old_text must match exactly once in the file.",
	]);
	expect(readFileSync(join(workspace, "edit", "unique.txt"), "utf8")).toBe(
		"after value\nafter\n",
	);
	const protectedWrite = await dispatchToolCalls(
		completeResponse([
			call("protected", "write", {
				path: "edit/unique.txt",
				content: "replace\n",
			}),
		]),
		{
			authorizedTools: ["write"],
			fileTools: fileContext({
				role: "shaper",
				shaperWritePaths: ["edit/unique.txt", "edit/repeat.txt"],
				protectedPaths: ["edit/unique.txt"],
			}),
		},
	);
	expect(protectedWrite[0]?.output).toBe(
		"ERROR: edit/unique.txt is approved and protected; change the implementation instead.",
	);
});

test("unknown, disallowed and malformed calls return their specified errors", async () => {
	const results = await dispatchToolCalls(
		completeResponse([
			call("unknown", "whoknows", {}),
			call("disallowed", "write", { path: "a", content: "b" }),
			call("invalid", "read", { limit: 5, timeout_ms: 10 }),
		]),
		{ authorizedTools: ["read"] },
	);
	expect(results.map((result) => result.output)).toEqual([
		TOOL_NOT_ALLOWED_RESULT,
		TOOL_NOT_ALLOWED_RESULT,
		INVALID_TOOL_ARGUMENTS_RESULT,
	]);
});

test("failed or partial assemblies never dispatch proposed calls", async () => {
	const sideEffect: string[] = [];
	const partial = assembleResponses([
		{
			event: "response.incomplete",
			data: JSON.stringify({
				type: "response.incomplete",
				response: {
					id: "response-partial",
					status: "incomplete",
					output: [
						{
							type: "function_call",
							status: "in_progress",
							call_id: "call-partial",
							name: "write",
							arguments: '{"path":"outside","content":"bad"}',
						},
					],
				},
			}),
		},
	]);
	const results = await dispatchToolCalls(partial, {
		authorizedTools: ["write"],
		additionalHandlers: {
			finish: async () => {
				sideEffect.push("called");
				return "finished";
			},
		},
		fileTools: {
			...fileContext(),
			filesystem: {
				async writeFileAtomically() {
					sideEffect.push("wrote");
					return { ok: true, value: undefined };
				},
			},
		},
	});
	expect(partial.ok).toBe(false);
	expect(results).toEqual([]);
	expect(sideEffect).toEqual([]);

	const inProgress = assembleResponses([
		{
			event: "response.completed",
			data: JSON.stringify({
				type: "response.completed",
				response: {
					id: "response-completed-envelope",
					status: "completed",
					output: [
						{
							type: "function_call",
							status: "in_progress",
							call_id: "call-still-in-progress",
							name: "write",
							arguments: '{"path":"outside","content":"bad"}',
						},
					],
				},
			}),
		},
	]);
	const inProgressResults = await dispatchToolCalls(inProgress, {
		authorizedTools: ["write"],
		fileTools: {
			...fileContext(),
			filesystem: {
				async writeFileAtomically() {
					sideEffect.push("wrote");
					return { ok: true, value: undefined };
				},
			},
		},
	});
	expect(inProgress.ok).toBe(true);
	expect(inProgressResults).toEqual([]);
	expect(sideEffect).toEqual([]);
});
