import { expect, test } from "bun:test";
import {
	parseBlockYaml,
	type YamlBlockNode,
	type YamlMapNode,
} from "../../packages/core/src/yaml/block";
import {
	firstLexicalYamlIssue,
	lexYaml,
} from "../../packages/core/src/yaml/lex";
import { firstYamlIssue } from "../../packages/core/src/yaml/preflight";

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

function materialize(node: YamlBlockNode): unknown {
	switch (node.kind) {
		case "scalar":
			return node.value;
		case "map":
			return new Map(
				[...node.entries].map(([key, value]) => [key, materialize(value)]),
			);
		case "sequence":
			return node.items.map(materialize);
		case "flow":
			return { flow: node.source };
	}
}

function parse(source: string) {
	const lexical = lexYaml(encode(source));
	const block =
		lexical.document === null ? null : parseBlockYaml(lexical.document);
	const issue = firstYamlIssue([...lexical.issues, ...(block?.issues ?? [])]);
	return { lexical, block, issue };
}

function yamlMap(value: unknown): Map<string, unknown> {
	expect(value).toBeInstanceOf(Map);
	return value as Map<string, unknown>;
}

test("block maps keep every plain scalar as a string and decode quoted scalars", () => {
	const result = parse(
		String.raw`name: kogen
number: 42
enabled: false
double: "line\nslash\\forward\/quote\""
single: 'it''s valid'
empty: ""
`,
	);

	expect(result.issue).toBeNull();
	expect(materialize(result.block?.node as YamlBlockNode)).toEqual(
		new Map([
			["name", "kogen"],
			["number", "42"],
			["enabled", "false"],
			["double", 'line\nslash\\forward/quote"'],
			["single", "it's valid"],
			["empty", ""],
		]),
	);
});

test("deeper block sequences support mapping items and nested lists", () => {
	const result = parse(`checks:
  - name: compile
    command:
      - bun
      - test
  - name: lint
    command:
      - bun
      - check
matrix:
  - - first
    - second
  - - third
    - fourth
`);

	expect(result.issue).toBeNull();
	const root = yamlMap(materialize(result.block?.node as YamlBlockNode));
	expect(root.get("checks")).toEqual([
		new Map<string, unknown>([
			["name", "compile"],
			["command", ["bun", "test"]],
		]),
		new Map<string, unknown>([
			["name", "lint"],
			["command", ["bun", "check"]],
		]),
	]);
	expect(root.get("matrix")).toEqual([
		["first", "second"],
		["third", "fourth"],
	]);
});

test("an empty block value can contain a deeper map, sequence, or scalar", () => {
	const result = parse(`chatgpt:
  default: local
  projects:
    - path: /repo
      account: local
fallback:
  plain scalar
`);

	expect(result.issue).toBeNull();
	const root = yamlMap(materialize(result.block?.node as YamlBlockNode));
	const chatgpt = yamlMap(root.get("chatgpt"));
	expect(chatgpt.get("default")).toBe("local");
	expect(chatgpt.get("projects")).toEqual([
		new Map([
			["path", "/repo"],
			["account", "local"],
		]),
	]);
	expect(root.get("fallback")).toBe("plain scalar");

	const emptyItem = parse(`items:
  -
    nested: value
`);
	expect(emptyItem.issue).toBeNull();
	expect(materialize(emptyItem.block?.node as YamlBlockNode)).toEqual(
		new Map([["items", [new Map([["nested", "value"]])]]]),
	);
});

test("empty flow values remain flow nodes for the next parser layer", () => {
	const result = parse(`empty_map: {}
empty_list: []
items:
  - {name: item}
`);

	expect(result.issue).toBeNull();
	const root = result.block?.node as YamlMapNode;
	expect(root.entries.get("empty_map")).toMatchObject({
		kind: "flow",
		source: "{}",
	});
	expect(root.entries.get("empty_list")).toMatchObject({
		kind: "flow",
		source: "[]",
	});
	const items = root.entries.get("items");
	expect(items?.kind).toBe("sequence");
	if (items?.kind !== "sequence") return;
	expect(items.items[0]).toMatchObject({
		kind: "flow",
		source: "{name: item}",
	});
});

test("decoded map keys detect duplicates in the same map but not another scope", () => {
	const result = parse(`name: first
"name": second
nested:
  name: local
`);

	expect(result.issue).toMatchObject({
		code: "duplicate_key",
		line: 2,
		message: 'duplicate key "name"',
	});
	expect(result.block?.issues).toHaveLength(1);
});

test("merge keys retain the earlier lexical diagnostic when combined", () => {
	const result = parse(`mapping:
  <<: {base: main}
`);

	expect(firstLexicalYamlIssue(result.lexical)).toMatchObject({
		code: "merge_key",
		line: 2,
	});
	expect(result.issue?.code).toBe("merge_key");
});

test.each([
	["key without a value", "name:\n", "mapping_key_no_value", 1],
	["list item without a value", "items:\n  -\n", "list_item_no_value", 2],
	[
		"unexpected root indentation",
		"  name: kogen\n",
		"unexpected_indentation",
		1,
	],
	[
		"indentation after a scalar value",
		"name: kogen\n  extra: value\n",
		"unexpected_indentation",
		2,
	],
	["indentless sequence", "items:\n- value\n", "unexpected_indentation", 2],
])("block structure rejects %s", (_name, source, code, line) => {
	const result = parse(source as string);
	expect(result.issue).toMatchObject({ code, line });
});

function nestedMaps(levels: number): string {
	const lines: string[] = [];
	for (let index = 0; index < levels; index += 1) {
		const indent = " ".repeat(index * 2);
		lines.push(
			`${indent}level_${index}:${index === levels - 1 ? " leaf" : ""}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

test("block nesting allows 64 collections and rejects the 65th", () => {
	expect(parse(nestedMaps(64)).issue).toBeNull();
	expect(parse(nestedMaps(65)).issue).toMatchObject({
		code: "max_depth",
		line: 65,
		message: "maximum nesting depth of 64 collections exceeded",
	});
});

test("flow nesting counts collections already opened by block ancestors", () => {
	const withinLimit = parse(`root: ${"[".repeat(63)}x${"]".repeat(63)}\n`);
	const overLimit = parse(`root: ${"[".repeat(64)}x${"]".repeat(64)}\n`);
	expect(withinLimit.issue).toBeNull();
	expect(overLimit.issue).toMatchObject({ code: "max_depth", line: 1 });
});
