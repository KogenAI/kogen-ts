import { expect, test } from "bun:test";
import { basename } from "node:path";
import type { AdapterLog } from "../../packages/core/src/adapters/interface";
import {
	createRailsAdapter,
	hasRailsProjectMarkers,
	minitestLedgerRows,
	parseRailsFindings,
	RAILS_GATE_PATHS,
	RAILS_SEED_DIRECTORIES,
	RAILS_SETUP_CHECKS,
	railsAcceptanceCommand,
	railsAdapterUnavailable,
	railsChildEnvironment,
	railsFormatterCommand,
	railsSyntaxCheckCommand,
	selectAcceptanceAdapter,
} from "../../packages/core/src/adapters/rails";
import type { Result } from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { runAcceptanceLedger } from "../../packages/core/src/gate/ledger";

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

class MemoryFileSystem
	implements
		Pick<FileSystemPort, "readFile" | "writeFileAtomically" | "removeFile">
{
	readonly files = new Map<string, Uint8Array>();
	readonly writes: { root: string; path: string; mode: number }[] = [];

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
		this.writes.push({
			root: request.root,
			path: request.path,
			mode: request.mode,
		});
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

	put(root: string, path: string, value: Uint8Array): void {
		this.files.set(this.key(root, path), value.slice());
	}

	get(root: string, path: string): Uint8Array | undefined {
		return this.files.get(this.key(root, path))?.slice();
	}
}

test("P12 selects Rails only when both discovery files are present", () => {
	const both = ["Gemfile", "config/application.rb"];
	expect(hasRailsProjectMarkers(both)).toBe(true);
	expect(selectAcceptanceAdapter(both)).toBe("rails");
	expect(selectAcceptanceAdapter(["Gemfile"])).toBe("exunit");
	expect(selectAcceptanceAdapter(["config/application.rb"])).toBe("exunit");
	expect(selectAcceptanceAdapter(both, "command")).toBe("command");
	expect(selectAcceptanceAdapter([], "rails")).toBe("rails");
});

test("Rails adapter stages the frozen source and candidate paths", async () => {
	const created = createRailsAdapter();
	if (!created.ok) throw new Error(created.error.message);
	const adapter = created.value;
	const filesystem = new MemoryFileSystem();
	filesystem.put(
		"/origin",
		".kogen/acceptance/hello-world_test.rb",
		bytes("class HelloWorldTest < ActiveSupport::TestCase; end\n"),
	);
	expect(adapter.sourcePath("hello-world")).toBe(
		".kogen/acceptance/hello-world_test.rb",
	);
	expect(adapter.candidatePath("hello-world")).toBe(
		"test/acceptance/hello-world_test.rb",
	);
	const staged = await adapter.stage({
		filesystem,
		sourceRoot: "/origin",
		workdir: "/candidate",
		slug: "hello-world",
	});
	expect(staged).toEqual({
		ok: true,
		value: {
			sourcePath: ".kogen/acceptance/hello-world_test.rb",
			candidatePath: "test/acceptance/hello-world_test.rb",
			bytesWritten: bytes(
				"class HelloWorldTest < ActiveSupport::TestCase; end\n",
			).byteLength,
		},
	});
	expect(
		new TextDecoder().decode(
			filesystem.get("/candidate", "test/acceptance/hello-world_test.rb"),
		),
	).toBe("class HelloWorldTest < ActiveSupport::TestCase; end\n");
	expect(filesystem.writes[0]?.mode).toBe(0o600);
});

test("Rails defaults preserve offline setup, candidate-local bundler env, and gate files", () => {
	expect(RAILS_SEED_DIRECTORIES).toEqual(["vendor/cache"]);
	expect(RAILS_SETUP_CHECKS).toEqual([
		{
			name: "rails-bundle-install",
			argv: ["bundle", "install", "--local"],
			timeoutMs: 600_000,
		},
	]);
	expect(RAILS_GATE_PATHS).toEqual([
		"Gemfile",
		"Gemfile.lock",
		"bin/rails",
		".standard.yml",
		".rubocop.yml",
	]);
	expect(
		railsChildEnvironment({ BUNDLE_PATH: "/shared", RAILS_ENV: "development" }),
	).toEqual({ BUNDLE_PATH: "vendor/bundle", RAILS_ENV: "test" });
});

