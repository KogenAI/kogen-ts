import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	firstLexicalYamlIssue,
	lexYaml,
} from "../../packages/core/src/yaml/lex";
import {
	firstYamlIssue,
	preflightYaml,
	YAML_ERROR_PRECEDENCE,
	YAML_MAX_BYTES,
	yamlIssue,
} from "../../packages/core/src/yaml/preflight";

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

function lexicalIssue(input: string | Uint8Array) {
	const result = lexYaml(typeof input === "string" ? encode(input) : input);
	return firstLexicalYamlIssue(result);
}

function appendInvalidByte(source: string, byte = 0xff): Uint8Array {
	const prefix = encode(source);
	const input = new Uint8Array(prefix.length + 1);
	input.set(prefix);
	input[prefix.length] = byte;
	return input;
}

test("preflight caps UTF-8 bytes at the exact 1 MiB boundary", () => {
	const ascii = new Uint8Array(YAML_MAX_BYTES).fill(0x78);
	const exact = preflightYaml(ascii);
	expect(exact.document?.source.length).toBe(YAML_MAX_BYTES);
	expect(exact.issues).toEqual([]);

	const multiByte = encode("é".repeat(YAML_MAX_BYTES / 2));
	expect(multiByte.byteLength).toBe(YAML_MAX_BYTES);
	expect(preflightYaml(multiByte).document).not.toBeNull();

	const tooLarge = new Uint8Array(YAML_MAX_BYTES + 1).fill(0x78);
	const result = lexYaml(tooLarge);
	expect(result.document).toBeNull();
	expect(result.issues).toEqual([yamlIssue("document_too_large")]);
});

test("oversize takes the first normative error before BOM or invalid UTF-8", () => {
	const input = new Uint8Array(YAML_MAX_BYTES + 1);
	input.set([0xef, 0xbb, 0xbf, 0xff]);
	expect(lexYaml(input).issues[0]?.code).toBe("document_too_large");
});

test("byte-level errors retain their source line and line ordering", () => {
	expect(
		lexicalIssue(appendInvalidByte("name: kt\nchecks: []\nbase: ")),
	).toMatchObject({
		code: "invalid_utf8",
		line: 3,
		message: "document is not valid UTF-8",
	});
	expect(
		lexicalIssue("name: kt\nchecks: []\nbase:\n\t- name: x\n"),
	).toMatchObject({
		code: "tab_character",
		line: 4,
	});
	expect(lexicalIssue("\uFEFFname: kt\n")).toMatchObject({
		code: "leading_bom",
		line: 1,
	});

	const earlierQuote = appendInvalidByte('name: "open\nchecks: []\nbase: ');
	expect(lexicalIssue(earlierQuote)).toMatchObject({
		code: "unterminated_quote",
		line: 1,
	});
});

test("preflight errors on one line use normative yaml-errors precedence", () => {
	const sameLine = encode('name: "\\u1234\t"');
	expect(lexicalIssue(sameLine)).toMatchObject({
		code: "tab_character",
		line: 1,
	});
});

test("comments are recognized outside quotes at line start or after a space", () => {
	const result = lexYaml(
		encode(
			[
				'name: "hash # inside quoted text" # trailing comment',
				"single: 'it''s # still quoted' # trailing comment",
				"plain: value#suffix",
				"# comment with --- and &anchor",
			].join("\n"),
		),
	);

	expect(result.issues).toEqual([]);
	expect(result.document?.lines.map((line) => line.code)).toEqual([
		'name: "hash # inside quoted text" ',
		"single: 'it''s # still quoted' ",
		"plain: value#suffix",
		"",
	]);
});

