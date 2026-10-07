export type GateFindingSeverity = "error" | "warning" | "note";

export interface GateFindingIdentity {
	readonly path: string;
	/** The complete GNU tool/rule field, for example `lint/todo`. */
	readonly rule: string;
	/** Empty for non-test findings. */
	readonly symbol: string;
}

export interface GateFinding extends GateFindingIdentity {
	readonly step: string;
	readonly line: number;
	readonly column: number;
	readonly severity: GateFindingSeverity;
	readonly message: string;
	readonly excused: boolean;
}

export interface BaselineFinding extends GateFindingIdentity {
	readonly message: string;
}

const GNU_FINDING_LINE =
	/^(.+?):([0-9]+)(?::([0-9]+))?: (error|warning|note): \[([^\]]+)\](?: (.*))?$/u;

function isTestFinding(rule: string): boolean {
	const slash = rule.indexOf("/");
	return slash >= 0 && rule.slice(slash + 1) === "test";
}

function splitTestSymbol(value: string): { symbol: string; message: string } {
	const colon = value.indexOf(": ");
	if (colon <= 0) return { symbol: "", message: value };
	return {
		symbol: value.slice(0, colon),
		message: value.slice(colon + 2),
	};
}

function parseStream(bytes: Uint8Array, step: string): GateFinding[] {
	const text = new TextDecoder("utf-8").decode(bytes);
	const findings: GateFinding[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const match = GNU_FINDING_LINE.exec(line);
		if (match === null) continue;
		const path = match[1];
		const lineText = match[2];
		const columnText = match[3];
		const severity = match[4];
		const rule = match[5];
		const rawMessage = match[6] ?? "";
		if (
			path === undefined ||
			lineText === undefined ||
			rule === undefined ||
			(severity !== "error" && severity !== "warning" && severity !== "note")
		)
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
		const testFinding = isTestFinding(rule)
			? splitTestSymbol(rawMessage)
			: { symbol: "", message: rawMessage };
		findings.push({
			step,
			path,
			line: lineNumber,
			column,
			severity,
			rule,
			symbol: testFinding.symbol,
			message: testFinding.message,
			excused: false,
		});
	}
	return findings;
}

/** Parse GNU diagnostics from the two captured streams without altering their raw bytes. */
export function parseGateFindings(
	stdout: Uint8Array,
	stderr: Uint8Array,
	step: string,
): readonly GateFinding[] {
	return [...parseStream(stdout, step), ...parseStream(stderr, step)];
}

/** A collision-free key for the frozen `(path, tool/rule, symbol)` identity. */
export function findingIdentityKey(identity: GateFindingIdentity): string {
	return JSON.stringify([identity.path, identity.rule, identity.symbol]);
}

export function distinctFindingIdentities(
	findings: readonly GateFindingIdentity[],
): ReadonlySet<string> {
	return new Set(findings.map(findingIdentityKey));
}

export function countDistinctFindingIdentities(
	findings: readonly GateFindingIdentity[],
): number {
	return distinctFindingIdentities(findings).size;
}

export function findingTool(rule: string): string {
	const slash = rule.indexOf("/");
	return slash < 0 ? rule : rule.slice(0, slash);
}
