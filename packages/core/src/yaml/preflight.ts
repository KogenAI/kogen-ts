export const YAML_MAX_BYTES = 1_048_576;

export const YAML_ERROR_PRECEDENCE = [
	"document_too_large",
	"leading_bom",
	"invalid_utf8",
	"tab_character",
	"directives_or_markers",
	"block_scalar",
	"anchors_aliases_or_tags",
	"max_depth",
	"merge_key",
	"unicode_escape",
	"unsupported_escape",
	"unterminated_quote",
	"text_after_quote",
	"flow_brackets",
	"malformed_flow",
	"unterminated_flow",
	"trailing_flow",
	"colon_space",
	"list_in_value",
	"unexpected_indentation",
	"duplicate_key",
	"mapping_key_no_value",
	"list_item_no_value",
	"empty_document",
] as const;

export type YamlErrorCode = (typeof YAML_ERROR_PRECEDENCE)[number];

export interface YamlIssue {
	readonly code: YamlErrorCode;
	readonly message: string;
	readonly line?: number;
	readonly offset?: number;
}

export interface YamlIssueDetails {
	readonly character?: string;
	readonly key?: string;
	readonly text?: string;
	readonly value?: string;
}

export interface YamlSourceLine {
	readonly number: number;
	readonly text: string;
}

export interface YamlSourceDocument {
	readonly source: string;
	readonly lines: readonly YamlSourceLine[];
}

export interface YamlPreflight {
	readonly document: YamlSourceDocument | null;
	readonly issues: readonly YamlIssue[];
}

export function yamlIssue(
	code: YamlErrorCode,
	line?: number,
	details: YamlIssueDetails = {},
	offset?: number,
): YamlIssue {
	let message: string;
	switch (code) {
		case "document_too_large":
			message = "document exceeds the maximum size of 1048576 bytes";
			break;
		case "leading_bom":
			message = "leading UTF-8 BOM is not allowed";
			break;
		case "invalid_utf8":
			message = "document is not valid UTF-8";
			break;
		case "tab_character":
			message = "tab character: indent with spaces";
			break;
		case "directives_or_markers":
			message = "directives and document markers are not allowed";
			break;
		case "block_scalar":
			message = "anchors, aliases, tags, and block scalars are not allowed";
			break;
		case "anchors_aliases_or_tags":
			message = "anchors, aliases, and tags are not allowed";
			break;
		case "max_depth":
			message = "maximum nesting depth of 64 collections exceeded";
			break;
		case "merge_key":
			message = "YAML merge key `<<` is not allowed";
			break;
		case "unicode_escape":
			message = "Unicode escape \\u is not supported";
			break;
		case "unsupported_escape":
			message = `unsupported escape \\${details.character ?? ""}`;
			break;
		case "unterminated_quote":
			message = "unterminated quoted string";
			break;
		case "text_after_quote":
			message = "text after closing quote";
			break;
		case "flow_brackets":
			message = `quote "${details.value ?? ""}": brackets inside a flow collection`;
			break;
		case "malformed_flow":
			message = `malformed flow collection near ${details.text ?? ""}`;
			break;
		case "unterminated_flow":
			message = "unterminated flow collection";
			break;
		case "trailing_flow":
			message = "trailing text after flow collection";
			break;
		case "colon_space":
			message = `unquoted \`: \` inside a value: "${details.value ?? ""}"`;
			break;
		case "list_in_value":
			message = "list item in a value position";
			break;
		case "unexpected_indentation":
			message = "unexpected indentation";
			break;
		case "duplicate_key":
			message = `duplicate key "${details.key ?? ""}"`;
			break;
		case "mapping_key_no_value":
			message = "mapping key has no value";
			break;
		case "list_item_no_value":
			message = "list item has no value";
			break;
		case "empty_document":
			message = "empty document";
	}

	return {
		code,
		message,
		...(line === undefined ? {} : { line }),
		...(offset === undefined ? {} : { offset }),
	};
}

