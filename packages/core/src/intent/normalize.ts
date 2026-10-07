import { INTENT_ACTION_VERBS, INTENT_LINT_LIMITS } from "./lint";

interface ByteLine {
	readonly start: number;
	readonly end: number;
	readonly next: number;
}

interface ByteRange {
	readonly start: number;
	readonly end: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const KNOWN_SECTIONS = new Set([
	"## Acceptance",
	"## Verify",
	"## Notes",
	"## Request",
]);
const WORD_CHARACTER = /[a-z0-9_]/u;

function byteLines(bytes: Uint8Array): readonly ByteLine[] {
	const result: ByteLine[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0x0a) continue;
		result.push({ start, end: index, next: index + 1 });
		start = index + 1;
	}
	result.push({ start, end: bytes.byteLength, next: bytes.byteLength });
	return result;
}

function lineText(bytes: Uint8Array, line: ByteLine): string {
	let end = line.end;
	if (end > line.start && bytes[end - 1] === 0x0d) end -= 1;
	return new TextDecoder().decode(bytes.subarray(line.start, end)).trim();
}

function afterFrontmatter(
	bytes: Uint8Array,
	lines: readonly ByteLine[],
): number {
	const opening = lines[0];
	if (opening === undefined || lineText(bytes, opening) !== "---") return 0;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line !== undefined && lineText(bytes, line) === "---") return line.next;
	}
	return 0;
}

function requestStart(bytes: Uint8Array, lines: readonly ByteLine[]): number {
	const bodyStart = afterFrontmatter(bytes, lines);
	for (const line of lines) {
		if (line.start < bodyStart) continue;
		if (lineText(bytes, line) === "## Request") return line.start;
	}
	return bytes.byteLength;
}

function notesRange(
	bytes: Uint8Array,
	lines: readonly ByteLine[],
	contentEnd: number,
): ByteRange | null {
	const bodyStart = afterFrontmatter(bytes, lines);
	let start: number | null = null;
	for (const line of lines) {
		if (line.start < bodyStart || line.start >= contentEnd) continue;
		const value = lineText(bytes, line);
		if (start === null && value === "## Notes") {
			start = line.next;
			continue;
		}
		if (start !== null && KNOWN_SECTIONS.has(value)) {
			return { start, end: line.start };
		}
	}
	return start === null ? null : { start, end: contentEnd };
}

function hasTerm(text: string, term: string): boolean {
	const source = text.toLowerCase();
	const needle = term.toLowerCase();
	let offset = 0;
	while (offset <= source.length - needle.length) {
		const index = source.indexOf(needle, offset);
		if (index < 0) return false;
		const end = index + needle.length;
		const left = index === 0 ? undefined : source[index - 1];
		const right = end === source.length ? undefined : source[end];
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

function normalizedNotes(notes: string): string {
	const leadingLength = notes.length - notes.trimStart().length;
	const leading = notes.slice(0, leadingLength);
	const content = notes.slice(leadingLength);
	const approach = content.slice(0, "Approach:".length);
	if (approach.toLowerCase() === "approach:") {
		const suffix = content.slice("Approach:".length);
		return `${leading}Approach:${/^\s/u.test(suffix) ? suffix : ` ${suffix}`}`;
	}
	const noteWords = content.split(/\s+/u).filter((word) => word.length > 0);
	const firstWord = noteWords[0] ?? "";
	if (
		noteWords.length >= INTENT_LINT_LIMITS.approach_min_words &&
		INTENT_ACTION_VERBS.some((verb) => hasTerm(firstWord, verb))
	) {
		return `${leading}Approach: ${content}`;
	}
	return notes;
}

function replaceNotes(bytes: Uint8Array, range: ByteRange | null): Uint8Array {
	if (range === null) return bytes;
	let notes: string;
	try {
		notes = decoder.decode(bytes.subarray(range.start, range.end));
	} catch {
		return bytes;
	}
	const normalized = normalizedNotes(notes);
	if (normalized === notes) return bytes;
	const replacement = encoder.encode(normalized);
	const result = new Uint8Array(
		bytes.byteLength - (range.end - range.start) + replacement.byteLength,
	);
	result.set(bytes.subarray(0, range.start), 0);
	result.set(replacement, range.start);
	result.set(bytes.subarray(range.end), range.start + replacement.byteLength);
	return result;
}

function appendRequest(prefix: Uint8Array, request: Uint8Array): Uint8Array {
	const separator =
		prefix[prefix.byteLength - 1] === 0x0a
			? Uint8Array.of(0x0a)
			: Uint8Array.of(0x0a, 0x0a);
	const heading = encoder.encode("## Request\n");
	const result = new Uint8Array(
		prefix.byteLength +
			separator.byteLength +
			heading.byteLength +
			request.byteLength,
	);
	let offset = 0;
	result.set(prefix, offset);
	offset += prefix.byteLength;
	result.set(separator, offset);
	offset += separator.byteLength;
	result.set(heading, offset);
	offset += heading.byteLength;
	result.set(request, offset);
	return result;
}

/** Normalize Notes and append the original Request as unchanged bytes. */
export function normalizeIntentBytes(
	generatedIntent: Uint8Array,
	requestBytes: Uint8Array,
): Uint8Array {
	const generated = generatedIntent.slice();
	const lines = byteLines(generated);
	const prefixEnd = requestStart(generated, lines);
	const prefix = generated.slice(0, prefixEnd);
	const prefixLines = byteLines(prefix);
	const normalized = replaceNotes(
		prefix,
		notesRange(prefix, prefixLines, prefix.byteLength),
	);
	return appendRequest(normalized, requestBytes);
}
