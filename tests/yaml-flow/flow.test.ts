import { expect, test } from "bun:test";
import { parseYaml } from "../../packages/core/src/yaml/parse";

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

function materialize(
	node: NonNullable<ReturnType<typeof parseYaml>["node"]>,
): unknown {
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

function map(value: unknown): Map<string, unknown> {
	expect(value).toBeInstanceOf(Map);
	return value as Map<string, unknown>;
}

function parsedNode(result: ReturnType<typeof parseYaml>) {
	if (result.node === null) throw new Error("expected YAML node");
	return result.node;
}

test("parser facade resolves nested multiline flow maps and lists", () => {
	const result = parseYaml(
		encode(`name: service
settings: {
  defaults: {retry: 3, enabled: false},
  regions: [east, west],
  matrix: [
    [one, two],
    [three, four],
  ],
}
`),
	);

	expect(result.issue).toBeNull();
	const root = map(materialize(parsedNode(result)));
	const settings = map(root.get("settings"));
	expect(settings.get("defaults")).toEqual(
		new Map([
			["retry", "3"],
			["enabled", "false"],
		]),
	);
	expect(settings.get("regions")).toEqual(["east", "west"]);
	expect(settings.get("matrix")).toEqual([
		["one", "two"],
		["three", "four"],
	]);
});

test("quoted commas, brackets, hashes, escapes, and comments keep their boundaries", () => {
	const result = parseYaml(
		encode(String.raw`items: ["a, #[x]", 'it''s, [safe]', plain#suffix, value] # tail comment
map: {quoted: "line\nnext", unquoted: hash#part} # another comment
`),
	);

	expect(result.issue).toBeNull();
	const root = map(materialize(parsedNode(result)));
	expect(root.get("items")).toEqual([
		"a, #[x]",
		"it's, [safe]",
		"plain#suffix",
		"value",
	]);
	expect(root.get("map")).toEqual(
		new Map([
			["quoted", "line\nnext"],
			["unquoted", "hash#part"],
		]),
	);
});

test("flow comments can separate multiline entries without consuming quoted hashes", () => {
	const result = parseYaml(
		encode(`items: [
  first, # after a space starts a comment
  "second # is data", # and this is a comment
  third
]
`),
	);

	expect(result.issue).toBeNull();
	expect(materialize(parsedNode(result))).toEqual(
		new Map([["items", ["first", "second # is data", "third"]]]),
	);
});

test("multiline flow collections parse inside block sequence mapping items", () => {
	const result = parseYaml(
		encode(`regions:
  - name: east
    labels: {
      zone: primary,
      colors: [blue, green]
    }
  - name: west
    labels: {zone: secondary}
`),
	);

	expect(result.issue).toBeNull();
	expect(materialize(parsedNode(result))).toEqual(
		new Map([
			[
				"regions",
				[
					new Map<string, unknown>([
						["name", "east"],
						[
							"labels",
							new Map<string, unknown>([
								["zone", "primary"],
								["colors", ["blue", "green"]],
							]),
						],
					]),
					new Map<string, unknown>([
						["name", "west"],
						["labels", new Map([["zone", "secondary"]])],
					]),
				],
			],
		]),
	);
});

test("flow maps detect decoded duplicate keys and missing values", () => {
	const duplicate = parseYaml(encode(`value: {name: first, "name": second}\n`));
	expect(duplicate.issue).toMatchObject({ code: "duplicate_key", line: 1 });

	const missing = parseYaml(encode(`value: {name:}\n`));
	expect(missing.issue).toMatchObject({
		code: "mapping_key_no_value",
		line: 1,
	});
});

test.each([
	["malformed", `value: [one,, two]\n`, "malformed_flow", 1],
	["empty flow slot", `value: [one, , two]\n`, "malformed_flow", 1],
	["unterminated multiline", `value: [one,\n  two\n`, "unterminated_flow", 1],
	["trailing text", `value: [one] extra\n`, "trailing_flow", 1],
	["mismatched closer", `value: {one: [two}]\n`, "malformed_flow", 1],
	["mismatched map key closer", `value: {one]}\n`, "malformed_flow", 1],
	["mismatched map value closer", `value: {one: ]}\n`, "malformed_flow", 1],
	["unterminated map", `value: {one: two\n`, "unterminated_flow", 1],
	["plain colon-space", `value: [one: two]\n`, "colon_space", 1],
])("flow parser rejects %s", (_name, source, code, line) => {
	const result = parseYaml(encode(source as string));
	expect(result.issue).toMatchObject({ code, line });
});

test("the facade selects the earliest source error across lexical, block, and flow passes", () => {
	const earlyFlow = parseYaml(encode(`root: [one,, two]\nlater: {bad:}\n`));
	expect(earlyFlow.issue).toMatchObject({ code: "malformed_flow", line: 1 });

	const earlyLexical = parseYaml(encode(`root: [one]\nbad: &anchor value\n`));
	expect(earlyLexical.issue).toMatchObject({
		code: "anchors_aliases_or_tags",
		line: 2,
	});

	const sameLine = parseYaml(
		encode(`value: ${"[".repeat(64)}x${"]".repeat(64)},,\n`),
	);
	expect(sameLine.issue).toMatchObject({ code: "max_depth", line: 1 });
});

test("the parser keeps strings untyped and empty flow collections distinct", () => {
	const result = parseYaml(
		encode(`values: [null, true, 12, ""]\nempty: {}\nlist: []\n`),
	);
	expect(result.issue).toBeNull();
	const root = map(materialize(parsedNode(result)));
	expect(root.get("values")).toEqual(["null", "true", "12", ""]);
	expect(root.get("empty")).toEqual(new Map());
	expect(root.get("list")).toEqual([]);
});

test("a forbidden tab in a child does not invent a missing value on its parent", () => {
	const result = parseYaml(encode("name: kt\nchecks:\n\t- name: x\n"));
	expect(result.issue).toMatchObject({ code: "tab_character", line: 3 });
	const earlierError = parseYaml(
		encode("name: [one,, two]\nchecks:\n\t- name: x\n"),
	);
	expect(earlierError.issue).toMatchObject({ code: "malformed_flow", line: 1 });
});