test("Rails selects standard before RuboCop and exposes syntax/runner argv", () => {
	expect(
		railsFormatterCommand("# gem 'standard'\ngem 'rubocop', '~> 1.0'\n"),
	).toEqual(["bundle", "exec", "rubocop", "-a"]);
	expect(
		railsFormatterCommand(
			"gem('rubocop')\ngem \"standard\", '~> 1.0' # preferred\n",
		),
	).toEqual(["bundle", "exec", "standardrb", "-a"]);
	expect(railsFormatterCommand("source 'https://rubygems.org'\n")).toBeNull();
	expect(
		railsSyntaxCheckCommand("test/acceptance/hello-world_test.rb"),
	).toEqual(["ruby", "-c", "test/acceptance/hello-world_test.rb"]);
	expect(railsSyntaxCheckCommand("../outside.rb")).toBeNull();
	expect(railsAcceptanceCommand("test/acceptance/hello-world_test.rb")).toEqual(
		[
			"bundle",
			"exec",
			"rails",
			"test",
			"test/acceptance/hello-world_test.rb",
			"--verbose",
		],
	);
});

const minitestLog: AdapterLog = {
	stdout: bytes(
		[
			"Run options: --seed 123",
			"# Running:",
			"HelloWorldTest#test_A1_greets = 0.01 s = .",
			"HelloWorldTest#test_A2_rejects_bad_input = 0.02 s = F",
			"HelloWorldTest#test_A3_is_skipped = 0.00 s = S",
			"",
			"3 runs, 2 assertions, 1 failures, 0 errors, 1 skips",
		].join("\n"),
	),
	stderr: new Uint8Array(),
};

test("Minitest results bridge to tagged JSONL rows and retain failures/skips", () => {
	expect(minitestLedgerRows(minitestLog, "hello-world")).toEqual([
		{
			tag: "hello-world/A1",
			test: "HelloWorldTest#test_A1_greets",
			status: "passed",
		},
		{
			tag: "hello-world/A2",
			test: "HelloWorldTest#test_A2_rejects_bad_input",
			status: "failed",
		},
		{
			tag: "hello-world/A3",
			test: "HelloWorldTest#test_A3_is_skipped",
			status: "skipped",
		},
	]);
	const untagged = minitestLedgerRows(
		{
			stdout: bytes("HelloWorldTest#test_helper = 0.01 s = .\n"),
			stderr: new Uint8Array(),
		},
		"hello-world",
	);
	expect(untagged).toEqual([
		{
			tag: "hello-world/__untagged__",
			test: "HelloWorldTest#test_helper",
			status: "invalid",
		},
	]);
	const ambiguous = minitestLedgerRows(
		{
			stdout: bytes(
				"HelloWorldTest#test_A1_and_A2 = 0.01 s = .\nHelloWorldTest#test_A1helper = 0.01 s = .\n",
			),
			stderr: new Uint8Array(),
		},
		"hello-world",
	);
	expect(ambiguous.map((row) => row.status)).toEqual(["invalid", "invalid"]);
});

