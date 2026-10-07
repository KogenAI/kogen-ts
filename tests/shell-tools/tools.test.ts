import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	FileSystemPort,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { createPublicationFileSystemPort } from "../../packages/core/src/fs/publish";
import {
	createReadFileSystemPort,
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
} from "../../packages/core/src/fs/read";
import {
	BUILDER_TEXT_CONTINUATION,
	evaluateFinish,
	FINISH_ACCEPTED_RESULT,
	FINISH_INVALID_RESULT,
	FINISH_NO_CHANGES_RESULT,
	finishCallResult,
	textOnlyBuilderContinuation,
} from "../../packages/core/src/provider/tools/finish";
import {
	budgetToolOutput,
	createToolOutputHandler,
	processOutputText,
	readToolOutput,
	TOOL_OUTPUT_UNKNOWN_HANDLE,
	TOOL_RESULT_BYTES_PER_TOKEN,
	TOOL_RESULT_NOTICE_RESERVE_BYTES,
	type ToolOutputContext,
	toolOutputHandle,
} from "../../packages/core/src/provider/tools/output";
import {
	createShellToolHandler,
	runShellTool,
	SHELL_TOOL_PROCESS_OUTPUT_LIMIT_BYTES,
	SHELL_TOOL_TIMEOUT_MS,
} from "../../packages/core/src/provider/tools/shell";
import { redactSensitiveText } from "../../packages/core/src/run/journal";

const repositoryRoot = resolve(import.meta.dir, "../..");
let scratch = "";
let runDirectory = "";
let workspace = "";
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

const filesystemHost: FileSystemHostRequest = {
	async request(operation, payload) {
		if (operation === FILESYSTEM_HOST_OPERATION)
			return runDriver(readDriver, payload);
		if (operation === 0x0302) return runDriver(publishDriver, payload);
		throw new Error(`unexpected filesystem host operation ${operation}`);
	},
};

let filesystem: FileSystemPort;

function outputContext(toolResultTokens = 2_000): ToolOutputContext {
	return { runDirectory, filesystem, toolResultTokens };
}

