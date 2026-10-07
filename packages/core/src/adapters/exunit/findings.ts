import type { GateFinding, GateFindingSeverity } from "../../gate/findings";
import type { AdapterLog } from "../interface";

export type ExUnitFindingParser = (
	log: AdapterLog,
	step: string,
) => readonly GateFinding[];

function decodeLog(log: AdapterLog): string {
	// AdapterLog carries separate streams; match the gate's stdout-then-stderr view.
	return `${new TextDecoder().decode(log.stdout)}\n${new TextDecoder().decode(log.stderr)}`.replace(
		/\r\n?/gu,
		"\n",
	);
}

function finding(input: {
	readonly step: string;
	readonly path: string;
	readonly line: number;
	readonly column?: number;
	readonly severity?: GateFindingSeverity;
	readonly rule: string;
	readonly symbol?: string;
	readonly message: string;
}): GateFinding {
	return {
		step: input.step,
		path: input.path,
		line: input.line,
		column: input.column ?? 1,
		severity: input.severity ?? "error",
		rule: input.rule,
		symbol: input.symbol ?? "",
		message: input.message,
		excused: false,
	};
}

const EXUNIT_FAILURE_HEADER = /^\s*[0-9]+\) test (.*) \(([^()]+)\)\s*$/u;
const SOURCE_LOCATION =
	/^\s+(.+?\.(?:ex|exs)):(\d+)(?::(\d+))?(?:\s+\(test\))?\s*$/u;

/** Parse the failure blocks emitted by ExUnit.CLIFormatter. */
export function parseExUnitFailures(
	log: AdapterLog,
	step: string,
): readonly GateFinding[] {
	const lines = decodeLog(log).split("\n");
	const findings: GateFinding[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const header = lines[index];
		if (header === undefined) continue;
		const match = EXUNIT_FAILURE_HEADER.exec(header);
		if (match === null) continue;
		const rawName = match[1];
		if (rawName === undefined) continue;
		let location: RegExpExecArray | null = null;
		let message = "ExUnit test failed";
		for (let next = index + 1; next < lines.length; next += 1) {
			const current = lines[next];
			if (current === undefined) continue;
			if (
				EXUNIT_FAILURE_HEADER.test(current) ||
				/^Finished in\b/u.test(current)
			) {
				index = next - 1;
				break;
			}
			if (location === null) location = SOURCE_LOCATION.exec(current);
			if (
				location !== null &&
				current.trim().length > 0 &&
				!SOURCE_LOCATION.test(current)
			) {
				const detail = current.trim();
				if (
					!detail.startsWith("code:") &&
					!detail.startsWith("left:") &&
					!detail.startsWith("right:") &&
					!detail.startsWith("stacktrace:")
				) {
					message = detail;
					break;
				}
			}
		}
		if (location === null) continue;
		const path = location[1];
		const lineText = location[2];
		const columnText = location[3];
		if (path === undefined || lineText === undefined) continue;
		const line = Number(lineText);
		const column = columnText === undefined ? 1 : Number(columnText);
		if (
			!Number.isSafeInteger(line) ||
			line < 1 ||
			!Number.isSafeInteger(column) ||
			column < 1
		)
			continue;
		findings.push(
			finding({
				step,
				path,
				line,
				column,
				rule: "exunit/test",
				symbol: rawName.replace(/^test /u, ""),
				message,
			}),
		);
	}
	return findings;
}

const COMPILER_ERROR =
	/^\*\* \((?:CompileError|SyntaxError|TokenMissingError)\) (.+?\.(?:ex|exs)):(\d+)(?::(\d+))?:\s*(.*)$/u;

/** Parse Elixir compiler diagnostics while retaining path/line identity. */
export function parseElixirCompilerErrors(
	log: AdapterLog,
	step: string,
): readonly GateFinding[] {
	const findings: GateFinding[] = [];
	for (const line of decodeLog(log).split("\n")) {
		const match = COMPILER_ERROR.exec(line);
		if (match === null) continue;
		const path = match[1];
		const lineText = match[2];
		const columnText = match[3];
		if (path === undefined || lineText === undefined) continue;
		const lineNumber = Number(lineText);
		const column = columnText === undefined ? 1 : Number(columnText);
		if (
			!Number.isSafeInteger(lineNumber) ||
			lineNumber < 1 ||
			!Number.isSafeInteger(column) ||
			column < 1
		)
			continue;
		findings.push(
			finding({
				step,
				path,
				line: lineNumber,
				column,
				rule: "elixir/compiler",
				message: match[4] ?? "Elixir compilation failed",
			}),
		);
	}
	return findings;
}

