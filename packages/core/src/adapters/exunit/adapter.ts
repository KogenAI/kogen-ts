import { dirname, isAbsolute, posix } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type { FileSystemPort } from "../../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../../fs/read";
import { isValidIntentSlug } from "../../intent/parse";
import type { ProjectConfig } from "../../project/schema";
import type {
	AcceptanceAdapter,
	AdapterRunResult,
	RunAcceptanceTestRequest,
	StageAcceptanceTestRequest,
	StagedAcceptanceTest,
} from "../interface";
import { EXUNIT_FINDING_PARSERS } from "./findings";
import { EXUNIT_LEDGER_FORMATTER_SOURCE } from "./ledger-formatter";

export const EXUNIT_ADAPTER_OUTPUT_LIMIT_BYTES = 512 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_ARG_BYTES = 4096;
const TEST_SOURCE_DIRECTORY = ".kogen/acceptance";
const TEST_CANDIDATE_DIRECTORY = "test/acceptance";
const LEDGER_FORMATTER_FILENAME = "ledger_formatter.ex";
const LEDGER_FORMATTER_MAX_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const encoder = new TextEncoder();

export interface ExUnitAdapterOptions {
	/** The run-directory writer used to keep the formatter outside the workspace. */
	readonly filesystem: Pick<FileSystemPort, "writeFileAtomically">;
	/** Undefined/null leaves mise out; a path adds the frozen `mise exec --` prefix. */
	readonly miseBinaryPath?: string | null;
}

export interface ExUnitAdapter extends AcceptanceAdapter {
	readonly findingParsers: typeof EXUNIT_FINDING_PARSERS;
	formatter(
		project: Pick<ProjectConfig, "checks" | "format">,
	): readonly string[];
	formatterPaths(paths: readonly string[]): readonly string[];
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function validAbsolutePath(value: string): boolean {
	return (
		value.length > 0 &&
		isAbsolute(value) &&
		!value.includes("\0") &&
		encoder.encode(value).byteLength <= MAX_PATH_BYTES
	);
}

function validArg(value: string, index: number): PortError | null {
	if (
		value.length === 0 ||
		value.includes("\0") ||
		encoder.encode(value).byteLength > MAX_ARG_BYTES
	)
		return portError(
			"invalid_input",
			`ExUnit acceptance argv[${index}] must contain 1 through ${MAX_ARG_BYTES} UTF-8 bytes without NUL.`,
		);
	return null;
}

function sourcePath(slug: string): string {
	if (!isValidIntentSlug(slug))
		throw new TypeError("Acceptance slug is invalid.");
	return `${TEST_SOURCE_DIRECTORY}/${slug}_test.exs`;
}

function candidatePath(slug: string): string {
	if (!isValidIntentSlug(slug))
		throw new TypeError("Acceptance slug is invalid.");
	return posix.join(TEST_CANDIDATE_DIRECTORY, `${slug}_test.exs`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

async function stageAcceptanceTest(
	request: StageAcceptanceTestRequest,
): Promise<Result<StagedAcceptanceTest>> {
	if (
		!validAbsolutePath(request.sourceRoot) ||
		!validAbsolutePath(request.workdir)
	)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Acceptance source and worktree roots must be absolute bounded paths.",
			),
		};
	let source: string;
	let candidate: string;
	try {
		source = sourcePath(request.slug);
		candidate = candidatePath(request.slug);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				cause instanceof Error ? cause.message : "Acceptance slug is invalid.",
			),
		};
	}
	const sourceBytes = await request.filesystem.readFile({
		root: request.sourceRoot,
		path: source,
		maxBytes: LEDGER_FORMATTER_MAX_BYTES,
	});
	if (!sourceBytes.ok) return sourceBytes;
	const candidateBytes = await request.filesystem.readFile({
		root: request.workdir,
		path: candidate,
		maxBytes: LEDGER_FORMATTER_MAX_BYTES,
	});
	if (candidateBytes.ok)
		return {
			ok: false,
			error: portError(
				"conflict",
				`Staged acceptance path is already occupied: ${candidate}.`,
			),
		};
	if (candidateBytes.error.code !== "not_found") {
		if (
			candidateBytes.error.code === "invalid_input" ||
			candidateBytes.error.code === "permission_denied"
		)
			return {
				ok: false,
				error: portError(
					"conflict",
					`Staged acceptance path is occupied or unsafe: ${candidate}.`,
				),
			};
		return candidateBytes;
	}
	const existingSource = await request.filesystem.readFile({
		root: request.workdir,
		path: source,
		maxBytes: LEDGER_FORMATTER_MAX_BYTES,
	});
	if (existingSource.ok && !sameBytes(existingSource.value, sourceBytes.value))
		return {
			ok: false,
			error: portError(
				"conflict",
				"Acceptance source in the candidate worktree differs from the approved source.",
			),
		};
	if (!existingSource.ok && existingSource.error.code !== "not_found")
		return existingSource;
	const written = await request.filesystem.writeFileAtomically({
		root: request.workdir,
		path: candidate,
		bytes: sourceBytes.value,
		mode: 0o600,
	});
	if (!written.ok) return written;
	if (existingSource.ok) {
		const removed = await request.filesystem.removeFile(
			request.workdir,
			source,
		);
		if (!removed.ok && removed.error.code !== "not_found") {
			const rollback = await request.filesystem.removeFile(
				request.workdir,
				candidate,
			);
			return {
				ok: false,
				error: portError(
					removed.error.code,
					rollback.ok
						? `Could not remove the staged source copy: ${removed.error.message}`
						: `Could not remove the staged source copy or roll back the candidate test: ${removed.error.message}; ${rollback.error.message}`,
					removed.error.retryable || !rollback.ok,
				),
			};
		}
	}
	return {
		ok: true,
		value: {
			sourcePath: source,
			candidatePath: candidate,
			bytesWritten: sourceBytes.value.byteLength,
		},
	};
}