function spawnProcessPort(
	captured: { request?: ProcessRequest },
	resultLimitMilliseconds = 30_000,
): ProcessPort {
	return {
		async run(request) {
			captured.request = request;
			const result = spawnSync(request.argv[0] ?? "", request.argv.slice(1), {
				cwd: request.cwd,
				env: { ...request.env },
				input: request.stdin,
				maxBuffer: Math.max(2 * 1024 * 1024, request.outputLimitBytes * 2),
				timeout: resultLimitMilliseconds,
			});
			if (result.error) throw result.error;
			const value: ProcessResult = {
				exitCode: result.status,
				signal: result.signal,
				stdout: new Uint8Array(result.stdout),
				stderr: new Uint8Array(result.stderr),
				timedOut: false,
			};
			return { ok: true, value };
		},
	};
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-shell-tools-"));
	chmodSync(scratch, 0o700);
	runDirectory = join(scratch, "run");
	workspace = join(scratch, "workspace");
	readDriver = join(scratch, "fs-read-driver");
	publishDriver = join(scratch, "fs-publish-driver");
	mkdirSync(join(runDirectory, "logs"), { recursive: true, mode: 0o700 });
	mkdirSync(join(workspace, "lib"), { recursive: true, mode: 0o700 });
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
	filesystem = {
		...createReadFileSystemPort(filesystemHost),
		...createPublicationFileSystemPort(filesystemHost),
	};
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("shell writes a 300 KiB heredoc through a private short-argv script", async () => {
	const lines = Array.from(
		{ length: 3_600 },
		(_, index) =>
			`line ${String(index + 1).padStart(5, "0")} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
	);
	const expectedFile = `${lines.join("\n")}\n`;
	const expectedBytes = new TextEncoder().encode(expectedFile);
	expect(expectedBytes.byteLength).toBeGreaterThanOrEqual(300 * 1024);
	const command = `cat > lib/big.txt <<'KOGEN_EOF'\n${expectedFile}KOGEN_EOF`;
	const captured: { request?: ProcessRequest } = {};
	const result = await runShellTool(
		{
			...outputContext(),
			workspaceRoot: workspace,
			environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			process: spawnProcessPort(captured),
		},
		{ cmd: command },
	);

	expect(result).toBe("exit 0\n");
	expect(captured.request?.timeoutMilliseconds).toBe(SHELL_TOOL_TIMEOUT_MS);
	expect(captured.request?.outputLimitBytes).toBe(
		SHELL_TOOL_PROCESS_OUTPUT_LIMIT_BYTES,
	);
	expect(captured.request?.argv[0]).toBe("sh");
	expect(captured.request?.argv).toHaveLength(2);
	expect(
		captured.request?.argv?.every(
			(argument) => Buffer.byteLength(argument) <= 4096,
		),
	).toBe(true);
	expect(captured.request?.argv?.join(" ")).not.toContain("line 00001");
	const scriptPath = captured.request?.argv[1];
	expect(scriptPath).toBeDefined();
	const script = readFileSync(scriptPath as string);
	expect(statSync(scriptPath as string).mode & 0o777).toBe(0o600);
	expect(script.includes(Buffer.from(command))).toBe(true);
	expect(readFileSync(join(workspace, "lib", "big.txt"))).toEqual(
		Buffer.from(expectedBytes),
	);
});

test("shell keeps the 120-second user notice while scaling the supervised deadline", async () => {
	let request: ProcessRequest | undefined;
	const process: ProcessPort = {
		async run(value) {
			request = value;
			return {
				ok: true,
				value: {
					exitCode: null,
					signal: null,
					stdout: new TextEncoder().encode("partial output"),
					stderr: new Uint8Array(),
					timedOut: true,
				},
			};
		},
	};
	const output = await runShellTool(
		{
			...outputContext(),
			workspaceRoot: workspace,
			environment: { PATH: "/usr/bin:/bin" },
			process,
			timeoutScale: 0.01,
		},
		{ cmd: "sleep 200" },
	);
	expect(request?.timeoutMilliseconds).toBe(1_200);
	expect(output).toBe("timed out after 120 seconds\npartial output");
});

test("result budget emits a byte-exact 8,000-byte notice and stores full redacted text", async () => {
	const source = `${"x".repeat(15_000)}\nEND-OF-OUTPUT\nexit 0\n`;
	const sourceBytes = new TextEncoder().encode(source);
	const handle = toolOutputHandle(source);
	const output = await budgetToolOutput(outputContext(), source);
	const outputBytes = new TextEncoder().encode(output);
	expect(TOOL_RESULT_BYTES_PER_TOKEN * 2_000).toBe(8_000);
	expect(TOOL_RESULT_NOTICE_RESERVE_BYTES).toBe(320);
	expect(outputBytes.byteLength).toBe(8_000);
	expect(output).toContain("END-OF-OUTPUT");
	expect(output).toContain(
		`retrieve with tool_output handle=${handle}, output_offset and output_limit`,
	);
	expect(output).toContain(
		`\n[truncated/range: ${sourceBytes.byteLength} bytes; shown byte ranges 0-3899,11122-${sourceBytes.byteLength}; retrieve with tool_output handle=${handle}, output_offset and output_limit]\n`,
	);
	const storedPath = join(runDirectory, "logs", `tool-result-${handle}.log`);
	expect(existsSync(storedPath)).toBe(true);
	expect(statSync(storedPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(storedPath)).toEqual(Buffer.from(sourceBytes));
	const requested = await readToolOutput(outputContext(), {
		handle,
		output_offset: sourceBytes.byteLength - 14,
	});
	expect(requested).toBe("OUTPUT\nexit 0\n");
});

test("tool output keeps UTF-8 boundaries and base64 encodes every invalid byte", async () => {
	const text = "αβγ🙂".repeat(300);
	const output = await budgetToolOutput(outputContext(128), text);
	expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(512);
	expect(() =>
		new TextDecoder("utf-8", { fatal: true }).decode(
			new TextEncoder().encode(output),
		),
	).not.toThrow();

	expect(
		processOutputText(new Uint8Array([0xff, 0xfe, 0x61, 0x62, 0x63])),
	).toBe("[non-UTF-8 output, base64 encoded]\n//5hYmM=");
	const raw = new TextEncoder().encode(
		"[non-UTF-8 output, base64 encoded]\n//5hYmM=\nexit 0\n",
	);
	expect(toolOutputHandle(new TextDecoder().decode(raw))).toBe(
		createHash("sha256").update(raw).digest("hex"),
	);
});

test("tool result handles hash and store the redacted full text", async () => {
	const secret = `Bearer ${"sensitive-token-".repeat(3)}`;
	const source = `${"x".repeat(8_100)}\n${secret}\n`;
	const redacted = redactSensitiveText(source);
	const handle = toolOutputHandle(redacted);
	const output = await budgetToolOutput(outputContext(), source);
	const storedPath = join(runDirectory, "logs", `tool-result-${handle}.log`);
	expect(output).toContain(`tool_output handle=${handle}`);
	expect(output).not.toContain(secret);
	expect(readFileSync(storedPath, "utf8")).toBe(redacted);
	expect(statSync(storedPath).isFile()).toBe(true);
});

test("tool_output refuses symlink or digest-mismatched handles and dispatches valid ranges", async () => {
	const context = outputContext();
	const source = `${"0123456789".repeat(1_000)}\n`;
	const handle = toolOutputHandle(source);
	await budgetToolOutput({ ...context, toolResultTokens: 128 }, source);
	const linkedHandle = "a".repeat(64);
	symlinkSync(
		join(runDirectory, "logs", `tool-result-${handle}.log`),
		join(runDirectory, "logs", `tool-result-${linkedHandle}.log`),
	);
	expect(await readToolOutput(context, { handle: linkedHandle })).toBe(
		TOOL_OUTPUT_UNKNOWN_HANDLE,
	);
	const handler = createToolOutputHandler(context);
	expect(
		await handler(
			{ handle, output_offset: 10, output_limit: 20 },
			{} as never,
			[],
		),
	).toBe(source.slice(10, 30));
	expect(await readToolOutput(context, { handle: "../" })).toBe(
		TOOL_OUTPUT_UNKNOWN_HANDLE,
	);
});

test("finish requires an empty sole call, continues after the first empty finish, and text is progress", () => {
	const finish = { id: "call_finish", name: "finish", arguments: {} };
	const besideFinish = {
		id: "call_shell",
		name: "shell",
		arguments: { cmd: "true" },
	};
	expect(finishCallResult({}, finish, [finish])).toBe(FINISH_ACCEPTED_RESULT);
	expect(finishCallResult({ extra: true }, finish, [finish])).toBe(
		FINISH_INVALID_RESULT,
	);
	expect(finishCallResult({}, finish, [finish, besideFinish])).toBe(
		FINISH_INVALID_RESULT,
	);

	const firstEmpty = evaluateFinish({
		argumentsValue: {},
		isOnlyToolCall: true,
		hasChanges: false,
		emptyFinishCount: 0,
	});
	expect(firstEmpty).toEqual({
		kind: "continue",
		output: FINISH_NO_CHANGES_RESULT,
		emptyFinishCount: 1,
	});
	expect(
		evaluateFinish({
			argumentsValue: {},
			isOnlyToolCall: true,
			hasChanges: false,
			emptyFinishCount: firstEmpty.emptyFinishCount,
		}),
	).toEqual({
		kind: "run_gate",
		output: FINISH_ACCEPTED_RESULT,
		emptyFinishCount: 1,
	});
	expect(textOnlyBuilderContinuation()).toBe(BUILDER_TEXT_CONTINUATION);
});

test("shell handler is available as the shared additional-tool boundary", async () => {
	const handler = createShellToolHandler({
		...outputContext(),
		workspaceRoot: workspace,
		environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
		process: spawnProcessPort({}),
	});
	expect(
		await handler({ cmd: "printf '\\377\\376abc'" }, {} as never, []),
	).toBe("[non-UTF-8 output, base64 encoded]\n//5hYmM=\nexit 0\n");
});
