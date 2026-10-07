import {
	firstYamlIssue,
	orderYamlIssues,
	preflightYaml,
	type YamlIssue,
	type YamlSourceLine,
	yamlIssue,
} from "./preflight";

export interface YamlLexedLine extends YamlSourceLine {
	readonly indent: number;
	readonly code: string;
	readonly content: string;
	readonly commentOffset: number | null;
	readonly flowDepthStart: number;
	readonly flowDepthEnd: number;
}

export interface YamlLexedDocument {
	readonly source: string;
	readonly lines: readonly YamlLexedLine[];
}

export interface YamlLexResult {
	readonly document: YamlLexedDocument | null;
	readonly issues: readonly YamlIssue[];
}

interface QuoteState {
	readonly character: "'" | '"';
	readonly line: number;
	readonly offset: number;
}

interface ScannedLine {
	readonly line: YamlLexedLine;
	readonly quote: QuoteState | null;
	readonly flowStack: readonly ("[" | "{")[];
	readonly issues: readonly YamlIssue[];
}

function leadingSpaces(text: string): number {
	let index = 0;
	while (text[index] === " ") index += 1;
	return index;
}

function isWhitespace(character: string | undefined): boolean {
	return character === " " || character === "\t";
}

function hasAllowedQuoteTail(text: string, closeAt: number): boolean {
	let index = closeAt + 1;
	while (text[index] === " ") index += 1;
	const next = text[index];
	return (
		next === undefined ||
		(next === "#" && index > closeAt + 1) ||
		next === ":" ||
		next === "," ||
		next === "]" ||
		next === "}"
	);
}

function matchingBracketEnd(text: string, start: number): number | null {
	const opening = text[start];
	if (opening !== "[" && opening !== "{") return null;
	const expected = opening === "[" ? "]" : "}";
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (quote === '"') {
			if (character === "\\") index += 1;
			else if (character === '"') quote = null;
			continue;
		}
		if (quote === "'") {
			if (character === "'" && text[index + 1] === "'") index += 1;
			else if (character === "'") quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === opening) depth += 1;
		else if (character === expected) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return null;
}

function markerIssue(code: string, line: number): YamlIssue | null {
	const content = code.trimStart();
	if (content.startsWith("%") || /^(?:---|\.\.\.)(?=$|\s)/u.test(content)) {
		return yamlIssue("directives_or_markers", line, {}, code.indexOf(content));
	}
	return null;
}

function blockScalarOffset(
	code: string,
	delimiterOffset: number | null,
): number | null {
	let index: number;
	if (delimiterOffset !== null) {
		index = delimiterOffset + 1;
		while (code[index] === " ") index += 1;
	} else {
		index = leadingSpaces(code);
		if (code[index] === "-" && code[index + 1] === " ") {
			index += 2;
			while (code[index] === " ") index += 1;
		}
	}
	if (code[index] !== "|" && code[index] !== ">") return null;
	const suffix = code.slice(index + 1);
	if (!/^(?:[1-9][+-]?|[+-][1-9]?)?\s*$/u.test(suffix)) return null;
	return index;
}

