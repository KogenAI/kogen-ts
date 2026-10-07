import {
	decodeYamlScalar,
	type YamlBlockNode,
	type YamlMapNode,
	type YamlScalarNode,
	type YamlSequenceNode,
} from "../yaml/block";
import { parseYaml } from "../yaml/parse";

export const INTENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const INTENT_SLUG_MIN_LENGTH = 3;
export const INTENT_SLUG_MAX_LENGTH = 48;

export function isValidIntentSlug(slug: string): boolean {
	return (
		slug.length >= INTENT_SLUG_MIN_LENGTH &&
		slug.length <= INTENT_SLUG_MAX_LENGTH &&
		INTENT_SLUG_PATTERN.test(slug)
	);
}

export interface IntentParseError {
	readonly line: number;
	readonly message: string;
}

export interface IntentPredicate {
	readonly name: string;
	readonly path: string;
	readonly contains: string;
}

export type IntentSize = "small" | "medium" | "large";

export interface IntentFrontmatter {
	readonly title: string;
	readonly size: IntentSize;
	readonly domains: readonly string[];
	readonly changesGate: boolean;
	readonly limits: readonly string[];
	readonly blocksOn: readonly string[];
	readonly priority: number;
	readonly assumptions: readonly IntentPredicate[];
	readonly sharedContracts: readonly IntentPredicate[];
	readonly source?: string;
}

export interface IntentAcceptanceItem {
	readonly id: string;
	readonly text: string;
	readonly line: number;
}

export interface IntentVerifyItem {
	readonly id: string;
	readonly kind: "test";
	readonly keep: boolean;
	/** The last `domain=` modifier, if one was supplied. */
	readonly domain: string | null;
	readonly line: number;
}

export interface ParsedIntent {
	readonly frontmatter: IntentFrontmatter;
	readonly brief: string;
	readonly acceptance: readonly IntentAcceptanceItem[];
	readonly verify: readonly IntentVerifyItem[];
	readonly notes: string | null;
	/** Bytes after the `## Request` heading line, unchanged; null means no section. */
	readonly requestBytes: Uint8Array | null;
	/** A defensive copy of the complete source, including Request and any invalid UTF-8. */
	readonly rawBytes: Uint8Array;
}

export type IntentParseResult =
	| { readonly ok: true; readonly intent: ParsedIntent }
	| { readonly ok: false; readonly errors: readonly IntentParseError[] };

interface ByteLine {
	readonly start: number;
	readonly end: number;
	readonly next: number;
	readonly number: number;
}

type IntentSection = "Acceptance" | "Verify" | "Notes";

const FRONTMATTER_KEYS = new Set([
	"title",
	"size",
	"domains",
	"changes_gate",
	"limits",
	"blocks_on",
	"priority",
	"assumptions",
	"shared_contracts",
	"source",
]);
const REQUIRED_FRONTMATTER_KEYS = ["title", "size", "domains"] as const;

function splitByteLines(bytes: Uint8Array): ByteLine[] {
	const result: ByteLine[] = [];
	let start = 0;
	let number = 1;
	for (let offset = 0; offset < bytes.byteLength; offset += 1) {
		if (bytes[offset] !== 0x0a) continue;
		result.push({ start, end: offset, next: offset + 1, number });
		start = offset + 1;
		number += 1;
	}
	result.push({ start, end: bytes.byteLength, next: bytes.byteLength, number });
	return result;
}

function visibleLineBytes(bytes: Uint8Array, line: ByteLine): Uint8Array {
	let end = line.end;
	if (end > line.start && bytes[end - 1] === 0x0d) end -= 1;
	return bytes.subarray(line.start, end);
}

function visibleLine(bytes: Uint8Array, line: ByteLine): string {
	return new TextDecoder().decode(visibleLineBytes(bytes, line));
}

function hasDelimiter(bytes: Uint8Array, line: ByteLine): boolean {
	const visible = visibleLineBytes(bytes, line);
	return (
		visible.byteLength === 3 &&
		visible[0] === 0x2d &&
		visible[1] === 0x2d &&
		visible[2] === 0x2d
	);
}

