import { expect, test } from "bun:test";
import { dirname } from "node:path";
import {
	createExUnitAdapter,
	isExUnitUnavailable,
	parseCredoFindings,
	parseElixirCompilerErrors,
	parseExUnitFailures,
	parseMixFormatFindings,
} from "../../packages/core/src/adapters/exunit";
import type { AdapterLog } from "../../packages/core/src/adapters/interface";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import type { ProjectConfig } from "../../packages/core/src/project/schema";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

class MemoryFileSystem
	implements
		Pick<FileSystemPort, "readFile" | "writeFileAtomically" | "removeFile">
{
	readonly files = new Map<string, Uint8Array>();
	readonly writes: Array<{
		readonly root: string;
		readonly path: string;
		readonly bytes: Uint8Array;
		readonly mode: number;
	}> = [];

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
					message: "fixture file too large",
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
		this.writes.push({ ...request, bytes: request.bytes.slice() });
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

	put(root: string, path: string, value: string): void {
		this.files.set(this.key(root, path), bytes(value));
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(this.key(root, path))?.slice();
	}
}

function adapter(
	filesystem: MemoryFileSystem,
	miseBinaryPath: string | null = null,
) {
	const result = createExUnitAdapter({ filesystem, miseBinaryPath });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function log(stdout: string, stderr = ""): AdapterLog {
	return { stdout: bytes(stdout), stderr: bytes(stderr) };
}

test("ExUnit source staging moves the approved _test.exs into test/acceptance", async () => {
	const filesystem = new MemoryFileSystem();
	const exunit = adapter(filesystem);
	const source = "defmodule GreetTest do\n  use ExUnit.Case\nend\n";
	filesystem.put("/checkout", ".kogen/acceptance/greet_test.exs", source);
	filesystem.put("/work", ".kogen/acceptance/greet_test.exs", source);
	const result = await exunit.stage({
		filesystem,
		sourceRoot: "/checkout",
		workdir: "/work",
		slug: "greet",
	});
	expect(result).toEqual({
		ok: true,
		value: {
			sourcePath: ".kogen/acceptance/greet_test.exs",
			candidatePath: "test/acceptance/greet_test.exs",
			bytesWritten: bytes(source).byteLength,
		},
	});
	expect(
		filesystem.get("/work", ".kogen/acceptance/greet_test.exs"),
	).toBeUndefined();
	expect(
		new TextDecoder().decode(
			filesystem.get("/work", "test/acceptance/greet_test.exs"),
		),
	).toBe(source);
});

test("runner writes the formatter in the run directory and uses exact mise argv", async () => {
	const filesystem = new MemoryFileSystem();
	const exunit = adapter(filesystem, "/mise/bin/mise");
	let observed: ProcessRequest | undefined;
	const process = {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			observed = request;
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
	const reportPath = "/state/runs/run-1/ledger.jsonl";
	const result = await exunit.run({
		process,
		workdir: "/state/runs/run-1-r1",
		slug: "greet",
		reportPath,
		environment: {
			PATH: "/toolchain/bin:/usr/bin",
			KOGEN_LEDGER_REPORT: "/wrong/report",
		},
		timeoutMilliseconds: 60_000,
	});
	expect(result.ok).toBe(true);
	expect(observed?.argv).toEqual([
		"/mise/bin/mise",
		"exec",
		"--",
		"elixir",
		"-e",
		'Code.require_file("/state/runs/run-1/ledger_formatter.ex")',
		"-S",
		"mix",
		"test",
		"--formatter",
		"KogenLedgerFormatter",
		"--formatter",
		"ExUnit.CLIFormatter",
		"test/acceptance/greet_test.exs",
	]);
	expect(observed?.cwd).toBe("/state/runs/run-1-r1");
	expect(observed?.env).toMatchObject({
		PATH: "/toolchain/bin:/usr/bin",
		KOGEN_LEDGER_REPORT: reportPath,
		KOGEN_INTENT_SLUG: "greet",
	});
	expect(filesystem.writes).toHaveLength(1);
	expect(filesystem.writes[0]).toMatchObject({
		root: dirname(reportPath),
		path: "ledger_formatter.ex",
		mode: 0o600,
	});
	const externalFormatter = filesystem.get(
		dirname(reportPath),
		"ledger_formatter.ex",
	);
	expect(externalFormatter).toBeDefined();
	const formatterText = new TextDecoder().decode(externalFormatter);
	expect(formatterText).toContain('String.replace_prefix("test ", "")');
	expect(formatterText).toContain('{:failed, _} -> "failed"');
});

test("runner omits mise when no mise binary is selected", async () => {
	const filesystem = new MemoryFileSystem();
	const exunit = adapter(filesystem);
	let observed: ProcessRequest | undefined;
	const process = {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			observed = request;
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
	await exunit.run({
		process,
		workdir: "/state/run-work",
		slug: "greet",
		reportPath: "/state/run/ledger.jsonl",
		environment: {},
		timeoutMilliseconds: 1,
	});
	expect(observed?.argv).toEqual([
		"elixir",
		"-e",
		'Code.require_file("/state/run/ledger_formatter.ex")',
		"-S",
		"mix",
		"test",
		"--formatter",
		"KogenLedgerFormatter",
		"--formatter",
		"ExUnit.CLIFormatter",
		"test/acceptance/greet_test.exs",
	]);
});

test("formatter derives from the first format check and restricts paths to Elixir source", () => {
	const exunit = adapter(new MemoryFileSystem());
	const project = {
		checks: [
			{ name: "compile", argv: ["mix", "compile"], timeoutMs: 1 },
			{
				name: "format",
				argv: ["mix", "format", "--check-formatted"],
				timeoutMs: 1,
			},
			{
				name: "second-format",
				argv: ["mix", "format", "--check-formatted", "--dot-formatter"],
				timeoutMs: 1,
			},
		],
	} as Pick<ProjectConfig, "checks" | "format">;
	expect(exunit.formatter(project)).toEqual(["mix", "format"]);
	expect(exunit.formatter({ checks: [] })).toEqual(["mix", "format"]);
	expect(
		exunit.formatter({
			...project,
			format: ["mise", "exec", "--", "mix", "format"],
		}),
	).toEqual(["mise", "exec", "--", "mix", "format"]);
	expect(
		exunit.formatterPaths([
			"lib/a.ex",
			"test/a_test.exs",
			"intent.md",
			"mix.exs",
			"image.ex.png",
		]),
	).toEqual(["lib/a.ex", "test/a_test.exs", "mix.exs"]);
});

test("unavailable detection checks the first twenty lines and recognizes the named tools", () => {
	expect(
		isExUnitUnavailable(log("/usr/bin/env: erl: No such file or directory\n")),
	).toBe(true);
	expect(
		isExUnitUnavailable(
			log(
				`${Array.from({ length: 19 }, () => "progress").join("\n")}\nmix: command not found`,
			),
		),
	).toBe(true);
	expect(
		isExUnitUnavailable(
			log(
				`${Array.from({ length: 20 }, () => "progress").join("\n")}\nelixir: command not found`,
			),
		),
	).toBe(false);
	expect(isExUnitUnavailable(log("elixir: invalid option\n"))).toBe(false);
});

test("ExUnit, compiler, Credo, and formatter parsers produce stable finding identities", () => {
	expect(
		parseExUnitFailures(
			log(
				`  1) test legacy is broken (HelloTest)\n     test/hello_test.exs:4\n     Assertion with == failed\n     code: assert Hello.greet() == "Hello, Almir!"\n\nFinished in 0.01 seconds`,
			),
			"acceptance",
		),
	).toEqual([
		{
			step: "acceptance",
			path: "test/hello_test.exs",
			line: 4,
			column: 1,
			severity: "error",
			rule: "exunit/test",
			symbol: "legacy is broken",
			message: "Assertion with == failed",
			excused: false,
		},
	]);

	expect(
		parseElixirCompilerErrors(
			log("** (SyntaxError) lib/hello.ex:2:4: unexpected token: end\n"),
			"check/compile",
		),
	).toEqual([
		{
			step: "check/compile",
			path: "lib/hello.ex",
			line: 2,
			column: 4,
			severity: "error",
			rule: "elixir/compiler",
			symbol: "",
			message: "unexpected token: end",
			excused: false,
		},
	]);

	expect(
		parseCredoFindings(
			log(
				"┃ [C] ↗ lib/hello.ex:3:5\n┃     Function body is nested too deeply.\n┃     Credo.Check.Refactor.Nesting\n",
			),
			"check/credo",
		),
	).toEqual([
		{
			step: "check/credo",
			path: "lib/hello.ex",
			line: 3,
			column: 5,
			severity: "error",
			rule: "credo/Refactor.Nesting",
			symbol: "",
			message: "Function body is nested too deeply.",
			excused: false,
		},
	]);

	expect(
		parseMixFormatFindings(
			log(
				"** (Mix) mix format failed due to --check-formatted.\nThe following files are not formatted:\n  * test/hello_test.exs\n  * README.md\n",
			),
			"check/format",
		),
	).toEqual([
		{
			step: "check/format",
			path: "test/hello_test.exs",
			line: 1,
			column: 1,
			severity: "error",
			rule: "mix_format/check-formatted",
			symbol: "",
			message: "file is not formatted",
			excused: false,
		},
	]);
});
