import { isAbsolute } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type {
	FileSystemPort,
	FileWriteRequest,
	ProcessPort,
} from "../../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../../fs/read";
import { isValidIntentSlug } from "../../intent/parse";
import { COMMAND_ADAPTER_OUTPUT_LIMIT_BYTES } from "../command";
import type {
	AcceptanceAdapter,
	AdapterLog,
	AdapterRunResult,
	RunAcceptanceTestRequest,
	StageAcceptanceTestRequest,
	StagedAcceptanceTest,
} from "../interface";
import { railsAcceptanceCommand } from "./commands";
import {
	RAILS_CANDIDATE_DIRECTORY,
	RAILS_SOURCE_DIRECTORY,
	RAILS_TEST_SUFFIX,
	railsChildEnvironment,
} from "./config";
import { minitestLedgerRows } from "./ledger";

const MAX_ARG_BYTES = 4096;
const MAX_REPORT_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const LEDGER_WRITER_TIMEOUT_MS = 5_000;
const LEDGER_WRITER_OUTPUT_LIMIT_BYTES = 4096;

const LEDGER_WRITER_RUBY = [
	"path = ARGV.fetch(0)",
	"flags = File::WRONLY | File::CREAT | File::EXCL",
	"flags |= File::NOFOLLOW if defined?(File::NOFOLLOW)",
	"File.open(path, flags, 0o600) { |file| file.binmode; file.write(STDIN.read) }",
].join("; ");

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validAbsolutePath(value: string): boolean {
	return (
		value.length > 0 &&
		isAbsolute(value) &&
		!value.includes("\0") &&
		byteLength(value) <= MAX_ARG_BYTES
	);
}

function railsSourcePath(slug: string): string {
	if (!isValidIntentSlug(slug))
		throw new TypeError("Acceptance slug is invalid.");
	return `${RAILS_SOURCE_DIRECTORY}/${slug}${RAILS_TEST_SUFFIX}`;
}

