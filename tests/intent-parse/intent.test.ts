import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	hashApprovalBytes,
	hashIntentBytes,
} from "../../packages/core/src/intent/hash";
import {
	isValidIntentSlug,
	parseIntent,
} from "../../packages/core/src/intent/parse";

const encoder = new TextEncoder();
const fixturePath = join(
	import.meta.dir,
	"../../spec-lock/kogen-conformance/cases/state/state-04-intent-parse-errors.json",
);
const rawHashFixturePath = join(
	import.meta.dir,
	"../../spec-lock/kogen-conformance/cases/state/state-07-request-not-linted-raw-hash.json",
);

function source(text: string): Uint8Array {
	return encoder.encode(text);
}

function parseOrThrow(bytes: Uint8Array) {
	const result = parseIntent(bytes);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.intent;
}

function parseErrors(text: string) {
	const result = parseIntent(source(text));
	if (result.ok) throw new Error("expected rejected Intent");
	return result.errors;
}

test("accepts strict frontmatter defaults and leaves lint policy to its owner", () => {
	const parsed = parseOrThrow(
		source("---\ntitle: A title\nsize: medium\ndomains: [app]\n---\n"),
	);
	expect(parsed.frontmatter).toEqual({
		title: "A title",
		size: "medium",
		domains: ["app"],
		changesGate: false,
		limits: [],
		blocksOn: [],
		priority: 0,
		assumptions: [],
		sharedContracts: [],
	});
	expect(parsed.brief).toBe("");
	expect(parsed.acceptance).toEqual([]);
	expect(parsed.verify).toEqual([]);
});

test("parses every optional frontmatter field", () => {
	const parsed = parseOrThrow(
		source(
			[
				"---",
				"title: Predicate example",
				"size: small",
				"domains: [app]",
				"changes_gate: true",
				"limits: [keep the API stable]",
				"blocks_on: [feature-x]",
				"priority: -2",
				"assumptions: [{name: runtime, path: config/runtime.txt, contains: supported}]",
				"shared_contracts:",
				"  - {name: api, path: api.md, contains: stable endpoints}",
				"source: planning",
				"---",
				"",
			].join("\n"),
		),
	);
	expect(parsed.frontmatter).toEqual({
		title: "Predicate example",
		size: "small",
		domains: ["app"],
		changesGate: true,
		limits: ["keep the API stable"],
		blocksOn: ["feature-x"],
		priority: -2,
		assumptions: [
			{ name: "runtime", path: "config/runtime.txt", contains: "supported" },
		],
		sharedContracts: [
			{ name: "api", path: "api.md", contains: "stable endpoints" },
		],
		source: "planning",
	});
});

test("preserves CRLF and invalid UTF-8 Request bytes without decoding them", () => {
	const prefix = source(
		"---\r\ntitle: Keep bytes\r\nsize: small\r\ndomains: [app]\r\n---\r\nThis brief has a style phrase.\r\n\r\n## Acceptance\r\n- A1: Keep exact bytes.\r\n\r\n## Verify\r\n- A1: test keep integration domain=old after=A0 domain=app\r\n\r\n## Request\r\n",
	);
	const request = new Uint8Array([
		...source("Please keep this CRLF.\r\nAnd this raw suffix: "),
		0xff,
		0x00,
		0x0d,
		0x0a,
	]);
	const input = new Uint8Array(prefix.length + request.length);
	input.set(prefix);
	input.set(request, prefix.length);
	const parsed = parseOrThrow(input);

	expect(parsed.rawBytes).toEqual(input);
	expect(parsed.requestBytes).toEqual(request);
	expect(parsed.frontmatter.title).toBe("Keep bytes");
	expect(parsed.acceptance[0]?.text).toBe("Keep exact bytes.");
	expect(parsed.verify[0]).toMatchObject({
		id: "A1",
		kind: "test",
		keep: true,
		domain: "app",
	});
	expect(parsed.brief).toBe("This brief has a style phrase.");
});

test("accepts core Verify modifiers and retains the last domain", () => {
	const parsed = parseOrThrow(
		source(
			[
				"---",
				"title: Verify modifiers",
				"size: large",
				"domains: [app, docs]",
				"---",
				"Brief text.",
				"",
				"## Acceptance",
				"- A1: First item.",
				"- A2: Second item.",
				"",
				"## Verify",
				"- A1: test integration domain=app after=A0 domain=docs",
				"- A2: test keep after=A1 integration",
				"",
			].join("\n"),
		),
	);
	expect(parsed.verify).toEqual([
		{ id: "A1", kind: "test", keep: false, domain: "docs", line: 13 },
		{ id: "A2", kind: "test", keep: true, domain: null, line: 14 },
	]);
});

for (const [body, expected] of [
	["example", "example is not supported in core v1"],
	["check", "check is not supported in core v1"],
	["other", "invalid Verify entry"],
	["test custom", "invalid Verify entry"],
	["test domain=", "invalid Verify entry"],
	["test after=", "invalid Verify entry"],
] as const) {
	test(`rejects Verify body ${body}`, () => {
		const errors = parseErrors(
			"---\ntitle: Verify\nsize: small\ndomains: [app]\n---\n## Acceptance\n- A1: Item.\n## Verify\n- A1: " +
				body +
				"\n",
		);
		expect(errors[0]?.message).toBe(expected);
	});
}