test("Rails command and ledger bridge runs supervised argv and feeds the common evaluator", async () => {
	const created = createRailsAdapter();
	if (!created.ok) throw new Error(created.error.message);
	const filesystem = new MemoryFileSystem();
	const calls: ProcessRequest[] = [];
	const process = {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			calls.push(request);
			if (request.argv[0] === "bundle") {
				return {
					ok: true,
					value: {
						exitCode: 1,
						signal: null,
						stdout: minitestLog.stdout,
						stderr: minitestLog.stderr,
						timedOut: false,
					},
				};
			}
			if (request.argv[0] === "ruby" && request.argv[1] === "-e") {
				const reportPath = request.argv[3];
				if (reportPath === undefined)
					return {
						ok: false,
						error: {
							code: "invalid_input",
							message: "missing report path",
							retryable: false,
						},
					};
				filesystem.put(
					"/run",
					basename(reportPath),
					request.stdin ?? new Uint8Array(),
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
			}
			return {
				ok: false,
				error: {
					code: "unknown",
					message: `unmatched fake process request: ${request.argv.join(" ")}`,
					retryable: false,
				},
			};
		},
	};
	let snapshots = 0;
	const result = await runAcceptanceLedger({
		adapter: created.value,
		process,
		filesystem,
		tree: {
			async snapshot() {
				snapshots += 1;
				return { ok: true, value: "a".repeat(40) };
			},
		},
		workdir: "/candidate",
		slug: "hello-world",
		itemIds: ["A1", "A2", "A3"],
		reportDirectory: "/run",
		reportFilename: "ledger.jsonl",
		environment: {
			PATH: "/usr/bin",
			BUNDLE_PATH: "/shared",
			RAILS_ENV: "development",
		},
		timeoutMilliseconds: 30_000,
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	expect(snapshots).toBe(2);
	expect(calls).toHaveLength(2);
	expect(calls[0]?.argv).toEqual([
		"bundle",
		"exec",
		"rails",
		"test",
		"test/acceptance/hello-world_test.rb",
		"--verbose",
	]);
	expect(calls[0]?.cwd).toBe("/candidate");
	expect(calls[0]?.timeoutMilliseconds).toBe(30_000);
	expect(calls[0]?.env).toMatchObject({
		BUNDLE_PATH: "vendor/bundle",
		RAILS_ENV: "test",
		KOGEN_INTENT_SLUG: "hello-world",
		KOGEN_LEDGER_REPORT: "/run/ledger.jsonl",
	});
	expect(calls[1]?.argv[0]).toBe("ruby");
	expect(calls[1]?.argv[1]).toBe("-e");
	expect(calls[1]?.stdin).toEqual(
		bytes(
			[
				'{"tag":"hello-world/A1","test":"HelloWorldTest#test_A1_greets","status":"passed"}',
				'{"tag":"hello-world/A2","test":"HelloWorldTest#test_A2_rejects_bad_input","status":"failed"}',
				'{"tag":"hello-world/A3","test":"HelloWorldTest#test_A3_is_skipped","status":"skipped"}',
				"",
			].join("\n"),
		),
	);
	expect(result.value.reportState).toBe("valid");
	expect(result.value.items.map((item) => [item.id, item.status])).toEqual([
		["A1", "pass"],
		["A2", "fail"],
		["A3", "fail"],
	]);
	expect(result.value.unknownTags).toEqual([]);
});

test("Minitest and Ruby lint output become findings with stable identities", () => {
	const findings = parseRailsFindings(
		{
			stdout: bytes(
				[
					"AppTest#test_A2_rejects_invalid_input = 0.00 s = F",
					"app/models/user.rb:7:3: C: [Correctable] Style/FrozenStringLiteralComment: Add a frozen string literal comment.",
					"app/models/user.rb:8:5: Layout/SpaceInsideParens: Avoid spaces inside parentheses.",
				].join("\n"),
			),
			stderr: new Uint8Array(),
		},
		{
			slug: "hello-world",
			candidatePath: "test/acceptance/hello-world_test.rb",
		},
	);
	expect(findings).toEqual([
		{
			step: "acceptance",
			path: "app/models/user.rb",
			line: 7,
			column: 3,
			severity: "warning",
			rule: "rubocop/Style/FrozenStringLiteralComment",
			symbol: "",
			message: "Add a frozen string literal comment.",
			excused: false,
		},
		{
			step: "acceptance",
			path: "app/models/user.rb",
			line: 8,
			column: 5,
			severity: "warning",
			rule: "standard/Layout/SpaceInsideParens",
			symbol: "",
			message: "Avoid spaces inside parentheses.",
			excused: false,
		},
		{
			step: "acceptance",
			path: "test/acceptance/hello-world_test.rb",
			line: 1,
			column: 1,
			severity: "error",
			rule: "minitest/test",
			symbol: "AppTest#test_A2_rejects_invalid_input",
			message:
				"Minitest result F for AppTest#test_A2_rejects_invalid_input (hello-world/A2).",
			excused: false,
		},
	]);
});

test("Rails missing-tool classification recognizes runner diagnostics", () => {
	expect(
		railsAdapterUnavailable({
			stdout: new Uint8Array(),
			stderr: bytes("sh: bundle: command not found\n"),
		}),
	).toBe(true);
	expect(
		railsAdapterUnavailable({
			stdout: bytes("Finished in 0.01s\n"),
			stderr: new Uint8Array(),
		}),
	).toBe(false);
});