function railsCandidatePath(slug: string): string {
	if (!isValidIntentSlug(slug))
		throw new TypeError("Acceptance slug is invalid.");
	return `${RAILS_CANDIDATE_DIRECTORY}/${slug}${RAILS_TEST_SUFFIX}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

async function stageAcceptanceTest(
	filesystem: Pick<
		FileSystemPort,
		"readFile" | "writeFileAtomically" | "removeFile"
	>,
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
	let sourcePath: string;
	let candidatePath: string;
	try {
		sourcePath = railsSourcePath(request.slug);
		candidatePath = railsCandidatePath(request.slug);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				cause instanceof Error ? cause.message : "Acceptance slug is invalid.",
			),
		};
	}
	const source = await filesystem.readFile({
		root: request.sourceRoot,
		path: sourcePath,
		maxBytes: MAX_REPORT_BYTES,
	});
	if (!source.ok) return source;
	const candidate = await filesystem.readFile({
		root: request.workdir,
		path: candidatePath,
		maxBytes: MAX_REPORT_BYTES,
	});
	if (candidate.ok)
		return {
			ok: false,
			error: portError(
				"conflict",
				`Staged acceptance path is already occupied: ${candidatePath}.`,
			),
		};
	if (candidate.error.code !== "not_found") {
		if (
			candidate.error.code === "invalid_input" ||
			candidate.error.code === "permission_denied"
		)
			return {
				ok: false,
				error: portError(
					"conflict",
					`Staged acceptance path is occupied or unsafe: ${candidatePath}.`,
				),
			};
		return candidate;
	}
	const sourceCopy = await filesystem.readFile({
		root: request.workdir,
		path: sourcePath,
		maxBytes: MAX_REPORT_BYTES,
	});
	if (sourceCopy.ok && !sameBytes(sourceCopy.value, source.value))
		return {
			ok: false,
			error: portError(
				"conflict",
				"Acceptance source in the candidate worktree differs from the approved source.",
			),
		};
	if (!sourceCopy.ok && sourceCopy.error.code !== "not_found")
		return sourceCopy;
	const write: FileWriteRequest = {
		root: request.workdir,
		path: candidatePath,
		bytes: source.value,
		mode: 0o600,
	};
	const written = await filesystem.writeFileAtomically(write);
	if (!written.ok) return written;
	if (sourceCopy.ok) {
		const removed = await filesystem.removeFile(request.workdir, sourcePath);
		if (!removed.ok && removed.error.code !== "not_found") {
			const rollback = await filesystem.removeFile(
				request.workdir,
				candidatePath,
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
			sourcePath,
			candidatePath,
			bytesWritten: source.value.byteLength,
		},
	};
}

function jsonLines(rows: ReturnType<typeof minitestLedgerRows>): Uint8Array {
	if (rows.length === 0) return new Uint8Array();
	return new TextEncoder().encode(
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
}

async function writeLedgerReport(
	process: Pick<ProcessPort, "run">,
	request: RunAcceptanceTestRequest,
	log: AdapterLog,
): Promise<Result<void>> {
	if (
		!isAbsolute(request.reportPath) ||
		request.reportPath.includes("\0") ||
		byteLength(request.reportPath) > MAX_ARG_BYTES
	)
		return {
			ok: false,
			error: portError("invalid_input", "Rails ledger report path is invalid."),
		};
	const bytes = jsonLines(minitestLedgerRows(log, request.slug));
	if (bytes.byteLength > MAX_REPORT_BYTES)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Rails acceptance ledger is too large.",
			),
		};
	let written: Awaited<ReturnType<ProcessPort["run"]>>;
	try {
		written = await process.run({
			argv: ["ruby", "-e", LEDGER_WRITER_RUBY, request.reportPath],
			cwd: request.workdir,
			env: request.environment,
			stdin: bytes,
			timeoutMilliseconds: Math.min(
				request.timeoutMilliseconds,
				LEDGER_WRITER_TIMEOUT_MS,
			),
			outputLimitBytes: LEDGER_WRITER_OUTPUT_LIMIT_BYTES,
		});
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				cause instanceof Error
					? `Rails ledger writer could not be supervised: ${cause.message}`
					: "Rails ledger writer could not be supervised.",
				true,
			),
		};
	}
	if (!written.ok) return written;
	if (written.value.timedOut)
		return {
			ok: false,
			error: portError("timeout", "Rails ledger writer timed out.", true),
		};
	if (written.value.exitCode !== 0)
		return {
			ok: false,
			error: portError(
				"io",
				`Rails ledger writer exited with status ${String(written.value.exitCode)}.`,
			),
		};
	return { ok: true, value: undefined };
}

const MISSING_RAILS_TOOL =
	/(?:command not found|not found|could not find (?:command|executable)|no such file or directory).{0,160}\b(?:bundle|rails|ruby)\b|\b(?:bundle|rails|ruby)\b.{0,160}(?:command not found|not found|no such file or directory)/iu;

export function railsAdapterUnavailable(log: AdapterLog): boolean {
	const text = `${new TextDecoder().decode(log.stdout)}\n${new TextDecoder().decode(log.stderr)}`;
	return MISSING_RAILS_TOOL.test(text);
}

/** Create the Rails runner on top of the shared command adapter's path/stage contract. */
export function createRailsAdapter(): Result<AcceptanceAdapter> {
	const adapter: AcceptanceAdapter = {
		name: "rails",
		sourcePath: railsSourcePath,
		candidatePath: railsCandidatePath,
		stage(request) {
			return stageAcceptanceTest(request.filesystem, request);
		},
		async run(request): Promise<Result<AdapterRunResult>> {
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
			const argv = railsAcceptanceCommand(railsCandidatePath(request.slug));
			if (argv === null)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Rails acceptance path is invalid.",
					),
				};
			const environment = railsChildEnvironment(request.environment);
			environment.KOGEN_LEDGER_REPORT = request.reportPath;
			environment.KOGEN_INTENT_SLUG = request.slug;
			let execution: Awaited<ReturnType<ProcessPort["run"]>>;
			try {
				execution = await request.process.run({
					argv,
					cwd: request.workdir,
					env: environment,
					timeoutMilliseconds: request.timeoutMilliseconds,
					outputLimitBytes: COMMAND_ADAPTER_OUTPUT_LIMIT_BYTES,
				});
			} catch (cause) {
				return {
					ok: false,
					error: portError(
						"unavailable",
						cause instanceof Error
							? `Acceptance process could not be supervised: ${cause.message}`
							: "Acceptance process could not be supervised.",
						true,
					),
				};
			}
			if (!execution.ok) return execution;
			const result: AdapterRunResult = {
				exitStatus: execution.value.exitCode,
				timedOut: execution.value.timedOut,
				log: {
					stdout: execution.value.stdout.slice(),
					stderr: execution.value.stderr.slice(),
				},
			};
			const report = await writeLedgerReport(
				request.process,
				request,
				result.log,
			);
			if (!report.ok) return report;
			return { ok: true, value: result };
		},
		unavailable: railsAdapterUnavailable,
	};
	return { ok: true, value: adapter };
}