test("unknown double-hash headings in the Brief remain available to lint", () => {
	const parsed = parseOrThrow(
		source(
			[
				"---",
				"title: Brief boundary",
				"size: small",
				"domains: [app]",
				"---",
				"Brief start.",
				"## Extra heading",
				"Keep this in the brief.",
				"## Acceptance",
				"- A1: It parses.",
				"## Verify",
				"- A1: test",
				"",
			].join("\n"),
		),
	);
	expect(parsed.brief).toBe(
		"Brief start.\n## Extra heading\nKeep this in the brief.",
	);
});

test("a malformed known heading after a section is still an unknown section", () => {
	const errors = parseErrors(
		[
			"---",
			"title: Heading boundary",
			"size: small",
			"domains: [app]",
			"---",
			"## Acceptance",
			"- A1: It parses.",
			"##  Acceptance",
			"- A1: test",
		].join("\n"),
	);
	expect(errors).toContainEqual({
		line: 9,
		message: 'unknown Intent section "Acceptance"',
	});
});

test("matches the frozen state-04 rejected frontmatter and section fixtures", () => {
	const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
		rows: readonly { label: string; text: string }[];
	};
	const tick = "\u0060";
	const expectations: Readonly<
		Record<string, { line: number; message: string }>
	> = {
		"no-frontmatter": {
			line: 1,
			message: `frontmatter must start with ${tick}---${tick}`,
		},
		"no-closing": {
			line: 12,
			message: `frontmatter is missing its closing ${tick}---${tick}`,
		},
		"unknown-key": { line: 5, message: 'unknown frontmatter key "owner"' },
		"title-not-string": {
			line: 2,
			message: `frontmatter ${tick}title${tick} must be a string`,
		},
		"domains-not-list": {
			line: 4,
			message: `frontmatter ${tick}domains${tick} must be a list`,
		},
		"domains-not-strings": {
			line: 4,
			message: `frontmatter ${tick}domains${tick} must contain only strings`,
		},
		"missing-size": {
			line: 2,
			message: `frontmatter is missing required key ${tick}size${tick}`,
		},
		"changes-gate": {
			line: 5,
			message:
				"frontmatter " +
				tick +
				"changes_gate" +
				tick +
				" must be true or false",
		},
		"not-a-map": { line: 2, message: "frontmatter must be a YAML map" },
		"yaml-error": { line: 2, message: "unterminated quoted string" },
		"unknown-section": {
			line: 15,
			message: 'unknown Intent section "Extras"',
		},
		"duplicate-section": { line: 15, message: "duplicate Verify section" },
		"acceptance-entry": {
			line: 9,
			message:
				"Acceptance entries use " +
				tick +
				"- A<n>: one sentence" +
				tick +
				" on one line",
		},
		"verify-entry": {
			line: 12,
			message:
				"Verify entries use " +
				tick +
				"- A<n>: test" +
				tick +
				" or " +
				tick +
				"- A<n>: test keep" +
				tick,
		},
		"duplicate-verify": {
			line: 13,
			message: "duplicate Verify entry for A1",
		},
		"verify-without-item": {
			line: 13,
			message: "Verify entry A2 has no Acceptance item",
		},
	};

	for (const row of fixture.rows) {
		const expected = expectations[row.label];
		if (expected === undefined)
			throw new Error(`No assertion for ${row.label}`);
		expect(parseErrors(row.text), row.label).toContainEqual(expected);
	}
});

test("hashes exact Intent bytes and Intent-NUL-acceptance bytes", () => {
	const intent = new Uint8Array([
		0x69, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0xff, 0x0d, 0x0a,
	]);
	const acceptance = new Uint8Array([0x74, 0x65, 0x73, 0x74, 0x00, 0xfe]);
	expect(hashIntentBytes(intent)).toBe(
		"20b26d5e2e0d8ae6d95490b19d288b70728d648c9e64bbe77f7d5c58b10100c2",
	);
	expect(hashApprovalBytes(intent, acceptance)).toBe(
		"8e4c76c1ad3941a6408cae3da4ed5809b2c1d4a76b3ee8b1e2aff469308f572c",
	);
});

test("matches the frozen state-07 CRLF Request approval hash", () => {
	const fixture = JSON.parse(readFileSync(rawHashFixturePath, "utf8")) as {
		steps: readonly {
			intent?: { intent_text: string; test_text: string };
		}[];
	};
	const intent = fixture.steps[0]?.intent;
	if (intent === undefined)
		throw new Error("state-07 fixture has no Intent step");
	const intentBytes = encoder.encode(intent.intent_text);
	const acceptanceBytes = encoder.encode(intent.test_text);
	const parsed = parseIntent(intentBytes);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

	expect(hashIntentBytes(intentBytes)).toBe(
		"f867e3f4ef2a4b95887d9dbdd939a2c45b01aacb4aafdbb9e4757bd138db6b66",
	);
	expect(hashApprovalBytes(intentBytes, acceptanceBytes)).toBe(
		"388aa63a3e8f5ba696802e4687c543495cd6f27d621490f7669a42e3f5ab016c",
	);
	expect(parsed.intent.requestBytes).toEqual(
		encoder.encode(
			"Please ensure the robust greeting says Hello, Almir!\r\nIn order to be seamless, it is important.\r\n",
		),
	);
});

test("validates the slug boundary independently from Intent parsing", () => {
	expect(isValidIntentSlug("abc")).toBe(true);
	expect(isValidIntentSlug("a".repeat(48))).toBe(true);
	expect(isValidIntentSlug("ab")).toBe(false);
	expect(isValidIntentSlug("a".repeat(49))).toBe(false);
	expect(isValidIntentSlug("Bad_name")).toBe(false);
});
