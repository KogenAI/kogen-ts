import type { YamlLexedDocument, YamlLexedLine } from "./lex";
import { orderYamlIssues, type YamlIssue, yamlIssue } from "./preflight";

export const YAML_MAX_COLLECTION_DEPTH = 64;

export interface YamlScalarNode {
	readonly kind: "scalar";
	readonly value: string;
}

export interface YamlMapNode {
	readonly kind: "map";
	readonly entries: ReadonlyMap<string, YamlBlockNode>;
}

export interface YamlSequenceNode {
	readonly kind: "sequence";
	readonly items: readonly YamlBlockNode[];
}

/**
 * A flow collection is kept intact for the flow parser to validate and decode.
 * `line` and `column` point to the opening bracket in the original document.
 */
export interface YamlFlowNode {
	readonly kind: "flow";
	readonly source: string;
	readonly line: number;
	readonly column: number;
}

export type YamlBlockNode =
	| YamlScalarNode
	| YamlMapNode
	| YamlSequenceNode
	| YamlFlowNode;

export interface YamlBlockParseResult {
	readonly node: YamlBlockNode | null;
	readonly issues: readonly YamlIssue[];
}

interface ParsedNode {
	readonly node: YamlBlockNode;
	readonly nextIndex: number;
}

interface ParsedPair {
	readonly nextIndex: number;
}

interface InitialSequenceItem {
	readonly line: YamlLexedLine;
	readonly lineIndex: number;
	readonly payload: string;
}

function scalar(value: string): YamlScalarNode {
	return { kind: "scalar", value };
}

function isWhitespace(character: string | undefined): boolean {
	return character === " " || character === "\t";
}

function isSequenceIndicator(text: string): boolean {
	return /^-(?:\s|$)/u.test(text);
}

function afterSequenceIndicator(text: string): string {
	return text.slice(1).trimStart();
}

function mappingDelimiter(text: string): number | null {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === undefined) continue;

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
		if (
			character === ":" &&
			(index + 1 === text.length || isWhitespace(text[index + 1]))
		) {
			return index;
		}
	}
	return null;
}

export function decodeYamlScalar(raw: string): string {
	const text = raw.trim();
	if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") {
		return text.slice(1, -1).replaceAll("''", "'");
	}
	if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') {
		return text
			.slice(1, -1)
			.replace(/\\([nt"\\/])/gu, (_match, escaped: string) => {
				switch (escaped) {
					case "n":
						return "\n";
					case "t":
						return "\t";
					default:
						return escaped;
				}
			});
	}
	return text;
}