export function compareYamlIssues(left: YamlIssue, right: YamlIssue): number {
	if (left.code === "document_too_large")
		return right.code === left.code ? 0 : -1;
	if (right.code === "document_too_large") return 1;
	const leftLine = left.line ?? Number.POSITIVE_INFINITY;
	const rightLine = right.line ?? Number.POSITIVE_INFINITY;
	if (leftLine !== rightLine) return leftLine - rightLine;
	const leftPriority = YAML_ERROR_PRECEDENCE.indexOf(left.code);
	const rightPriority = YAML_ERROR_PRECEDENCE.indexOf(right.code);
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return (
		(left.offset ?? Number.POSITIVE_INFINITY) -
		(right.offset ?? Number.POSITIVE_INFINITY)
	);
}

export function orderYamlIssues(issues: readonly YamlIssue[]): YamlIssue[] {
	return [...issues].sort(compareYamlIssues);
}

export function firstYamlIssue(issues: readonly YamlIssue[]): YamlIssue | null {
	return orderYamlIssues(issues)[0] ?? null;
}

function firstInvalidUtf8Offset(bytes: Uint8Array): number | null {
	for (let offset = 0; offset < bytes.length; ) {
		const first = bytes[offset];
		if (first === undefined) return null;
		if (first <= 0x7f) {
			offset += 1;
			continue;
		}

		let length: number;
		if (first >= 0xc2 && first <= 0xdf) length = 2;
		else if (first >= 0xe0 && first <= 0xef) length = 3;
		else if (first >= 0xf0 && first <= 0xf4) length = 4;
		else return offset;

		if (offset + length > bytes.length) return offset;
		const second = bytes[offset + 1];
		if (second === undefined || second < 0x80 || second > 0xbf) return offset;
		if (first === 0xe0 && second < 0xa0) return offset;
		if (first === 0xed && second > 0x9f) return offset;
		if (first === 0xf0 && second < 0x90) return offset;
		if (first === 0xf4 && second > 0x8f) return offset;
		for (let continuation = 2; continuation < length; continuation += 1) {
			const byte = bytes[offset + continuation];
			if (byte === undefined || byte < 0x80 || byte > 0xbf) return offset;
		}
		offset += length;
	}
	return null;
}

function lineAtByteOffset(bytes: Uint8Array, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		const byte = bytes[index];
		if (byte === 0x0d) {
			line += 1;
			if (bytes[index + 1] === 0x0a && index + 1 < offset) index += 1;
		} else if (byte === 0x0a) {
			line += 1;
		}
	}
	return line;
}

function splitLines(source: string): YamlSourceLine[] {
	const lines: YamlSourceLine[] = [];
	let start = 0;
	let number = 1;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character !== "\r" && character !== "\n") continue;
		lines.push({ number, text: source.slice(start, index) });
		if (character === "\r" && source[index + 1] === "\n") index += 1;
		start = index + 1;
		number += 1;
	}
	lines.push({ number, text: source.slice(start) });
	return lines;
}

export function preflightYaml(input: Uint8Array): YamlPreflight {
	if (input.byteLength > YAML_MAX_BYTES) {
		return {
			document: null,
			issues: [yamlIssue("document_too_large")],
		};
	}

	const issues: YamlIssue[] = [];
	if (
		input.byteLength >= 3 &&
		input[0] === 0xef &&
		input[1] === 0xbb &&
		input[2] === 0xbf
	) {
		issues.push(yamlIssue("leading_bom", 1, {}, 0));
	}

	const invalidOffset = firstInvalidUtf8Offset(input);
	if (invalidOffset !== null) {
		issues.push(
			yamlIssue(
				"invalid_utf8",
				lineAtByteOffset(input, invalidOffset),
				{},
				invalidOffset,
			),
		);
	}

	for (let offset = 0; offset < input.byteLength; offset += 1) {
		if (input[offset] === 0x09) {
			issues.push(
				yamlIssue("tab_character", lineAtByteOffset(input, offset), {}, offset),
			);
			break;
		}
	}

	const source = new TextDecoder("utf-8", {
		fatal: false,
		ignoreBOM: true,
	}).decode(input);
	return {
		document: { source, lines: splitLines(source) },
		issues: orderYamlIssues(issues),
	};
}