function error(line: number, message: string): IntentParseError {
	return { line, message };
}

function isMapNode(node: YamlBlockNode): node is YamlMapNode {
	return node.kind === "map";
}

function isScalarNode(node: YamlBlockNode | undefined): node is YamlScalarNode {
	return node?.kind === "scalar";
}

function isSequenceNode(
	node: YamlBlockNode | undefined,
): node is YamlSequenceNode {
	return node?.kind === "sequence";
}

function mappingKeyOffset(text: string): number | null {
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
			(index + 1 === text.length || /\s/u.test(text[index + 1] ?? ""))
		) {
			return index;
		}
	}
	return null;
}

function frontmatterKeyLines(
	bytes: Uint8Array,
	lines: readonly ByteLine[],
	first: number,
	last: number,
): Map<string, number> {
	const result = new Map<string, number>();
	for (let index = first; index < last; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const text = visibleLine(bytes, line);
		if (text.length === 0 || text[0] === " " || text[0] === "\t") continue;
		const delimiter = mappingKeyOffset(text);
		if (delimiter === null) continue;
		const key = decodeYamlScalar(text.slice(0, delimiter).trim());
		if (!result.has(key)) result.set(key, line.number);
	}
	return result;
}

function localLine(keyLines: ReadonlyMap<string, number>, key: string): number {
	return keyLines.get(key) ?? 2;
}

function parseStringList(
	key: string,
	node: YamlBlockNode | undefined,
	keyLines: ReadonlyMap<string, number>,
	errors: IntentParseError[],
): string[] | null {
	if (!isSequenceNode(node)) {
		errors.push(
			error(localLine(keyLines, key), `frontmatter \`${key}\` must be a list`),
		);
		return null;
	}
	if (node.items.some((item) => item.kind !== "scalar")) {
		errors.push(
			error(
				localLine(keyLines, key),
				`frontmatter \`${key}\` must contain only strings`,
			),
		);
		return null;
	}
	return node.items.map((item) => (item as YamlScalarNode).value);
}

function parsePredicates(
	key: string,
	node: YamlBlockNode | undefined,
	keyLines: ReadonlyMap<string, number>,
	errors: IntentParseError[],
): IntentPredicate[] | null {
	if (!isSequenceNode(node)) {
		errors.push(
			error(localLine(keyLines, key), `frontmatter \`${key}\` must be a list`),
		);
		return null;
	}
	const predicates: IntentPredicate[] = [];
	for (const [index, item] of node.items.entries()) {
		const line = localLine(keyLines, key);
		if (item.kind !== "map") {
			errors.push(
				error(line, `frontmatter \`${key}\` must contain predicate maps`),
			);
			return null;
		}
		const values = new Map<string, string>();
		for (const required of ["name", "path", "contains"] as const) {
			const value = item.entries.get(required);
			if (!isScalarNode(value)) {
				errors.push(
					error(
						line,
						`frontmatter \`${key}[${index + 1}].${required}\` must be a string`,
					),
				);
				return null;
			}
			values.set(required, value.value);
		}
		for (const nestedKey of item.entries.keys()) {
			if (
				nestedKey !== "name" &&
				nestedKey !== "path" &&
				nestedKey !== "contains"
			) {
				errors.push(
					error(line, `unknown frontmatter key "${key}.${nestedKey}"`),
				);
				return null;
			}
		}
		const name = values.get("name");
		const path = values.get("path");
		const contains = values.get("contains");
		if (name === undefined || path === undefined || contains === undefined) {
			return null;
		}
		predicates.push({ name, path, contains });
	}
	return predicates;
}

