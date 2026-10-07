import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	lintIntent,
	renderIntentLintFinding,
} from "../../packages/core/src/intent/lint";
import { normalizeIntentBytes } from "../../packages/core/src/intent/normalize";
import {
	type ParsedIntent,
	parseIntent,
} from "../../packages/core/src/intent/parse";
import {
	SHAPER_INTENT_SCHEMA_FIXTURE,
	SHAPER_INTENT_TEMPLATE,
	SHAPER_SYSTEM_PROMPT,
} from "../../packages/core/src/shape/prompts";

interface LintRow {
	readonly label: string;
	readonly text: string;
	readonly line?: string;
	readonly rule?: string;
	readonly check?: {
		readonly stdout_contains?: string;
		readonly stdout_not_contains?: string;
	};
}

const encoder = new TextEncoder();
const root = join(import.meta.dir, "../..");
const lintErrorRows = readJson<{ readonly rows: readonly LintRow[] }>(
	join(
		root,
		"spec-lock/kogen-conformance/cases/state/state-05-lint-error-rules.json",
	),
).rows;
const bannedRows = readJson<{ readonly rows: readonly LintRow[] }>(
	join(
		root,
		"spec-lock/kogen-conformance/cases/format/format-02-banned-words-phrases.json",
	),
).rows;
const hedgeRows = readJson<{ readonly rows: readonly LintRow[] }>(
	join(root, "spec-lock/kogen-conformance/cases/format/format-03-hedges.json"),
).rows;
const tierRows = readJson<{ readonly rows: readonly LintRow[] }>(
	join(
		root,
		"spec-lock/kogen-conformance/cases/format/format-04-tier-boundaries.json",
	),
).rows;

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parsedIntent(text: string): ParsedIntent {
	const result = parseIntent(encoder.encode(text));
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.intent;
}

function parsedBytes(bytes: Uint8Array): ParsedIntent {
	const result = parseIntent(bytes);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.intent;
}

function lintFor(text: string, shaping = false) {
	return lintIntent(parsedIntent(text), { shaping });
}

function findingByRule(findings: ReturnType<typeof lintIntent>, rule: string) {
	return findings.find((item) => item.rule === rule);
}

test("matches state-05 lint rows accepted by the parser and documents its boundary", () => {
	for (const row of lintErrorRows) {
		const parsed = parseIntent(encoder.encode(row.text));
		if (row.label === "invalid_verify" || row.label === "unknown_size") {
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) {
				expect(parsed.errors[0]?.message).toBe(
					row.label === "invalid_verify"
						? "invalid Verify entry"
						: "frontmatter `size` must be small, medium, or large",
				);
			}
			continue;
		}
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) continue;
		const finding = findingByRule(lintIntent(parsed.intent), row.label);
		expect(finding, row.label).toBeDefined();
		expect(
			renderIntentLintFinding(finding as NonNullable<typeof finding>),
		).toContain(row.label);
	}
});

test("uses each frozen banned word and phrase, without matching Request bytes", () => {
	expect(bannedRows).toHaveLength(65);
	for (const row of bannedRows) {
		const findings = lintFor(row.text).filter(
			(item) => item.rule === "banned_phrase",
		);
		expect(
			findings.some((item) =>
				item.message.endsWith(`banned phrase "${row.label}"`),
			),
			row.label,
		).toBe(true);
	}
	const requestOnly = parsedIntent(
		"---\ntitle: Plain title\nsize: small\ndomains: [app]\n---\nChange the greeting in lib/greet.txt.\n\n## Acceptance\n- A1: The greeting has one line.\n\n## Verify\n- A1: test\n\n## Request\nPlease ensure this may remain TODO; do it in order to preserve the exact raw request.\n",
	);
	expect(lintIntent(requestOnly)).toEqual([]);
});

test("uses every frozen hedge term only in Brief and Acceptance", () => {
	for (const row of hedgeRows) {
		const finding = findingByRule(lintFor(row.text), "hedge");
		expect(finding?.message, row.label).toContain("A1 contains a hedge");
	}
	const inNotes = lintFor(
		"---\ntitle: Plain title\nsize: small\ndomains: [app]\n---\nChange the greeting in lib/greet.txt.\n\n## Acceptance\n- A1: The greeting has one line.\n\n## Verify\n- A1: test\n\n## Notes\nThe formatter may keep this implementation detail.\n",
	);
	expect(inNotes.some((item) => item.rule === "hedge")).toBe(false);
});

test("matches all tier threshold inclusion and overflow rows", () => {
	for (const row of tierRows) {
		const expected =
			row.check?.stdout_contains ?? row.check?.stdout_not_contains;
		const name = /lint_([a-z_]+):/u.exec(expected ?? "")?.[1];
		expect(name, row.label).toBeDefined();
		const present = lintFor(row.text).some((item) => item.rule === name);
		expect(present, row.label).toBe(row.check?.stdout_contains !== undefined);
	}
});