function stableIssues(issues: readonly YamlIssue[]): YamlIssue[] {
	const seen = new Set<string>();
	const unique: YamlIssue[] = [];
	for (const issue of issues) {
		const key = `${issue.code}\0${issue.line ?? ""}\0${issue.offset ?? ""}\0${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(issue);
	}
	return orderYamlIssues(unique);
}

class BlockParser {
	private readonly issues: YamlIssue[] = [];

	constructor(private readonly document: YamlLexedDocument) {}

	parse(): YamlBlockParseResult {
		let index = this.nextContent(0);
		if (index >= this.document.lines.length) {
			return { node: null, issues: [] };
		}

		const first = this.document.lines[index];
		if (first === undefined) return { node: null, issues: [] };
		if (first.indent > 0) {
			this.issues.push(yamlIssue("unexpected_indentation", first.number));
		}

		const parsed = this.parseNode(index, 0);
		index = this.nextContent(parsed.nextIndex);
		if (index < this.document.lines.length) {
			const trailing = this.document.lines[index];
			if (trailing !== undefined) {
				this.issues.push(yamlIssue("unexpected_indentation", trailing.number));
			}
		}

		return { node: parsed.node, issues: stableIssues(this.issues) };
	}

	private nextContent(start: number): number {
		let index = start;
		while (index < this.document.lines.length) {
			const line = this.document.lines[index];
			if (line === undefined || line.content.trim().length === 0) {
				index += 1;
				continue;
			}
			break;
		}
		return index;
	}

	private skipIndentedBlock(start: number, parentIndent: number): number {
		let index = start;
		while (index < this.document.lines.length) {
			index = this.nextContent(index);
			const line = this.document.lines[index];
			if (line === undefined || line.indent <= parentIndent) return index;
			index += 1;
		}
		return index;
	}

	private parseNode(index: number, parentDepth: number): ParsedNode {
		const line = this.document.lines[index];
		if (line === undefined) {
			return { node: scalar(""), nextIndex: index };
		}

		const content = line.content.trimEnd();
		if (isSequenceIndicator(content)) {
			return this.parseSequence(index, line.indent, parentDepth);
		}
		if (content.startsWith("[") || content.startsWith("{")) {
			return this.parseInline(content, line, index, parentDepth);
		}
		if (mappingDelimiter(content) !== null) {
			return this.parseMapping(index, line.indent, parentDepth);
		}
		return this.parseInline(content, line, index, parentDepth);
	}

	private parseMapping(
		start: number,
		indent: number,
		parentDepth: number,
	): ParsedNode {
		const firstLine = this.document.lines[start];
		const entries = new Map<string, YamlBlockNode>();
		const node: YamlMapNode = { kind: "map", entries };
		if (firstLine === undefined) return { node, nextIndex: start };

		const depth = parentDepth + 1;
		if (!this.checkDepth(depth, firstLine.number)) {
			return { node, nextIndex: this.skipIndentedBlock(start + 1, indent) };
		}

		let index = start;
		while (true) {
			index = this.nextContent(index);
			const line = this.document.lines[index];
			if (line === undefined || line.indent < indent) break;
			if (line.indent > indent) {
				this.issues.push(yamlIssue("unexpected_indentation", line.number));
				index = this.skipIndentedBlock(index + 1, indent);
				continue;
			}
			if (isSequenceIndicator(line.content)) {
				this.issues.push(yamlIssue("unexpected_indentation", line.number));
				index += 1;
				continue;
			}

			const pair = this.parsePair(
				line.content,
				line,
				index,
				indent,
				depth,
				entries,
			);
			index = pair.nextIndex;
		}
		return { node, nextIndex: index };
	}

	private parseSequence(
		start: number,
		indent: number,
		parentDepth: number,
		initial?: InitialSequenceItem,
	): ParsedNode {
		const firstLine = initial?.line ?? this.document.lines[start];
		const items: YamlBlockNode[] = [];
		const node: YamlSequenceNode = { kind: "sequence", items };
		if (firstLine === undefined) return { node, nextIndex: start };

		const depth = parentDepth + 1;
		if (!this.checkDepth(depth, firstLine.number)) {
			return { node, nextIndex: this.skipIndentedBlock(start + 1, indent) };
		}

		let index = start;
		if (initial !== undefined) {
			const item = this.parseSequenceItem(
				initial.payload,
				initial.line,
				initial.lineIndex,
				indent,
				depth,
			);
			items.push(item.node);
			index = item.nextIndex;
		}

		while (true) {
			index = this.nextContent(index);
			const line = this.document.lines[index];
			if (line === undefined || line.indent < indent) break;
			if (line.indent > indent) {
				this.issues.push(yamlIssue("unexpected_indentation", line.number));
				index = this.skipIndentedBlock(index + 1, indent);
				continue;
			}
			if (!isSequenceIndicator(line.content)) break;

			const item = this.parseSequenceItem(
				afterSequenceIndicator(line.content),
				line,
				index,
				indent,
				depth,
			);
			items.push(item.node);
			index = item.nextIndex;
		}
		return { node, nextIndex: index };
	}

	private parseSequenceItem(
		payload: string,
		line: YamlLexedLine,
		lineIndex: number,
		sequenceIndent: number,
		sequenceDepth: number,
	): ParsedNode {
		const content = payload.trim();
		if (content.length === 0) {
			const childIndex = this.nextContent(lineIndex + 1);
			const childLine = this.document.lines[childIndex];
			if (childLine !== undefined && childLine.indent > sequenceIndent) {
				return this.parseNode(childIndex, sequenceDepth);
			}
			this.issues.push(yamlIssue("list_item_no_value", line.number));
			return { node: scalar(""), nextIndex: lineIndex + 1 };
		}

		if (isSequenceIndicator(content)) {
			return this.parseSequence(lineIndex, sequenceIndent + 2, sequenceDepth, {
				line,
				lineIndex,
				payload: afterSequenceIndicator(content),
			});
		}
		if (content.startsWith("[") || content.startsWith("{")) {
			return this.parseInline(content, line, lineIndex, sequenceDepth);
		}

		if (mappingDelimiter(content) !== null) {
			return this.parseInlineMapping(
				content,
				line,
				lineIndex,
				sequenceIndent + 2,
				sequenceDepth,
			);
		}

		return this.parseInline(content, line, lineIndex, sequenceDepth);
	}

	private parseInlineMapping(
		firstContent: string,
		firstLine: YamlLexedLine,
		firstLineIndex: number,
		indent: number,
		parentDepth: number,
	): ParsedNode {
		const entries = new Map<string, YamlBlockNode>();
		const node: YamlMapNode = { kind: "map", entries };
		const depth = parentDepth + 1;
		if (!this.checkDepth(depth, firstLine.number)) {
			return { node, nextIndex: firstLineIndex + 1 };
		}

		let index = this.parsePair(
			firstContent,
			firstLine,
			firstLineIndex,
			indent,
			depth,
			entries,
		).nextIndex;
		while (true) {
			index = this.nextContent(index);
			const line = this.document.lines[index];
			if (line === undefined || line.indent < indent) break;
			if (line.indent > indent) {
				this.issues.push(yamlIssue("unexpected_indentation", line.number));
				index = this.skipIndentedBlock(index + 1, indent);
				continue;
			}
			if (isSequenceIndicator(line.content)) {
				this.issues.push(yamlIssue("unexpected_indentation", line.number));
				index += 1;
				continue;
			}

			index = this.parsePair(
				line.content,
				line,
				index,
				indent,
				depth,
				entries,
			).nextIndex;
		}
		return { node, nextIndex: index };
	}

	private parsePair(
		content: string,
		line: YamlLexedLine,
		lineIndex: number,
		indent: number,
		mapDepth: number,
		entries: Map<string, YamlBlockNode>,
	): ParsedPair {
		const delimiter = mappingDelimiter(content);
		if (delimiter === null) {
			const key = decodeYamlScalar(content);
			this.issues.push(yamlIssue("mapping_key_no_value", line.number));
			if (!entries.has(key)) entries.set(key, scalar(""));
			return { nextIndex: lineIndex + 1 };
		}

		const key = decodeYamlScalar(content.slice(0, delimiter));
		if (entries.has(key)) {
			this.issues.push(yamlIssue("duplicate_key", line.number, { key }));
		}

		const rawValue = content.slice(delimiter + 1).trim();
		let parsedValue: ParsedNode;
		if (rawValue.length === 0) {
			const childIndex = this.nextContent(lineIndex + 1);
			const childLine = this.document.lines[childIndex];
			if (childLine !== undefined && childLine.indent > indent) {
				parsedValue = this.parseNode(childIndex, mapDepth);
			} else {
				if (
					childLine === undefined ||
					childLine.indent !== indent ||
					!isSequenceIndicator(childLine.content)
				) {
					this.issues.push(yamlIssue("mapping_key_no_value", line.number));
				}
				parsedValue = { node: scalar(""), nextIndex: lineIndex + 1 };
			}
		} else {
			parsedValue = this.parseInline(rawValue, line, lineIndex, mapDepth);
		}

		if (!entries.has(key)) entries.set(key, parsedValue.node);
		return { nextIndex: parsedValue.nextIndex };
	}

	private parseInline(
		raw: string,
		line: YamlLexedLine,
		lineIndex: number,
		parentDepth: number,
	): ParsedNode {
		const content = raw.trim();
		if (content.startsWith("[") || content.startsWith("{")) {
			return this.parseFlow(content, line, lineIndex, parentDepth);
		}
		return {
			node: scalar(decodeYamlScalar(content)),
			nextIndex: lineIndex + 1,
		};
	}

	private parseFlow(
		raw: string,
		line: YamlLexedLine,
		lineIndex: number,
		parentDepth: number,
	): ParsedNode {
		const parts = [raw];
		let nextIndex = lineIndex + 1;
		if (line.flowDepthEnd > 0) {
			while (nextIndex < this.document.lines.length) {
				const continuation = this.document.lines[nextIndex];
				if (continuation === undefined) break;
				parts.push(continuation.code);
				nextIndex += 1;
				if (continuation.flowDepthEnd === 0) break;
			}
		}

		const source = parts.join("\n");
		const openingOffset = line.code.lastIndexOf(raw);
		this.checkFlowDepth(source, parentDepth, line, Math.max(openingOffset, 0));
		return {
			node: {
				kind: "flow",
				source,
				line: line.number,
				column: Math.max(openingOffset, 0),
			},
			nextIndex,
		};
	}

	private checkFlowDepth(
		source: string,
		parentDepth: number,
		firstLine: YamlLexedLine,
		firstColumn: number,
	): void {
		const openings: Array<"[" | "{"> = [];
		let quote: "'" | '"' | null = null;
		let line = firstLine.number;
		let column = firstColumn;
		let reported = false;

		for (let index = 0; index < source.length; index += 1) {
			const character = source[index];
			if (character === "\n") {
				line += 1;
				column = 0;
				continue;
			}
			if (character === undefined) continue;

			if (quote === '"') {
				if (character === "\\") {
					index += 1;
					column += 1;
				} else if (character === '"') quote = null;
				column += 1;
				continue;
			}
			if (quote === "'") {
				if (character === "'" && source[index + 1] === "'") {
					index += 1;
					column += 1;
				} else if (character === "'") quote = null;
				column += 1;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				column += 1;
				continue;
			}

			if (character === "[" || character === "{") {
				openings.push(character);
				if (
					!reported &&
					parentDepth + openings.length > YAML_MAX_COLLECTION_DEPTH
				) {
					this.issues.push(yamlIssue("max_depth", line, {}, column));
					reported = true;
				}
			} else if (character === "]" || character === "}") {
				openings.pop();
			}
			column += 1;
		}
	}

	private checkDepth(depth: number, line: number): boolean {
		if (depth <= YAML_MAX_COLLECTION_DEPTH) return true;
		this.issues.push(yamlIssue("max_depth", line));
		return false;
	}
}

/**
 * Parse block maps and sequences from the lexical document. Flow collection
 * source is retained as a node for the packet 11 flow parser. Callers combine
 * these issues with `lexYaml` issues using `firstYamlIssue`.
 */
export function parseBlockYaml(
	document: YamlLexedDocument,
): YamlBlockParseResult {
	return new BlockParser(document).parse();
}