function parseFrontmatter(
	bytes: Uint8Array,
	lines: readonly ByteLine[],
	opening: ByteLine,
	closing: ByteLine,
):
	| { readonly value: IntentFrontmatter }
	| { readonly errors: IntentParseError[] } {
	const start = opening.next;
	const raw = bytes.subarray(start, closing.start);
	const parsed = parseYaml(raw);
	if (parsed.issue !== null) {
		return {
			errors: [error((parsed.issue.line ?? 1) + 1, parsed.issue.message)],
		};
	}
	if (parsed.node === null || !isMapNode(parsed.node)) {
		return { errors: [error(2, "frontmatter must be a YAML map")] };
	}

	const keyLines = frontmatterKeyLines(
		bytes,
		lines,
		opening.number,
		closing.number - 1,
	);
	const errors: IntentParseError[] = [];
	for (const key of parsed.node.entries.keys()) {
		if (!FRONTMATTER_KEYS.has(key)) {
			errors.push(
				error(localLine(keyLines, key), `unknown frontmatter key "${key}"`),
			);
		}
	}
	for (const key of REQUIRED_FRONTMATTER_KEYS) {
		if (!parsed.node.entries.has(key)) {
			errors.push(error(2, `frontmatter is missing required key \`${key}\``));
		}
	}

	const titleNode = parsed.node.entries.get("title");
	let title: string | null = null;
	if (titleNode !== undefined) {
		if (!isScalarNode(titleNode)) {
			errors.push(
				error(
					localLine(keyLines, "title"),
					"frontmatter `title` must be a string",
				),
			);
		} else title = titleNode.value;
	}

	const sizeNode = parsed.node.entries.get("size");
	let size: IntentSize | null = null;
	if (sizeNode !== undefined) {
		if (!isScalarNode(sizeNode)) {
			errors.push(
				error(
					localLine(keyLines, "size"),
					"frontmatter `size` must be a string",
				),
			);
		} else if (
			sizeNode.value !== "small" &&
			sizeNode.value !== "medium" &&
			sizeNode.value !== "large"
		) {
			errors.push(
				error(
					localLine(keyLines, "size"),
					"frontmatter `size` must be small, medium, or large",
				),
			);
		} else size = sizeNode.value;
	}

	const domains = parsed.node.entries.has("domains")
		? parseStringList(
				"domains",
				parsed.node.entries.get("domains"),
				keyLines,
				errors,
			)
		: null;
	const limits = parsed.node.entries.has("limits")
		? parseStringList(
				"limits",
				parsed.node.entries.get("limits"),
				keyLines,
				errors,
			)
		: [];
	const blocksOn = parsed.node.entries.has("blocks_on")
		? parseStringList(
				"blocks_on",
				parsed.node.entries.get("blocks_on"),
				keyLines,
				errors,
			)
		: [];
	if (blocksOn !== null) {
		for (const slug of blocksOn) {
			if (!isValidIntentSlug(slug)) {
				errors.push(
					error(
						localLine(keyLines, "blocks_on"),
						`frontmatter \`blocks_on\` contains invalid slug "${slug}"`,
					),
				);
			}
		}
	}

	let changesGate = false;
	const changesGateNode = parsed.node.entries.get("changes_gate");
	if (changesGateNode !== undefined) {
		if (
			!isScalarNode(changesGateNode) ||
			(changesGateNode.value !== "true" && changesGateNode.value !== "false")
		) {
			errors.push(
				error(
					localLine(keyLines, "changes_gate"),
					"frontmatter `changes_gate` must be true or false",
				),
			);
		} else changesGate = changesGateNode.value === "true";
	}

	let priority = 0;
	const priorityNode = parsed.node.entries.get("priority");
	if (priorityNode !== undefined) {
		if (
			!isScalarNode(priorityNode) ||
			!/^-?(?:0|[1-9][0-9]*)$/u.test(priorityNode.value) ||
			!Number.isSafeInteger(Number(priorityNode.value))
		) {
			errors.push(
				error(
					localLine(keyLines, "priority"),
					"frontmatter `priority` must be an integer",
				),
			);
		} else priority = Number(priorityNode.value);
	}

	const assumptions = parsed.node.entries.has("assumptions")
		? parsePredicates(
				"assumptions",
				parsed.node.entries.get("assumptions"),
				keyLines,
				errors,
			)
		: [];
	const sharedContracts = parsed.node.entries.has("shared_contracts")
		? parsePredicates(
				"shared_contracts",
				parsed.node.entries.get("shared_contracts"),
				keyLines,
				errors,
			)
		: [];

	let source: string | undefined;
	const sourceNode = parsed.node.entries.get("source");
	if (sourceNode !== undefined) {
		if (!isScalarNode(sourceNode)) {
			errors.push(
				error(
					localLine(keyLines, "source"),
					"frontmatter `source` must be a string",
				),
			);
		} else source = sourceNode.value;
	}

	if (
		errors.length > 0 ||
		title === null ||
		size === null ||
		domains === null
	) {
		return { errors: errors.sort((left, right) => left.line - right.line) };
	}

	return {
		value: {
			title,
			size,
			domains,
			changesGate,
			limits: limits ?? [],
			blocksOn: blocksOn ?? [],
			priority,
			assumptions: assumptions ?? [],
			sharedContracts: sharedContracts ?? [],
			...(source === undefined ? {} : { source }),
		},
	};
}

