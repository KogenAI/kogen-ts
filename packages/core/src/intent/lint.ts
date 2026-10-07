import lintData from "../../../../spec-lock/kogen-spec/spec/data/lint.json" with {
	type: "json",
};
import type { IntentSize, ParsedIntent } from "./parse";

export type IntentLintSeverity = "error" | "style";

export interface IntentLintFinding {
	readonly rule: string;
	readonly severity: IntentLintSeverity;
	readonly line?: number;
	readonly message: string;
}

export interface IntentLintOptions {
	/** Include the shaping-only Approach and gate declaration findings. */
	readonly shaping?: boolean;
	/** Gate globs effective for this project, passed by the shaping layer. */
	readonly gatePaths?: readonly string[];
	/** The staged acceptance source used for the shaping-only gate check. */
	readonly acceptanceTest?: string | Uint8Array;
}

interface LintTier {
	readonly brief_paragraphs: number;
	readonly brief_words: number;
	readonly items: number;
	readonly notes_words: number;
}

interface LintPolicy {
	readonly tiers: Readonly<Record<IntentSize, LintTier>>;
	readonly limits: Readonly<{
		title_chars: number;
		item_words: number;
		sentence_words: number;
		notes_code_block_lines: number;
		approach_min_words: number;
	}>;
	readonly banned_words: readonly string[];
	readonly banned_phrases: readonly string[];
	readonly hedge_words: readonly string[];
	readonly hedge_phrases: readonly string[];
	readonly action_verbs: readonly string[];
}

const POLICY = lintData as LintPolicy;
const WORD_CHARACTER = /[a-z0-9_]/u;

export const INTENT_LINT_LIMITS = POLICY.limits;
export const INTENT_ACTION_VERBS = POLICY.action_verbs;

function finding(
	rule: string,
	severity: IntentLintSeverity,
	message: string,
	line?: number,
): IntentLintFinding {
	return {
		rule,
		severity,
		...(line === undefined ? {} : { line }),
		message,
	};
}

function words(value: string | null): readonly string[] {
	return value?.split(/\s+/u).filter((word) => word.length > 0) ?? [];
}

function paragraphCount(value: string): number {
	return value
		.split(/\n\s*\n/u)
		.filter((paragraph) => paragraph.trim().length > 0).length;
}

function withoutInlineCode(value: string): string {
	let inCode = false;
	let output = "";
	for (const character of value) {
		if (character === "`") {
			inCode = !inCode;
			output += " ";
		} else output += inCode ? " " : character;
	}
	return output;
}

function containsTerm(value: string, term: string): boolean {
	const source = value.toLowerCase();
	const needle = term.toLowerCase();
	let offset = 0;
	while (offset <= source.length - needle.length) {
		const index = source.indexOf(needle, offset);
		if (index < 0) return false;
		const end = index + needle.length;
		const left = index === 0 ? undefined : source[index - 1];
		const right = end >= source.length ? undefined : source[end];
		if (
			(left === undefined || !WORD_CHARACTER.test(left)) &&
			(right === undefined || !WORD_CHARACTER.test(right))
		) {
			return true;
		}
		offset = index + 1;
	}
	return false;
}

function hasAnyTerm(value: string, terms: readonly string[]): boolean {
	return terms.some((term) => containsTerm(value, term));
}

function sentences(value: string): readonly string[] {
	const result: string[] = [];
	const boundary = /[.!?]\s+/gu;
	let start = 0;
	for (const match of value.matchAll(boundary)) {
		const end =
			(match.index ?? 0) + match[0].length - match[0].trimStart().length;
		const sentence = value.slice(start, end).trim();
		if (sentence.length > 0) result.push(sentence);
		start = end;
	}
	const last = value.slice(start).trim();
	if (last.length > 0) result.push(last);
	return result;
}

