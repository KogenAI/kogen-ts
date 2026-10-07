import {
	decodeYamlScalar,
	YAML_MAX_COLLECTION_DEPTH,
	type YamlBlockNode,
	type YamlFlowNode,
	type YamlMapNode,
	type YamlScalarNode,
	type YamlSequenceNode,
} from "./block";
import { type YamlIssue, yamlIssue } from "./preflight";

export interface YamlFlowParseResult {
	readonly node: YamlBlockNode | null;
	readonly issues: readonly YamlIssue[];
}

function scalar(value: string): YamlScalarNode {
	return { kind: "scalar", value };
}

function isSpace(character: string | undefined): boolean {
	return character === " " || character === "\n" || character === "\r";
}

class FlowParser {
	private cursor = 0;
	private readonly issues: YamlIssue[] = [];

	constructor(private readonly flow: YamlFlowNode) {}

	parse(): YamlFlowParseResult {
		this.skipSpace();
		const node = this.parseCollection(1);
		this.skipSpace();
		if (this.cursor < this.flow.source.length) {
			this.issue("trailing_flow", this.cursor);
		}
		return { node, issues: this.issues };
	}

	private parseCollection(depth: number): YamlBlockNode {
		const openingOffset = this.cursor;
		const opening = this.flow.source[this.cursor];
		if (opening !== "[" && opening !== "{") {
			this.issue("malformed_flow", this.cursor);
			return scalar("");
		}
		const closing = opening === "[" ? "]" : "}";
		this.cursor += 1;

		if (depth > YAML_MAX_COLLECTION_DEPTH) {
			this.issue("max_depth", openingOffset);
			this.skipCollection(opening, closing);
			return scalar("");
		}

		this.skipSpace();
		if (this.flow.source[this.cursor] === closing) {
			this.cursor += 1;
			return opening === "["
				? ({ kind: "sequence", items: [] } satisfies YamlSequenceNode)
				: ({ kind: "map", entries: new Map() } satisfies YamlMapNode);
		}

		return opening === "["
			? this.parseSequence(closing, depth, openingOffset)
			: this.parseMap(closing, depth, openingOffset);
	}

	private parseSequence(
		closing: "]" | "}",
		depth: number,
		openingOffset: number,
	): YamlSequenceNode {
		const items: YamlBlockNode[] = [];
		while (this.cursor < this.flow.source.length) {
			this.skipSpace();
			const current = this.flow.source[this.cursor];
			if (current === closing) {
				this.cursor += 1;
				return { kind: "sequence", items };
			}
			if (current === "}" || current === "]") {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				return { kind: "sequence", items };
			}
			if (current === ",") {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				this.skipSpace();
				if (this.flow.source[this.cursor] === closing) {
					this.cursor += 1;
					return { kind: "sequence", items };
				}
				continue;
			}

			const before = this.cursor;
			items.push(this.parseValue(depth));
			this.skipSpace();
			if (this.flow.source[this.cursor] === ",") {
				this.cursor += 1;
				this.skipSpace();
				if (this.flow.source[this.cursor] === closing) {
					this.cursor += 1;
					return { kind: "sequence", items };
				}
				continue;
			}
			if (this.flow.source[this.cursor] === closing) {
				this.cursor += 1;
				return { kind: "sequence", items };
			}
			if (
				this.flow.source[this.cursor] === "}" ||
				this.flow.source[this.cursor] === "]"
			) {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				return { kind: "sequence", items };
			}
			if (this.cursor >= this.flow.source.length) {
				this.issue("unterminated_flow", openingOffset);
				return { kind: "sequence", items };
			}
			if (this.cursor === before) this.cursor += 1;
			this.issue("malformed_flow", this.cursor);
			return { kind: "sequence", items };
		}

		this.issue("unterminated_flow", openingOffset);
		return { kind: "sequence", items };
	}