test("keeps original Request bytes out of lint and appends them unchanged", () => {
	const generated = encoder.encode(
		"---\r\ntitle: Preserve bytes\r\nsize: small\r\ndomains: [app]\r\n---\r\nChange the greeting output.\r\n\r\n## Acceptance\r\n- A1: The output remains one line.\r\n\r\n## Verify\r\n- A1: test\r\n\r\n## Notes\r\napproach: update the greeting formatter and preserve its one-line output contract.\r\n\r\n## Request\r\nModel supplied text with banned word durable.\r\n",
	);
	const request = new Uint8Array([
		...encoder.encode("ensure CRLF and invalid UTF-8 are retained:\r\n"),
		0xff,
		0x00,
		0x0d,
		0x0a,
	]);
	const normalized = normalizeIntentBytes(generated, request);
	const parsed = parsedBytes(normalized);
	const normalizedText = new TextDecoder().decode(normalized);
	expect(parsed.requestBytes).toEqual(request);
	expect(parsed.notes).toContain("Approach: update");
	expect(normalizedText).toContain("contract.\r\n\r\n\n## Request\n");
	expect(
		parsed.rawBytes.subarray(parsed.rawBytes.length - request.length),
	).toEqual(request);
	expect(
		lintIntent(parsed).some((item) => item.message.includes("durable")),
	).toBe(false);
	expect(normalized).not.toEqual(generated);
});

test("promotes action-led Notes and leaves other Notes text unchanged", () => {
	const request = encoder.encode("Do the requested work.\n");
	const actionNotes = encoder.encode(
		"---\ntitle: Notes\nsize: small\ndomains: [app]\n---\nChange one output.\n\n## Acceptance\n- A1: The output has one line.\n\n## Verify\n- A1: test\n\n## Notes\nReplace the greeting in lib/greet.txt and preserve its punctuation and line ending.\n",
	);
	const unchangedNotes = encoder.encode(
		"---\ntitle: Notes\nsize: small\ndomains: [app]\n---\nChange one output.\n\n## Acceptance\n- A1: The output has one line.\n\n## Verify\n- A1: test\n\n## Notes\nThe existing formatter is in lib/greet.txt and uses one line.\n",
	);
	const actionResult = new TextDecoder().decode(
		normalizeIntentBytes(actionNotes, request),
	);
	const unchangedResult = new TextDecoder().decode(
		normalizeIntentBytes(unchangedNotes, request),
	);
	expect(actionResult).toContain(
		"Approach: Replace the greeting in lib/greet.txt and preserve its punctuation and line ending.",
	);
	expect(unchangedResult).toContain(
		"## Notes\nThe existing formatter is in lib/greet.txt and uses one line.",
	);
});

test("adds shaping-only Approach feedback and checks effective gate paths", () => {
	const intent = parsedIntent(
		"---\ntitle: Shape notes\nsize: small\ndomains: [app]\n---\nUpdate the formatter.\n\n## Acceptance\n- A1: The formatter preserves one line.\n\n## Verify\n- A1: test\n\n## Notes\nChange src/format.ts and preserve the output.\n",
	);
	const findings = lintIntent(intent, {
		shaping: true,
		gatePaths: ["src/format.ts"],
		acceptanceTest: "assert_output('ok')",
	});
	expect(findings.map((item) => item.rule)).toContain("missing_approach");
	expect(findings.map((item) => item.rule)).toContain("undeclared_gate_path");
});

test("prompt schema fixture parses and the stable prompt teaches keys and tags", () => {
	const parsed = parsedIntent(SHAPER_INTENT_SCHEMA_FIXTURE);
	expect(parsed.frontmatter).toMatchObject({
		title: "Preserve the greeting format",
		size: "medium",
		domains: ["app", "support"],
		changesGate: true,
		blocksOn: ["base-api"],
	});
	expect(
		lintIntent(parsed, { shaping: true }).some(
			(item) => item.severity === "error",
		),
	).toBe(false);
	for (const key of [
		"title:",
		"size:",
		"domains:",
		"changes_gate",
		"limits",
		"blocks_on",
		"priority",
		"assumptions",
		"shared_contracts",
		"source",
		"A1:",
		"A2:",
		"<slug>/A1",
		"<slug>/A2",
		"@tag intent:",
	]) {
		expect(SHAPER_INTENT_TEMPLATE + SHAPER_SYSTEM_PROMPT).toContain(key);
	}
	expect(SHAPER_SYSTEM_PROMPT).toContain(
		"Kogen appends the original Request bytes verbatim",
	);
	expect(SHAPER_INTENT_TEMPLATE).not.toContain("## Request");
});