const CREDO_BOX_HEADING =
	/^\s*[┃│]\s+\[[A-Z]\]\s+↗\s+(.+?\.(?:ex|exs)):(\d+):(\d+)\s*$/u;
const CREDO_GNU =
	/^(.+?\.(?:ex|exs)):(\d+)(?::(\d+))?: (?:warning|error|note): \[([^\]]*Credo[^\]]*)\] ?(.*)$/u;

/** Parse both the standard Credo box output and GNU-like Credo diagnostics. */
export function parseCredoFindings(
	log: AdapterLog,
	step: string,
): readonly GateFinding[] {
	const lines = decodeLog(log).split("\n");
	const findings: GateFinding[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const gnu = CREDO_GNU.exec(line);
		if (gnu !== null) {
			const path = gnu[1];
			const lineText = gnu[2];
			const columnText = gnu[3];
			const rule = gnu[4];
			if (path === undefined || lineText === undefined || rule === undefined)
				continue;
			const lineNumber = Number(lineText);
			const column = columnText === undefined ? 1 : Number(columnText);
			if (
				!Number.isSafeInteger(lineNumber) ||
				lineNumber < 1 ||
				!Number.isSafeInteger(column) ||
				column < 1
			)
				continue;
			findings.push(
				finding({
					step,
					path,
					line: lineNumber,
					column,
					rule: `credo/${rule.replace(/^Credo\.Check\.?/u, "")}`,
					message: gnu[5] ?? "Credo reported an issue",
				}),
			);
			continue;
		}
		const heading = CREDO_BOX_HEADING.exec(line);
		if (heading === null) continue;
		const path = heading[1];
		const lineText = heading[2];
		const columnText = heading[3];
		if (
			path === undefined ||
			lineText === undefined ||
			columnText === undefined
		)
			continue;
		let message = "Credo reported an issue";
		let checkName = "unknown";
		for (let next = index + 1; next < lines.length; next += 1) {
			const detail = lines[next]?.replace(/^\s*[┃│]\s*/u, "").trim();
			if (detail === undefined || detail.length === 0) continue;
			if (CREDO_BOX_HEADING.test(lines[next] ?? "")) {
				index = next - 1;
				break;
			}
			if (/^Credo\.Check\./u.test(detail)) {
				checkName = detail.replace(/^Credo\.Check\.?/u, "");
				break;
			}
			if (message === "Credo reported an issue") message = detail;
		}
		const lineNumber = Number(lineText);
		const column = Number(columnText);
		if (
			!Number.isSafeInteger(lineNumber) ||
			lineNumber < 1 ||
			!Number.isSafeInteger(column) ||
			column < 1
		)
			continue;
		findings.push(
			finding({
				step,
				path,
				line: lineNumber,
				column,
				rule: `credo/${checkName}`,
				message,
			}),
		);
	}
	return findings;
}

const FORMAT_HEADER = "The following files are not formatted:";
const FORMAT_PATH = /^\s*\*\s+(.+?\.(?:ex|exs))\s*$/u;

/** Turn mix format --check-formatted file entries into stable gate findings. */
export function parseMixFormatFindings(
	log: AdapterLog,
	step: string,
): readonly GateFinding[] {
	const findings: GateFinding[] = [];
	let inFileList = false;
	for (const line of decodeLog(log).split("\n")) {
		if (line.includes(FORMAT_HEADER)) {
			inFileList = true;
			continue;
		}
		if (!inFileList) continue;
		const match = FORMAT_PATH.exec(line);
		if (match === null) {
			if (line.trim().length > 0 && !/^\s*\*/u.test(line)) inFileList = false;
			continue;
		}
		const path = match[1];
		if (path === undefined) continue;
		findings.push(
			finding({
				step,
				path,
				line: 1,
				rule: "mix_format/check-formatted",
				message: "file is not formatted",
			}),
		);
	}
	return findings;
}

export const EXUNIT_FINDING_PARSERS: readonly ExUnitFindingParser[] = [
	parseExUnitFailures,
	parseElixirCompilerErrors,
	parseCredoFindings,
	parseMixFormatFindings,
];