	private parseMap(
		closing: "]" | "}",
		depth: number,
		openingOffset: number,
	): YamlMapNode {
		const entries = new Map<string, YamlBlockNode>();
		while (this.cursor < this.flow.source.length) {
			this.skipSpace();
			const current = this.flow.source[this.cursor];
			if (current === closing) {
				this.cursor += 1;
				return { kind: "map", entries };
			}
			if (current === "}" || current === "]") {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				return { kind: "map", entries };
			}
			if (current === ",") {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				this.skipSpace();
				if (this.flow.source[this.cursor] === closing) {
					this.cursor += 1;
					return { kind: "map", entries };
				}
				continue;
			}

			const keyOffset = this.cursor;
			const key = this.parseMapKey();
			if (key === null) {
				this.issue("mapping_key_no_value", keyOffset);
				if (this.cursor >= this.flow.source.length) {
					this.issue("unterminated_flow", openingOffset);
				}
				return { kind: "map", entries };
			}
			this.skipSpace();
			if (this.flow.source[this.cursor] !== ":") {
				const separator = this.flow.source[this.cursor];
				if (separator === ",") this.issue("malformed_flow", this.cursor);
				else if (separator === "]") this.issue("malformed_flow", this.cursor);
				else {
					this.issue("mapping_key_no_value", keyOffset);
					if (separator === undefined)
						this.issue("unterminated_flow", openingOffset);
				}
				return { kind: "map", entries };
			}
			this.cursor += 1;
			this.skipSpace();

			let value: YamlBlockNode;
			const next = this.flow.source[this.cursor];
			if (next === "," || next === closing || next === undefined) {
				this.issue("mapping_key_no_value", keyOffset);
				value = scalar("");
			} else if (next === "]") {
				this.issue("malformed_flow", this.cursor);
				value = scalar("");
			} else {
				value = this.parseValue(depth);
			}
			if (entries.has(key)) {
				this.issue("duplicate_key", keyOffset, { key });
			} else {
				entries.set(key, value);
			}

			this.skipSpace();
			if (this.flow.source[this.cursor] === ",") {
				this.cursor += 1;
				this.skipSpace();
				if (this.flow.source[this.cursor] === closing) {
					this.cursor += 1;
					return { kind: "map", entries };
				}
				continue;
			}
			if (this.flow.source[this.cursor] === closing) {
				this.cursor += 1;
				return { kind: "map", entries };
			}
			if (
				this.flow.source[this.cursor] === "}" ||
				this.flow.source[this.cursor] === "]"
			) {
				this.issue("malformed_flow", this.cursor);
				this.cursor += 1;
				return { kind: "map", entries };
			}
			if (this.cursor >= this.flow.source.length) {
				this.issue("unterminated_flow", openingOffset);
				return { kind: "map", entries };
			}
			this.issue("malformed_flow", this.cursor);
			return { kind: "map", entries };
		}

		this.issue("unterminated_flow", openingOffset);
		return { kind: "map", entries };
	}

	private parseValue(depth: number): YamlBlockNode {
		this.skipSpace();
		const start = this.cursor;
		const current = this.flow.source[this.cursor];
		if (current === "[" || current === "{") {
			return this.parseCollection(depth + 1);
		}
		if (current === "'" || current === '"') {
			return this.parseQuotedScalar(current);
		}
		if (
			current === "]" ||
			current === "}" ||
			current === "," ||
			current === undefined
		) {
			this.issue("list_item_no_value", start);
			if (current !== undefined) this.cursor += 1;
			return scalar("");
		}

		const raw = this.readPlainScalar(false);
		if (raw.length === 0) {
			this.issue("list_item_no_value", start);
			return scalar("");
		}
		const colonOffset = raw.search(/:\s/u);
		if (colonOffset >= 0) {
			this.issue("colon_space", start + colonOffset, { value: foldPlain(raw) });
		}
		if (/^-\s/u.test(raw)) this.issue("list_in_value", start);
		return scalar(foldPlain(raw));
	}

	private parseMapKey(): string | null {
		this.skipSpace();
		const current = this.flow.source[this.cursor];
		if (current === "'" || current === '"') {
			return this.parseQuotedScalar(current).value;
		}
		if (
			current === "[" ||
			current === "{" ||
			current === "," ||
			current === "}" ||
			current === "]" ||
			current === undefined
		) {
			return null;
		}

		const start = this.cursor;
		const raw = this.readPlainScalar(true);
		if (raw.length === 0) return null;
		const colonOffset = raw.search(/:\s/u);
		if (colonOffset >= 0) {
			this.issue("colon_space", start + colonOffset, { value: foldPlain(raw) });
		}
		return foldPlain(raw);
	}