test("quoted scalars accept only the documented escapes and single-quote doubling", () => {
	const valid = encode(
		String.raw`name: "slash\/ back\\ quote\" newline\n tab\t"`,
	);
	const single = encode("name: 'it''s valid'\n");
	expect(lexicalIssue(valid)).toBeNull();
	expect(lexicalIssue(single)).toBeNull();

	expect(lexicalIssue(String.raw`name: "bad\u1234"`)).toMatchObject({
		code: "unicode_escape",
		line: 1,
		message: "Unicode escape \\u is not supported",
	});
	expect(lexicalIssue(String.raw`name: "bad\x"`)).toMatchObject({
		code: "unsupported_escape",
		line: 1,
		message: "unsupported escape \\x",
	});
});

const lexicalCases = [
	[
		"directive",
		"%YAML 1.2\nname: kt\n",
		"directives_or_markers",
		1,
		"directives and document markers are not allowed",
	],
	[
		"document marker",
		"--- # no document markers\nname: kt\n",
		"directives_or_markers",
		1,
		"directives and document markers are not allowed",
	],
	[
		"block scalar",
		"name: kt\nbase: |\n  text\n",
		"block_scalar",
		2,
		"anchors, aliases, tags, and block scalars are not allowed",
	],
	[
		"anchor",
		"name: kt\nbase: &base main\n",
		"anchors_aliases_or_tags",
		2,
		"anchors, aliases, and tags are not allowed",
	],
	[
		"alias",
		"name: kt\nbase: *base\n",
		"anchors_aliases_or_tags",
		2,
		"anchors, aliases, and tags are not allowed",
	],
	[
		"tag",
		"name: kt\nbase: !custom main\n",
		"anchors_aliases_or_tags",
		2,
		"anchors, aliases, and tags are not allowed",
	],
	[
		"merge key",
		"name: kt\n<<: {base: main}\n",
		"merge_key",
		2,
		"YAML merge key `<<` is not allowed",
	],
	[
		"unterminated quote",
		'name: kt\nchecks: []\nbase: "main\n',
		"unterminated_quote",
		3,
		"unterminated quoted string",
	],
	[
		"text after quote",
		'name: kt\nbase: "main" text\n',
		"text_after_quote",
		2,
		"text after closing quote",
	],
	[
		"flow brackets in a plain scalar",
		"name: kt\nprotected_paths: [a[1]]\n",
		"flow_brackets",
		2,
		'quote "a[1]": brackets inside a flow collection',
	],
	[
		"plain colon-space",
		"name: kt\nbase: a: b\n",
		"colon_space",
		2,
		'unquoted `: ` inside a value: "a: b"',
	],
	[
		"list item in a value",
		"name: kt\nbase: - main\n",
		"list_in_value",
		2,
		"list item in a value position",
	],
	[
		"empty document",
		"# comments only\n  # still empty\n",
		"empty_document",
		undefined,
		"empty document",
	],
] as const;

for (const [name, source, code, line, message] of lexicalCases) {
	test(`normative lexical row: ${name}`, () => {
		const expected = { code, message, ...(line === undefined ? {} : { line }) };
		expect(lexicalIssue(source)).toMatchObject(expected);
	});
}

test("error message order matches the frozen normative yaml-errors table", () => {
	const root = join(import.meta.dir, "../..");
	const frozen = JSON.parse(
		readFileSync(
			join(root, "spec-lock/kogen-spec/spec/data/yaml-errors.json"),
			"utf8",
		),
	) as { errors: string[] };
	const detail = {
		character: "x",
		key: "sample",
		text: "rest",
		value: "sample",
	};
	const expected = frozen.errors.map((message) =>
		message
			.replaceAll("<c>", "x")
			.replaceAll("<k>", "sample")
			.replaceAll("<text>", "rest")
			.replaceAll("<v>", "sample"),
	);
	expect(YAML_ERROR_PRECEDENCE).toHaveLength(frozen.errors.length);
	expect(
		YAML_ERROR_PRECEDENCE.map((code) => yamlIssue(code, 1, detail).message),
	).toEqual(expected);

	const tie = firstYamlIssue([
		yamlIssue("list_item_no_value", 4),
		yamlIssue("tab_character", 4),
		yamlIssue("anchors_aliases_or_tags", 4),
	]);
	expect(tie?.code).toBe("tab_character");
});