function mergeKeyOffset(masked: string): number | null {
	const block = /^\s*<<\s*:/u.exec(masked);
	if (block) return masked.indexOf("<<");
	const flow = /[,{]\s*<<\s*:/u.exec(masked);
	return flow ? masked.indexOf("<<", flow.index) : null;
}

function scanLine(
	line: YamlSourceLine,
	flowStackInput: readonly ("[" | "{")[],
	quoteInput: QuoteState | null,
): ScannedLine {
	const issues: YamlIssue[] = [];
	const text = line.text;
	const masked = text.split("");
	const flowDepthByOffset = new Array<number>(text.length).fill(0);
	const flowStack = [...flowStackInput];
	let quote = quoteInput;
	let commentOffset: number | null = null;
	let delimiterOffset: number | null = null;
	let nodeExpected = flowStack.length > 0;
	let plainTokenStart: number | null = null;
	let codeEnd = text.length;

	for (let index = 0; index < text.length; index += 1) {
		flowDepthByOffset[index] = flowStack.length;
		const character = text[index];
		if (character === undefined) continue;

		if (quote !== null) {
			masked[index] = " ";
			if (quote.character === '"' && character === "\\") {
				const escaped = text[index + 1];
				if (escaped !== undefined) {
					masked[index + 1] = " ";
					if (escaped === "u") {
						issues.push(yamlIssue("unicode_escape", line.number, {}, index));
					} else if (!'nt"\\/'.includes(escaped)) {
						issues.push(
							yamlIssue(
								"unsupported_escape",
								line.number,
								{ character: escaped },
								index,
							),
						);
					}
					index += 1;
				}
				continue;
			}
			if (
				quote.character === "'" &&
				character === "'" &&
				text[index + 1] === "'"
			) {
				masked[index + 1] = " ";
				index += 1;
				continue;
			}
			if (character === quote.character) {
				quote = null;
				if (!hasAllowedQuoteTail(text, index)) {
					issues.push(
						yamlIssue("text_after_quote", line.number, {}, index + 1),
					);
				}
			}
			continue;
		}

		if (character === "#" && (index === 0 || text[index - 1] === " ")) {
			commentOffset = index;
			codeEnd = index;
			for (let rest = index; rest < text.length; rest += 1) masked[rest] = " ";
			break;
		}

		if (nodeExpected && (character === '"' || character === "'")) {
			quote = { character, line: line.number, offset: index };
			masked[index] = " ";
			nodeExpected = false;
			plainTokenStart = null;
			continue;
		}

		if (
			nodeExpected &&
			(character === "&" || character === "*" || character === "!") &&
			text[index + 1] !== undefined &&
			!isWhitespace(text[index + 1])
		) {
			issues.push(yamlIssue("anchors_aliases_or_tags", line.number, {}, index));
		}

		if (character === "[" || character === "{") {
			if (flowStack.length > 0 && !nodeExpected) {
				const start = plainTokenStart ?? index;
				const end = matchingBracketEnd(text, index);
				const value = text
					.slice(start, end === null ? text.length : end + 1)
					.trim();
				issues.push(yamlIssue("flow_brackets", line.number, { value }, index));
			}
			flowStack.push(character);
			nodeExpected = true;
			plainTokenStart = null;
			continue;
		}

		if (character === "]" || character === "}") {
			if (flowStack.length > 0) flowStack.pop();
			nodeExpected = false;
			plainTokenStart = null;
			continue;
		}

		if (character === "," && flowStack.length > 0) {
			nodeExpected = true;
			plainTokenStart = null;
			continue;
		}

		if (
			character === ":" &&
			flowStack.length === 0 &&
			delimiterOffset === null &&
			(index + 1 === text.length || isWhitespace(text[index + 1]))
		) {
			delimiterOffset = index;
			nodeExpected = true;
			plainTokenStart = null;
			continue;
		}

		if (character === ":" && flowStack.length > 0 && flowStack.at(-1) === "{") {
			nodeExpected = true;
			plainTokenStart = null;
			continue;
		}

		if (nodeExpected && character === "-" && text[index + 1] === " ") {
			plainTokenStart = null;
			continue;
		}

		if (character === " ") continue;
		if (nodeExpected) {
			nodeExpected = false;
			plainTokenStart = index;
		}
	}

	const code = text.slice(0, codeEnd);
	const visible = masked.slice(0, codeEnd).join("");
	const directive = markerIssue(code, line.number);
	if (directive !== null) issues.push(directive);

	const scalarOffset = blockScalarOffset(code, delimiterOffset);
	if (scalarOffset !== null)
		issues.push(yamlIssue("block_scalar", line.number, {}, scalarOffset));

	const mergeOffset = mergeKeyOffset(visible);
	if (mergeOffset !== null)
		issues.push(yamlIssue("merge_key", line.number, {}, mergeOffset));

	if (delimiterOffset !== null) {
		let valueStart = delimiterOffset + 1;
		while (code[valueStart] === " ") valueStart += 1;
		let plainValueEnd = code.length;
		while (plainValueEnd > valueStart && code[plainValueEnd - 1] === " ")
			plainValueEnd -= 1;
		const value = code.slice(valueStart, plainValueEnd);
		if (flowStackInput.length === 0 && value.startsWith("- ")) {
			issues.push(yamlIssue("list_in_value", line.number, {}, valueStart));
		}
		for (let index = delimiterOffset + 1; index < codeEnd; index += 1) {
			if (
				visible[index] === ":" &&
				flowDepthByOffset[index] === 0 &&
				(index + 1 === codeEnd || isWhitespace(code[index + 1]))
			) {
				issues.push(yamlIssue("colon_space", line.number, { value }, index));
				break;
			}
		}
	}

	const indent = leadingSpaces(text);
	return {
		line: {
			number: line.number,
			text,
			indent,
			code,
			content: code.slice(indent),
			commentOffset,
			flowDepthStart: flowStackInput.length,
			flowDepthEnd: flowStack.length,
		},
		quote,
		flowStack,
		issues,
	};
}

export function lexYaml(input: Uint8Array): YamlLexResult {
	const preflight = preflightYaml(input);
	if (preflight.document === null) {
		return { document: null, issues: preflight.issues };
	}

	const issues = [...preflight.issues];
	const lines: YamlLexedLine[] = [];
	let flowStack: readonly ("[" | "{")[] = [];
	let quote: QuoteState | null = null;
	for (const sourceLine of preflight.document.lines) {
		const scanned = scanLine(sourceLine, flowStack, quote);
		lines.push(scanned.line);
		issues.push(...scanned.issues);
		flowStack = scanned.flowStack;
		quote = scanned.quote;
	}

	if (quote !== null) {
		issues.push(yamlIssue("unterminated_quote", quote.line, {}, quote.offset));
	}
	if (lines.every((line) => line.code.trim().length === 0)) {
		issues.push(yamlIssue("empty_document"));
	}

	const document: YamlLexedDocument = {
		source: preflight.document.source,
		lines,
	};
	return { document, issues: orderYamlIssues(issues) };
}

export function firstLexicalYamlIssue(result: YamlLexResult): YamlIssue | null {
	return firstYamlIssue(result.issues);
}
