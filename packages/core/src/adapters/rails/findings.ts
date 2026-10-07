import type { GateFinding, GateFindingSeverity } from "../../gate/findings";
import type { AdapterLog } from "../interface";
import { parseMinitestResults } from "./ledger";

const RUBOCOP_LINE =
	/^(.+?):([0-9]+):([0-9]+): ([CWEF]): (?:\[Correctable\] )?([A-Za-z][A-Za-z0-9_/-]+): (.*)$/u;
const STANDARD_LINE =
	/^(.+?):([0-9]+):([0-9]+): (?:\[Correctable\] )?([A-Za-z][A-Za-z0-9_/-]+): (.*)$/u;

export interface RailsFindingOptions {
	readonly slug: string;
	readonly candidatePath: string;
	readonly step?: string;
}

function numeric(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function severityForRubocop(code: string): GateFindingSeverity {
	if (code === "E" || code === "F") return "error";
	if (code === "C" || code === "W") return "warning";
	return "note";
}

function finding(
	step: string,
	path: string,
	line: number,
	column: number,
	severity: GateFindingSeverity,
	rule: string,
	symbol: string,
	message: string,
): GateFinding {
	return {
		step,
		path,
		line,
		column,
		severity,
		rule,
		symbol,
		message,
		excused: false,
	};
}

function rubyLintFindings(log: AdapterLog, step: string): GateFinding[] {
	const findings: GateFinding[] = [];
	for (const stream of [log.stdout, log.stderr]) {
		const text = new TextDecoder("utf-8").decode(stream);
		for (const rawLine of text.split("\n")) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			const rubocop = RUBOCOP_LINE.exec(line);
			if (rubocop !== null) {
				const path = rubocop[1];
				const lineNumber = numeric(rubocop[2]);
				const column = numeric(rubocop[3]);
				const code = rubocop[4];
				const cop = rubocop[5];
				const message = rubocop[6];
				if (
					path !== undefined &&
					lineNumber !== null &&
					column !== null &&
					code !== undefined &&
					cop !== undefined &&
					message !== undefined
				) {
					findings.push(
						finding(
							step,
							path,
							lineNumber,
							column,
							severityForRubocop(code),
							`rubocop/${cop}`,
							"",
							message,
						),
					);
				}
				continue;
			}
			const standard = STANDARD_LINE.exec(line);
			if (standard === null) continue;
			const path = standard[1];
			const lineNumber = numeric(standard[2]);
			const column = numeric(standard[3]);
			const cop = standard[4];
			const message = standard[5];
			if (
				path === undefined ||
				lineNumber === null ||
				column === null ||
				cop === undefined ||
				message === undefined
			)
				continue;
			findings.push(
				finding(
					step,
					path,
					lineNumber,
					column,
					"warning",
					`standard/${cop}`,
					"",
					message,
				),
			);
		}
	}
	return findings;
}

/** Parse Rails Minitest failures/skips and Standard/RuboCop diagnostics. */
export function parseRailsFindings(
	log: AdapterLog,
	options: RailsFindingOptions,
): readonly GateFinding[] {
	const step = options.step ?? "acceptance";
	const findings = rubyLintFindings(log, step);
	for (const result of parseMinitestResults(log)) {
		if (result.resultCode === ".") continue;
		const severity = result.resultCode === "S" ? "warning" : "error";
		const itemNumber =
			/(?:^|[^A-Za-z0-9])A([1-9][0-9]*)(?=$|[^A-Za-z0-9])/u.exec(
				result.methodName,
			)?.[1];
		findings.push(
			finding(
				step,
				options.candidatePath,
				1,
				1,
				severity,
				"minitest/test",
				result.testName,
				itemNumber === undefined
					? `Minitest result ${result.resultCode} for ${result.testName}.`
					: `Minitest result ${result.resultCode} for ${result.testName} (${options.slug}/A${itemNumber}).`,
			),
		);
	}
	return findings;
}