function errorFindings(intent: ParsedIntent): IntentLintFinding[] {
	const result: IntentLintFinding[] = [];
	const briefLines = intent.brief.split("\n");
	if (intent.brief.trim().length === 0) {
		result.push(finding("missing_brief", "error", "write the Brief as prose"));
	}
	if (briefLines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s/u.test(line))) {
		result.push(
			finding("list_in_brief", "error", "the Brief cannot contain lists"),
		);
	}
	if (briefLines.some((line) => /^\s*#{1,6}\s/u.test(line))) {
		result.push(
			finding("heading_in_brief", "error", "the Brief cannot contain headings"),
		);
	}
	if (briefLines.some((line) => /^\s*(?:```|~~~)/u.test(line))) {
		result.push(
			finding(
				"code_block_in_brief",
				"error",
				"the Brief cannot contain code blocks",
			),
		);
	}
	if (!isKnownSize(intent.frontmatter.size)) {
		result.push(
			finding("unknown_size", "error", "size must be small, medium, or large"),
		);
	}
	if (intent.acceptance.length === 0) {
		result.push(
			finding(
				"acceptance_count",
				"error",
				"Acceptance needs at least one item",
			),
		);
	}
	if (intent.frontmatter.title.trim().length === 0) {
		result.push(finding("missing_title", "error", "title is required"));
	}
	if (
		intent.frontmatter.domains.length < 1 ||
		intent.frontmatter.domains.length > 4
	) {
		result.push(
			finding("domain_count", "error", "declare between one and four domains"),
		);
	}

	const seen = new Set<string>();
	const duplicate = intent.acceptance.find((item) => {
		if (seen.has(item.id)) return true;
		seen.add(item.id);
		return false;
	});
	if (duplicate !== undefined) {
		result.push(
			finding(
				"duplicate_id",
				"error",
				"Acceptance ids must be unique",
				duplicate.line,
			),
		);
	}
	if (intent.acceptance.some((item, index) => item.id !== `A${index + 1}`)) {
		result.push(
			finding(
				"sequential_ids",
				"error",
				"Acceptance ids must be A1 through An in order",
			),
		);
	}
	if (
		intent.acceptance.some(
			(item) => !intent.verify.some((verify) => verify.id === item.id),
		)
	) {
		result.push(
			finding(
				"missing_verify",
				"error",
				"every Acceptance item needs a Verify kind",
			),
		);
	}
	for (const verify of intent.verify) {
		const kind: string = verify.kind;
		if (kind === "example" || kind === "check") {
			result.push(
				finding(
					"unsupported_verify_kind",
					"error",
					`${kind} is not supported in core v1`,
					verify.line,
				),
			);
		} else if (kind !== "test") {
			result.push(
				finding(
					"invalid_verify",
					"error",
					`unknown Verify word "${kind}"`,
					verify.line,
				),
			);
		}
	}
	if (!intent.verify.some((verify) => verify.kind === "test" && !verify.keep)) {
		result.push(
			finding(
				"no_change_item",
				"error",
				"at least one Acceptance item must be a change item (test)",
			),
		);
	}
	if (hasOpenQuestion(intent)) {
		result.push(
			finding(
				"open_question",
				"error",
				"remove TBD, TODO, FIXME, or unresolved question markers",
			),
		);
	}
	return result;
}

function isKnownSize(size: string): size is IntentSize {
	return size === "small" || size === "medium" || size === "large";
}

function hasOpenQuestion(intent: ParsedIntent): boolean {
	const marker = /\b(?:TBD|TODO|FIXME)\b|\[\s*NEEDS CLARIFICATION|\?\?/iu;
	return (
		marker.test(intent.brief) ||
		intent.acceptance.some((item) => marker.test(item.text)) ||
		(intent.notes !== null && marker.test(intent.notes))
	);
}

function styleFindings(intent: ParsedIntent): IntentLintFinding[] {
	const result: IntentLintFinding[] = [];
	if (!isKnownSize(intent.frontmatter.size)) return result;
	const size = intent.frontmatter.size;
	const tier = POLICY.tiers[size];
	const limits = POLICY.limits;
	if (paragraphCount(intent.brief) > tier.brief_paragraphs) {
		result.push(
			finding(
				"brief_paragraphs",
				"style",
				`${size} Intents allow at most ${tier.brief_paragraphs} Brief paragraphs`,
			),
		);
	}
	if (words(intent.brief).length > tier.brief_words) {
		result.push(
			finding(
				"brief_too_long",
				"style",
				`${size} Intents allow at most ${tier.brief_words} Brief words`,
			),
		);
	}
	if (intent.acceptance.length > tier.items) {
		result.push(
			finding(
				"too_many_items",
				"style",
				`${size} Intents allow at most ${tier.items} Acceptance items`,
			),
		);
	}
	if (words(intent.notes).length > tier.notes_words) {
		result.push(
			finding(
				"notes_too_long",
				"style",
				`${size} Intents allow at most ${tier.notes_words} Notes words`,
			),
		);
	}
	if (Array.from(intent.frontmatter.title).length > limits.title_chars) {
		result.push(
			finding(
				"title_too_long",
				"style",
				`title must be at most ${limits.title_chars} characters`,
			),
		);
	}
	for (const item of intent.acceptance) {
		if (words(item.text).length > limits.item_words) {
			result.push(
				finding(
					"item_too_long",
					"style",
					`${item.id} exceeds ${limits.item_words} words`,
					item.line,
				),
			);
		}
		const plain = withoutInlineCode(item.text);
		if (hasAnyTerm(plain, POLICY.hedge_words.concat(POLICY.hedge_phrases))) {
			result.push(
				finding(
					"hedge",
					"style",
					`${item.id} contains a hedge; state an observable result`,
					item.line,
				),
			);
		}
		appendBannedFindings(item.text, item.id, item.line, result);
		if (
			sentences(item.text).some(
				(sentence) => words(sentence).length > limits.sentence_words,
			)
		) {
			result.push(
				finding(
					"sentence_too_long",
					"style",
					`${item.id} has a sentence over ${limits.sentence_words} words`,
					item.line,
				),
			);
		}
	}
	const briefWithoutCode = withoutInlineCode(intent.brief);
	if (
		hasAnyTerm(
			briefWithoutCode,
			POLICY.hedge_words.concat(POLICY.hedge_phrases),
		)
	) {
		result.push(
			finding(
				"hedge",
				"style",
				"Brief contains a hedge; state an observable result",
			),
		);
	}
	appendBannedFindings(intent.brief, "Brief", undefined, result);
	if (
		sentences(intent.brief).some(
			(sentence) => words(sentence).length > limits.sentence_words,
		)
	) {
		result.push(
			finding(
				"sentence_too_long",
				"style",
				`Brief has a sentence over ${limits.sentence_words} words`,
			),
		);
	}
	appendNotesFindings(intent.notes, limits.notes_code_block_lines, result);
	return result;
}

function appendBannedFindings(
	text: string,
	section: string,
	line: number | undefined,
	result: IntentLintFinding[],
): void {
	const plain = withoutInlineCode(text);
	for (const phrase of POLICY.banned_words.concat(POLICY.banned_phrases)) {
		if (containsTerm(plain, phrase)) {
			result.push(
				finding(
					"banned_phrase",
					"style",
					`${section} contains banned phrase "${phrase}"`,
					line,
				),
			);
		}
	}
}

function appendNotesFindings(
	notes: string | null,
	codeLimit: number,
	result: IntentLintFinding[],
): void {
	let fence: "```" | "~~~" | null = null;
	let codeLines = 0;
	for (const line of notes?.split("\n") ?? []) {
		const trimmed = line.trimStart();
		if (fence !== null) {
			if (trimmed.startsWith(fence)) {
				fence = null;
				if (codeLines > codeLimit) {
					result.push(
						finding(
							"long_code_block",
							"style",
							`Notes code blocks must contain at most ${codeLimit} lines`,
						),
					);
				}
			} else codeLines += 1;
		} else if (trimmed.startsWith("```")) {
			fence = "```";
			codeLines = 0;
		} else if (trimmed.startsWith("~~~")) {
			fence = "~~~";
			codeLines = 0;
		}
	}
	if (fence !== null && codeLines > codeLimit) {
		result.push(
			finding(
				"long_code_block",
				"style",
				`Notes code blocks must contain at most ${codeLimit} lines`,
			),
		);
	}
}

function validApproach(notes: string | null): boolean {
	if (notes === null) return false;
	const trimmed = notes.trimStart();
	const text = /^approach:/iu.test(trimmed)
		? trimmed.slice("Approach:".length).trimStart()
		: trimmed;
	const first = text.split(/\s+/u)[0] ?? "";
	return (
		words(text).length >= POLICY.limits.approach_min_words &&
		hasAnyTerm(first, POLICY.action_verbs)
	);
}

function gatePathFinding(
	intent: ParsedIntent,
	options: IntentLintOptions,
): IntentLintFinding | undefined {
	if (
		!options.shaping ||
		intent.frontmatter.changesGate ||
		options.gatePaths === undefined
	) {
		return undefined;
	}
	const test =
		typeof options.acceptanceTest === "string"
			? options.acceptanceTest
			: options.acceptanceTest === undefined
				? ""
				: new TextDecoder().decode(options.acceptanceTest);
	const path = options.gatePaths.find(
		(gatePath) =>
			(intent.notes?.includes(gatePath) ?? false) || test.includes(gatePath),
	);
	if (path === undefined) return undefined;
	return finding(
		"undeclared_gate_path",
		"error",
		`Gate-path edit requires \`changes_gate: true\`; matched path ${path}.`,
	);
}

/** Run the frozen lint policy against the parsed Intent, never its Request. */
export function lintIntent(
	intent: ParsedIntent,
	options: IntentLintOptions = {},
): readonly IntentLintFinding[] {
	const errors = errorFindings(intent);
	const styles = styleFindings(intent);
	if (options.shaping && !validApproach(intent.notes)) {
		styles.push(
			finding(
				"missing_approach",
				"style",
				`Notes must start with Approach: naming the code path (at least ${POLICY.limits.approach_min_words} words and an action verb)`,
			),
		);
	}
	if (options.shaping) {
		const gateFinding = gatePathFinding(intent, options);
		if (gateFinding !== undefined) errors.push(gateFinding);
	}
	return [...errors, ...styles];
}

/** Return the display form shared by approval and shaping diagnostics. */
export function renderIntentLintFinding(issue: IntentLintFinding): string {
	return `${issue.rule}${issue.line === undefined ? "" : ` at line ${issue.line}`}: ${issue.message}`;
}