	private parseQuotedScalar(quote: "'" | '"'): YamlScalarNode {
		const start = this.cursor;
		this.cursor += 1;
		while (this.cursor < this.flow.source.length) {
			const character = this.flow.source[this.cursor];
			if (quote === '"' && character === "\\") {
				this.cursor += 2;
				continue;
			}
			if (
				quote === "'" &&
				character === "'" &&
				this.flow.source[this.cursor + 1] === "'"
			) {
				this.cursor += 2;
				continue;
			}
			if (character === quote) {
				this.cursor += 1;
				return scalar(
					decodeYamlScalar(this.flow.source.slice(start, this.cursor)),
				);
			}
			this.cursor += 1;
		}
		this.issue("unterminated_quote", start);
		return scalar(decodeYamlScalar(this.flow.source.slice(start)));
	}

	private readPlainScalar(mapKey: boolean): string {
		const start = this.cursor;
		while (this.cursor < this.flow.source.length) {
			const character = this.flow.source[this.cursor];
			if (
				character === "," ||
				character === "[" ||
				character === "{" ||
				character === "]" ||
				character === "}"
			)
				break;
			if (mapKey && character === ":") break;
			this.cursor += 1;
		}
		return this.flow.source.slice(start, this.cursor).trim();
	}

	private skipSpace(): void {
		while (isSpace(this.flow.source[this.cursor])) this.cursor += 1;
	}

	private skipCollection(opening: "[" | "{", closing: "]" | "}"): void {
		const openings: Array<"[" | "{"> = [opening];
		let quote: "'" | '"' | null = null;
		while (this.cursor < this.flow.source.length && openings.length > 0) {
			const character = this.flow.source[this.cursor];
			if (quote === '"') {
				if (character === "\\") this.cursor += 2;
				else {
					if (character === '"') quote = null;
					this.cursor += 1;
				}
				continue;
			}
			if (quote === "'") {
				if (character === "'" && this.flow.source[this.cursor + 1] === "'")
					this.cursor += 2;
				else {
					if (character === "'") quote = null;
					this.cursor += 1;
				}
				continue;
			}
			if (character === '"' || character === "'") quote = character;
			else if (character === "[" || character === "{") openings.push(character);
			else if (character === "]" || character === "}") openings.pop();
			this.cursor += 1;
		}
		if (openings.length > 0) this.issue("unterminated_flow", this.cursor - 1);
		void closing;
	}

	private issue(
		code: Parameters<typeof yamlIssue>[0],
		offset: number,
		details: Parameters<typeof yamlIssue>[2] = {},
	): void {
		let line = this.flow.line;
		let column = this.flow.column;
		for (let index = 0; index < offset; index += 1) {
			if (this.flow.source[index] === "\n") {
				line += 1;
				column = 0;
			} else {
				column += 1;
			}
		}
		const issueDetails =
			code === "malformed_flow" && details.text === undefined
				? {
						...details,
						text:
							this.flow.source.slice(offset).trim() || this.flow.source.trim(),
					}
				: details;
		this.issues.push(yamlIssue(code, line, issueDetails, column));
	}
}

function foldPlain(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Parse the restricted flow collection syntax stored by the block parser. */
export function parseFlowYaml(flow: YamlFlowNode): YamlFlowParseResult {
	return new FlowParser(flow).parse();
}

/** Resolve flow nodes nested inside block maps and sequences. */
export function resolveYamlFlowNodes(root: YamlBlockNode | null): {
	readonly node: YamlBlockNode | null;
	readonly issues: readonly YamlIssue[];
} {
	const issues: YamlIssue[] = [];
	const visit = (node: YamlBlockNode): YamlBlockNode => {
		switch (node.kind) {
			case "scalar":
				return node;
			case "flow": {
				const parsed = parseFlowYaml(node);
				issues.push(...parsed.issues);
				return parsed.node ?? node;
			}
			case "map": {
				const entries = new Map<string, YamlBlockNode>();
				for (const [key, value] of node.entries) entries.set(key, visit(value));
				return { kind: "map", entries };
			}
			case "sequence":
				return { kind: "sequence", items: node.items.map(visit) };
		}
	};
	return { node: root === null ? null : visit(root), issues };
}
