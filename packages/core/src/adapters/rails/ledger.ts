import type { AcceptanceLedgerRow, AdapterLog } from "../interface";

export interface MinitestResult {
	readonly className: string;
	readonly methodName: string;
	readonly resultCode: "." | "F" | "E" | "S" | string;
	readonly testName: string;
}

const MINITEST_VERBOSE_RESULT =
	/^(.+?)#(.+?) = [0-9]+(?:\.[0-9]+)? s = ([A-Z.])$/u;
const ACCEPTANCE_ITEM = /(?:^|[^A-Za-z0-9])A([1-9][0-9]*)(?=$|[^A-Za-z0-9])/gu;

function decodedLines(bytes: Uint8Array): string[] {
	return new TextDecoder("utf-8").decode(bytes).split("\n");
}

/** Parse the stable `--verbose` progress records emitted by Minitest. */
export function parseMinitestResults(
	log: AdapterLog,
): readonly MinitestResult[] {
	const results: MinitestResult[] = [];
	for (const stream of [log.stdout, log.stderr]) {
		for (const rawLine of decodedLines(stream)) {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			const match = MINITEST_VERBOSE_RESULT.exec(line);
			const className = match?.[1];
			const methodName = match?.[2];
			const resultCode = match?.[3];
			if (
				className === undefined ||
				methodName === undefined ||
				resultCode === undefined
			)
				continue;
			results.push({
				className,
				methodName,
				resultCode,
				testName: `${className}#${methodName}`,
			});
		}
	}
	return results;
}

function tagForMethod(slug: string, methodName: string): string | null {
	const ids = new Set<string>();
	for (const match of methodName.matchAll(ACCEPTANCE_ITEM)) {
		const number = match[1];
		if (number !== undefined) ids.add(number);
	}
	if (ids.size !== 1) return null;
	const [number] = ids;
	return number === undefined ? null : `${slug}/A${number}`;
}

function statusForCode(code: string): AcceptanceLedgerRow["status"] {
	switch (code) {
		case ".":
			return "passed";
		case "F":
		case "E":
			return "failed";
		case "S":
			return "skipped";
		default:
			return "invalid";
	}
}

/**
 * Bridge Minitest's named verbose results into the common acceptance JSONL
 * ledger. Untagged or ambiguously tagged tests are retained as invalid rows,
 * which makes the ledger evaluator report them as unknown instead of silently
 * dropping executed tests. The frozen spec does not define Rails tag syntax;
 * this bridge recognizes one delimited `A<n>` token in the Minitest method name.
 */
export function minitestLedgerRows(
	log: AdapterLog,
	slug: string,
): readonly AcceptanceLedgerRow[] {
	return parseMinitestResults(log).map((result) => {
		const tag = tagForMethod(slug, result.methodName);
		return {
			tag: tag ?? `${slug}/__untagged__`,
			test: result.testName,
			status: tag === null ? "invalid" : statusForCode(result.resultCode),
		};
	});
}