function sectionName(text: string): IntentSection | "Request" | null {
	const trimmed = text.trim();
	if (trimmed === "## Acceptance") return "Acceptance";
	if (trimmed === "## Verify") return "Verify";
	if (trimmed === "## Notes") return "Notes";
	if (trimmed === "## Request") return "Request";
	return null;
}

function unknownSectionName(text: string): string | null {
	const match = /^##\s+(.+)$/u.exec(text.trim());
	if (match === null) return null;
	const candidate = match[1]?.trim();
	if (candidate === undefined || candidate.length === 0) {
		return null;
	}
	return candidate;
}

function sectionLinesText(
	lines: readonly ByteLine[],
	bytes: Uint8Array,
): string[] {
	return lines.map((line) => visibleLine(bytes, line));
}

function parseAcceptance(
	lines: readonly ByteLine[],
	bytes: Uint8Array,
	errors: IntentParseError[],
): IntentAcceptanceItem[] {
	const items: IntentAcceptanceItem[] = [];
	for (const line of lines) {
		const text = visibleLine(bytes, line).trim();
		if (text.length === 0) continue;
		const match = /^-\s+A([0-9]+):\s*(.*)$/u.exec(text);
		if (match === null) {
			errors.push(
				error(
					line.number,
					"Acceptance entries use `- A<n>: one sentence` on one line",
				),
			);
			continue;
		}
		const digits = match[1];
		if (digits === undefined) continue;
		items.push({ id: `A${digits}`, text: match[2] ?? "", line: line.number });
	}
	return items;
}

function parseVerifyBody(
	id: string,
	body: string,
	line: ByteLine,
	errors: IntentParseError[],
): IntentVerifyItem | null {
	const tokens = body
		.trim()
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	const first = tokens[0];
	if (first === undefined) {
		errors.push(error(line.number, "invalid Verify entry"));
		return null;
	}
	if (first === "example" || first === "check") {
		errors.push(error(line.number, `${first} is not supported in core v1`));
		return null;
	}
	if (first !== "test") {
		errors.push(error(line.number, "invalid Verify entry"));
		return null;
	}

	let index = 1;
	let keep = false;
	if (tokens[index] === "keep") {
		keep = true;
		index += 1;
	}
	let domain: string | null = null;
	for (; index < tokens.length; index += 1) {
		const modifier = tokens[index];
		if (modifier === "integration") continue;
		if (modifier?.startsWith("domain=") === true) {
			const value = modifier.slice("domain=".length);
			if (value.length === 0) {
				errors.push(error(line.number, "invalid Verify entry"));
				return null;
			}
			domain = value;
			continue;
		}
		if (modifier?.startsWith("after=") === true) {
			if (modifier.length === "after=".length) {
				errors.push(error(line.number, "invalid Verify entry"));
				return null;
			}
			continue;
		}
		errors.push(error(line.number, "invalid Verify entry"));
		return null;
	}
	return { id, kind: "test", keep, domain, line: line.number };
}

