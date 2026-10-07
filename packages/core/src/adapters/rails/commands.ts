import { isAbsolute } from "node:path";

const GEMFILE_GEM =
	/^\s*gem\s*(?:\(\s*)?(['"])(standard|rubocop)\1(?=\s|,|\)|$)/u;
const MAX_PATH_BYTES = 4096;

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validCandidatePath(path: string): boolean {
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		/[\0\r\n]/u.test(path) ||
		byteLength(path) > MAX_PATH_BYTES
	)
		return false;
	return path
		.split("/")
		.every((part) => part !== "" && part !== "." && part !== "..");
}

function uncommentRubyLine(line: string): string {
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === undefined) continue;
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\" && quote === '"') escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"') quote = character;
		else if (character === "#") return line.slice(0, index);
	}
	return line;
}

function gemfileText(value: string | Uint8Array): string | null {
	if (typeof value === "string") return value;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		return null;
	}
}

/**
 * Select the Rails formatter declared by a Gemfile. `standard` wins when both
 * gems are declared, matching the frozen adapter rule.
 */
export function railsFormatterCommand(
	gemfile: string | Uint8Array,
): readonly string[] | null {
	const text = gemfileText(gemfile);
	if (text === null) return null;
	const gems = new Set<string>();
	for (const line of text.split("\n")) {
		const match = GEMFILE_GEM.exec(uncommentRubyLine(line));
		const name = match?.[2];
		if (name !== undefined) gems.add(name);
	}
	if (gems.has("standard")) return ["bundle", "exec", "standardrb", "-a"];
	if (gems.has("rubocop")) return ["bundle", "exec", "rubocop", "-a"];
	return null;
}

/** Default Rails syntax acceptance check, suitable for `{path}` expansion by the caller. */
export function railsSyntaxCheckCommand(
	path: string,
): readonly string[] | null {
	if (!validCandidatePath(path)) return null;
	return ["ruby", "-c", path];
}

/** The default Rails acceptance command. Verbose mode provides test identities for the ledger. */
export function railsAcceptanceCommand(path: string): readonly string[] | null {
	if (!validCandidatePath(path)) return null;
	return ["bundle", "exec", "rails", "test", path, "--verbose"];
}

/** Resolve a candidate path against an absolute checkout root for safe process callers. */
export function railsCandidateAbsolutePath(
	workdir: string,
	path: string,
): string | null {
	if (
		!isAbsolute(workdir) ||
		workdir.includes("\0") ||
		!validCandidatePath(path)
	)
		return null;
	return `${workdir.replace(/\/$/u, "")}/${path}`;
}