function formatterArgv(
	project: Pick<ProjectConfig, "checks" | "format">,
): readonly string[] {
	if (project.format !== undefined) return [...project.format];
	const check = project.checks.find(
		(candidate) =>
			candidate.argv.includes("format") &&
			candidate.argv.includes("--check-formatted"),
	);
	if (check === undefined) return ["mix", "format"];
	const argv = [...check.argv];
	const flag = argv.indexOf("--check-formatted");
	if (flag >= 0) argv.splice(flag, 1);
	return argv;
}

function isUnavailableLine(line: string): boolean {
	const tool = `(?:erl|elixir|mix)`;
	const missing = `(?:not found|not installed|no such file(?: or directory)?|could not be found|is missing|is unavailable)`;
	return (
		new RegExp(String.raw`\b${tool}\b.{0,100}\b${missing}\b`, "iu").test(
			line,
		) ||
		new RegExp(String.raw`\b${missing}\b.{0,100}\b${tool}\b`, "iu").test(line)
	);
}

/** The ledger interface preserves streams separately; first 20 means stdout then stderr. */
export function isExUnitUnavailable(log: {
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}): boolean {
	const text = `${new TextDecoder().decode(log.stdout)}\n${new TextDecoder().decode(log.stderr)}`;
	return text
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.slice(0, 20)
		.some(isUnavailableLine);
}

function buildRunArgv(
	miseBinaryPath: string | null,
	formatterPath: string,
	candidate: string,
): readonly string[] {
	const elixirArgv = [
		"elixir",
		"-e",
		`Code.require_file(${JSON.stringify(formatterPath)})`,
		"-S",
		"mix",
		"test",
		"--formatter",
		"KogenLedgerFormatter",
		"--formatter",
		"ExUnit.CLIFormatter",
		candidate,
	];
	return miseBinaryPath === null
		? elixirArgv
		: [miseBinaryPath, "exec", "--", ...elixirArgv];
}

export function createExUnitAdapter(
	options: ExUnitAdapterOptions,
): Result<ExUnitAdapter> {
	const miseBinaryPath = options.miseBinaryPath ?? null;
	if (miseBinaryPath !== null && !validAbsolutePath(miseBinaryPath))
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"mise binary path must be absolute and bounded.",
			),
		};
	const adapter: ExUnitAdapter = {
		name: "exunit",
		findingParsers: EXUNIT_FINDING_PARSERS,
		sourcePath,
		candidatePath,
		stage: stageAcceptanceTest,
		formatter: formatterArgv,
		formatterPaths(paths) {
			return paths.filter((path) => /\.exs?$/u.test(posix.basename(path)));
		},
		unavailable: isExUnitUnavailable,
		async run(
			request: RunAcceptanceTestRequest,
		): Promise<Result<AdapterRunResult>> {
			if (!isValidIntentSlug(request.slug))
				return {
					ok: false,
					error: portError("invalid_input", "Acceptance slug is invalid."),
				};
			if (
				!validAbsolutePath(request.workdir) ||
				!validAbsolutePath(request.reportPath)
			)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Acceptance worktree and report paths must be absolute bounded paths.",
					),
				};
			if (
				!Number.isSafeInteger(request.timeoutMilliseconds) ||
				request.timeoutMilliseconds < 1
			)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Acceptance timeout must be a positive safe integer.",
					),
				};
			const candidate = candidatePath(request.slug);
			const formatterPath = posix.join(
				dirname(request.reportPath),
				LEDGER_FORMATTER_FILENAME,
			);
			if (!validAbsolutePath(formatterPath))
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"ExUnit ledger formatter path is invalid.",
					),
				};
			const report = await options.filesystem.writeFileAtomically({
				root: dirname(request.reportPath),
				path: LEDGER_FORMATTER_FILENAME,
				bytes: encoder.encode(EXUNIT_LEDGER_FORMATTER_SOURCE),
				mode: 0o600,
			});
			if (!report.ok) return report;
			const argv = buildRunArgv(miseBinaryPath, formatterPath, candidate);
			for (let index = 0; index < argv.length; index += 1) {
				const argument = argv[index];
				if (argument === undefined || validArg(argument, index) !== null)
					return {
						ok: false,
						error: portError(
							"invalid_input",
							`Expanded ExUnit argv[${index}] is invalid.`,
						),
					};
			}
			const environment: Record<string, string> = Object.create(null);
			for (const [name, value] of Object.entries(request.environment))
				environment[name] = value;
			environment.KOGEN_LEDGER_REPORT = request.reportPath;
			environment.KOGEN_INTENT_SLUG = request.slug;
			const result = await request.process.run({
				argv,
				cwd: request.workdir,
				env: environment,
				timeoutMilliseconds: request.timeoutMilliseconds,
				outputLimitBytes: EXUNIT_ADAPTER_OUTPUT_LIMIT_BYTES,
			});
			if (!result.ok) return result;
			return {
				ok: true,
				value: {
					exitStatus: result.value.exitCode,
					timedOut: result.value.timedOut,
					log: {
						stdout: result.value.stdout.slice(),
						stderr: result.value.stderr.slice(),
					},
				},
			};
		},
	};
	return { ok: true, value: adapter };
}