function parseVerify(
	lines: readonly ByteLine[],
	bytes: Uint8Array,
	acceptance: readonly IntentAcceptanceItem[],
	errors: IntentParseError[],
): IntentVerifyItem[] {
	const items: IntentVerifyItem[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const text = visibleLine(bytes, line).trim();
		if (text.length === 0) continue;
		const match = /^-\s+A([0-9]+):\s*(.*)$/u.exec(text);
		if (match === null) {
			errors.push(
				error(
					line.number,
					"Verify entries use `- A<n>: test` or `- A<n>: test keep`",
				),
			);
			continue;
		}
		const digits = match[1];
		if (digits === undefined) continue;
		const id = `A${digits}`;
		if (seen.has(id)) {
			errors.push(error(line.number, `duplicate Verify entry for ${id}`));
			continue;
		}
		seen.add(id);
		const item = parseVerifyBody(id, match[2] ?? "", line, errors);
		if (item !== null) items.push(item);
	}
	const acceptanceIds = new Set(acceptance.map((item) => item.id));
	for (const item of items) {
		if (!acceptanceIds.has(item.id)) {
			errors.push(
				error(item.line, `Verify entry ${item.id} has no Acceptance item`),
			);
		}
	}
	return items;
}

/**
 * Parse one Intent from its source bytes. Parsing enforces only the on-disk
 * grammar; linting and normalization are separate stages.
 */
export function parseIntent(input: Uint8Array): IntentParseResult {
	const bytes = input.slice();
	const lines = splitByteLines(bytes);
	const opening = lines[0];
	if (opening === undefined || !hasDelimiter(bytes, opening)) {
		return {
			ok: false,
			errors: [error(1, "frontmatter must start with `---`")],
		};
	}

	let closing: ByteLine | undefined;
	let closingIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line !== undefined && hasDelimiter(bytes, line)) {
			closing = line;
			closingIndex = index;
			break;
		}
	}
	if (closing === undefined) {
		const last = lines.at(-1);
		const line =
			last !== undefined &&
			last.start === bytes.byteLength &&
			bytes.byteLength > 0 &&
			bytes[bytes.byteLength - 1] === 0x0a
				? last.number
				: (last?.number ?? 1) + 1;
		return {
			ok: false,
			errors: [error(line, "frontmatter is missing its closing `---`")],
		};
	}

	const frontmatter = parseFrontmatter(bytes, lines, opening, closing);
	if ("errors" in frontmatter) return { ok: false, errors: frontmatter.errors };

	const sectionLines = new Map<IntentSection, ByteLine[]>();
	const seenSections = new Set<IntentSection>();
	const briefLines: string[] = [];
	const errors: IntentParseError[] = [];
	let currentSection: IntentSection | null = null;
	let requestBytes: Uint8Array | null = null;

	for (let index = closingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const text = visibleLine(bytes, line);
		const heading = sectionName(text);
		if (heading === "Request") {
			requestBytes = bytes.slice(line.next);
			break;
		}
		if (heading !== null) {
			if (seenSections.has(heading)) {
				errors.push(error(line.number + 1, `duplicate ${heading} section`));
			} else {
				seenSections.add(heading);
				sectionLines.set(heading, []);
			}
			currentSection = heading;
			continue;
		}

		const unknown = unknownSectionName(text);
		if (unknown !== null) {
			if (currentSection === null) briefLines.push(text);
			else {
				errors.push(
					error(line.number + 1, `unknown Intent section "${unknown}"`),
				);
				currentSection = null;
			}
			continue;
		}

		if (currentSection === null) briefLines.push(text);
		else sectionLines.get(currentSection)?.push(line);
	}

	const acceptance = parseAcceptance(
		sectionLines.get("Acceptance") ?? [],
		bytes,
		errors,
	);
	const verify = parseVerify(
		sectionLines.get("Verify") ?? [],
		bytes,
		acceptance,
		errors,
	);
	if (errors.length > 0) {
		return {
			ok: false,
			errors: errors.sort((left, right) => left.line - right.line),
		};
	}

	const notes = sectionLines.has("Notes")
		? sectionLinesText(sectionLines.get("Notes") ?? [], bytes).join("\n")
		: null;
	return {
		ok: true,
		intent: {
			frontmatter: frontmatter.value,
			brief: briefLines.join("\n").trim(),
			acceptance,
			verify,
			notes,
			requestBytes,
			rawBytes: bytes,
		},
	};
}
