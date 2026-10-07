import { posix } from "node:path";
import type { PortError } from "../../contracts/errors";
import type { FileSystemPort, ProcessPort } from "../../contracts/ports";
import type { FileSystemHostRequest } from "../../fs/read";
import {
	FILESYSTEM_MAX_ENTRIES,
	FILESYSTEM_MAX_RESPONSE_BYTES,
	FileSystemStatus,
	listDirectoryBytes,
	readToolFileBytes,
} from "../../fs/read";
import type { SessionRole } from "../session/transition";
import type { FileToolName } from "./schema";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
export const FILE_TOOL_MAX_LINES_FOR_WRITE = 200;
const FILE_READ_LIMIT = FILESYSTEM_MAX_RESPONSE_BYTES - 9;
const SEARCH_OUTPUT_LIMIT = 16 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 120_000;

export interface FileToolContext {
	readonly workspaceRoot: string;
	readonly filesystemHost: FileSystemHostRequest;
	readonly filesystem: Pick<FileSystemPort, "writeFileAtomically">;
	readonly process: Pick<ProcessPort, "run">;
	readonly processEnvironment: Readonly<Record<string, string>>;
	readonly role: SessionRole;
	/** The two exact approved targets for a shaper's writes. */
	readonly shaperWritePaths?: readonly [string, string];
	/** Literal manifest paths protected from shaper writes and edits. */
	readonly protectedPaths?: readonly string[];
	/** Optional bound supplied by the run's tool-output budget layer. */
	readonly searchOutputLimitBytes?: number;
}

type NormalizedPath =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly error: string };

function normalizeRelativePath(
	value: string,
	allowRoot: boolean,
): NormalizedPath {
	if (
		value.length === 0 ||
		value.includes("\0") ||
		value.startsWith("/") ||
		!isValidUnicode(value)
	)
		return { ok: false, error: "Path escapes the worktree." };
	const normalized = posix.normalize(value);
	if (
		normalized === ".." ||
		normalized.startsWith("../") ||
		posix.isAbsolute(normalized)
	)
		return { ok: false, error: "Path escapes the worktree." };
	if (normalized === "." && !allowRoot)
		return { ok: false, error: "ERROR: File does not exist." };
	return { ok: true, path: normalized };
}

function isValidUnicode(value: string): boolean {
	try {
		return decoder.decode(encoder.encode(value)) === value;
	} catch {
		return false;
	}
}

function rootBytes(context: FileToolContext): Uint8Array | null {
	if (
		!posix.isAbsolute(context.workspaceRoot) ||
		context.workspaceRoot.includes("\0") ||
		!isValidUnicode(context.workspaceRoot)
	)
		return null;
	return encoder.encode(context.workspaceRoot);
}

function filesystemError(error: PortError): string {
	if (error.code === "not_found") return "ERROR: File does not exist.";
	if (error.code === "permission_denied") return "Path escapes the worktree.";
	if (
		error.code === "invalid_input" ||
		(error.cause !== null &&
			typeof error.cause === "object" &&
			"status" in error.cause &&
			error.cause.status === FileSystemStatus.tooLarge)
	)
		return "ERROR: File is binary or is not UTF-8 text.";
	return "ERROR: File could not be read safely.";
}

async function readToolBytes(
	context: FileToolContext,
	path: string,
	maxBytes = FILE_READ_LIMIT,
): Promise<
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly error: string }
> {
	const root = rootBytes(context);
	if (!root)
		return { ok: false, error: "ERROR: File could not be read safely." };
	const result = await readToolFileBytes(context.filesystemHost, {
		root,
		path: encoder.encode(path),
		maxBytes,
	});
	if (!result.ok) return { ok: false, error: filesystemError(result.error) };
	return { ok: true, bytes: result.value };
}

async function readToolText(
	context: FileToolContext,
	path: string,
): Promise<
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly error: string }
> {
	const result = await readToolBytes(context, path);
	if (!result.ok) return result;
	try {
		const text = decoder.decode(result.bytes);
		if (text.includes("\0"))
			return {
				ok: false,
				error: "ERROR: File is binary or is not UTF-8 text.",
			};
		return { ok: true, text };
	} catch {
		return {
			ok: false,
			error: "ERROR: File is binary or is not UTF-8 text.",
		};
	}
}

function textLines(text: string): readonly string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r\n|\n|\r/);
	if (/(?:\r\n|\n|\r)$/.test(text)) lines.pop();
	return lines;
}

function byteLineCount(bytes: Uint8Array): number {
	if (bytes.byteLength === 0) return 0;
	let lines = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		const byte = bytes[index];
		if (byte === 0x0d) {
			lines += 1;
			if (bytes[index + 1] === 0x0a) index += 1;
		} else if (byte === 0x0a) {
			lines += 1;
		}
	}
	const last = bytes[bytes.byteLength - 1];
	if (last !== 0x0a && last !== 0x0d) lines += 1;
	return lines;
}

function readFileResult(
	path: string,
	text: string,
	offset: number,
	limit: number,
): string {
	if (limit < 1 || limit > 400)
		return "ERROR: limit must be between 1 and 400.";
	const lines = textLines(text);
	const selected = lines.slice(offset - 1, offset - 1 + limit);
	let result = `${path}:\n${selected
		.map((line, index) => `${offset + index}: ${line}`)
		.join("\n")}`;
	if (offset - 1 + selected.length < lines.length)
		result += `\n[continue with offset=${offset + selected.length}]`;
	return result;
}

type EffectiveFileToolRole = Exclude<SessionRole, "fallback_shaper">;

function effectiveRole(role: SessionRole): EffectiveFileToolRole {
	return role === "fallback_shaper" ? "shaper" : role;
}

function protectedPath(context: FileToolContext, path: string): boolean {
	if (effectiveRole(context.role) !== "shaper") return false;
	return (context.protectedPaths ?? []).some((candidate) => {
		const normalized = normalizeRelativePath(candidate, false);
		return normalized.ok && normalized.path === path;
	});
}

function shaperScopeError(
	context: FileToolContext,
	path: string,
): string | null {
	if (effectiveRole(context.role) !== "shaper") return null;
	const allowed = (context.shaperWritePaths ?? []).map((candidate) => {
		const normalized = normalizeRelativePath(candidate, false);
		return normalized.ok ? normalized.path : candidate;
	});
	if (allowed.includes(path)) return null;
	return `ERROR: Write target is outside the shaper's two-file scope. Allowed paths: ${allowed.join(", ")}.`;
}

function writeError(error: PortError): string {
	if (error.code === "permission_denied") return "Path escapes the worktree.";
	if (error.code === "not_found") return "ERROR: File does not exist.";
	return "ERROR: File could not be written safely.";
}

async function writeToolText(
	context: FileToolContext,
	path: string,
	text: string,
	checkLineLimit: boolean,
): Promise<string> {
	if (protectedPath(context, path))
		return `ERROR: ${path} is approved and protected; change the implementation instead.`;
	const scopeError = shaperScopeError(context, path);
	if (scopeError) return scopeError;
	const bytes = encoder.encode(text);
	if (!isValidUnicode(text))
		return "ERROR (invalid_arguments): Tool arguments do not match the schema.";
	if (checkLineLimit) {
		const current = await readToolBytes(context, path);
		if (
			current.ok &&
			byteLineCount(current.bytes) > FILE_TOOL_MAX_LINES_FOR_WRITE
		)
			return "ERROR: File has more than 200 lines; write refused.";
		if (!current.ok && current.error !== "ERROR: File does not exist.")
			return current.error;
	}
	const result = await context.filesystem.writeFileAtomically({
		root: context.workspaceRoot,
		path,
		bytes,
		mode: 0o600,
	});
	if (!result.ok) return writeError(result.error);
	return `Wrote ${path}.`;
}

async function readTool(
	context: FileToolContext,
	argumentsValue: Record<string, unknown>,
): Promise<string> {
	const normalized = normalizeRelativePath(
		argumentsValue.path as string,
		false,
	);
	if (!normalized.ok) return normalized.error;
	const offset = (argumentsValue.offset as number | undefined) ?? 1;
	const limit = (argumentsValue.limit as number | undefined) ?? 200;
	if (limit < 1 || limit > 400)
		return "ERROR: limit must be between 1 and 400.";
	const result = await readToolText(context, normalized.path);
	if (!result.ok) return result.error;
	return readFileResult(normalized.path, result.text, offset, limit);
}

async function searchTargetError(
	context: FileToolContext,
	path: string,
): Promise<string | null> {
	const root = rootBytes(context);
	if (!root) return "ERROR: Search failed.";
	const encodedPath = encoder.encode(path === "." ? "" : path);
	const directory = await listDirectoryBytes(
		context.filesystemHost,
		{
			root,
			path: encodedPath,
			maxEntries: FILESYSTEM_MAX_ENTRIES,
			maxNameBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 8,
		},
		true,
	);
	if (directory.ok) return null;
	if (directory.error.code === "permission_denied")
		return "Path escapes the worktree.";
	const file = await readToolFileBytes(context.filesystemHost, {
		root,
		path: encodedPath,
		maxBytes: FILE_READ_LIMIT,
	});
	if (file.ok) return null;
	if (file.error.code === "permission_denied")
		return "Path escapes the worktree.";
	if (
		file.error.cause !== null &&
		typeof file.error.cause === "object" &&
		"status" in file.error.cause &&
		file.error.cause.status === FileSystemStatus.tooLarge
	)
		return null;
	if (file.error.code === "not_found") return "No matches.";
	return "ERROR: Search path is not a readable file or directory.";
}

function processText(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}

function processOutput(result: {
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}): string {
	return processText(result.stdout) + processText(result.stderr);
}

function shouldFallbackToGrep(
	result: Awaited<ReturnType<ProcessPort["run"]>>,
): boolean {
	return (
		(!result.ok && result.error.code === "not_found") ||
		(result.ok && result.value.exitCode === 127)
	);
}

async function runSearch(
	context: FileToolContext,
	pattern: string,
	path: string,
): Promise<string> {
	const outputLimitBytes =
		context.searchOutputLimitBytes ?? SEARCH_OUTPUT_LIMIT;
	if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1)
		return "ERROR: Search failed.";
	const base = {
		cwd: context.workspaceRoot,
		env: context.processEnvironment,
		timeoutMilliseconds: SEARCH_TIMEOUT_MS,
		outputLimitBytes,
	} as const;
	const rg = await context.process.run({
		...base,
		argv: [
			"rg",
			"--line-number",
			"--with-filename",
			"--color",
			"never",
			"--",
			pattern,
			path,
		],
	});
	if (!shouldFallbackToGrep(rg)) {
		if (!rg.ok) return "ERROR: Search failed.";
		if (rg.value.exitCode === 1) return "No matches.";
		if (rg.value.exitCode !== 0) return "ERROR: Search failed.";
		return processOutput(rg.value);
	}
	const grep = await context.process.run({
		...base,
		argv: ["grep", "-r", "-n", "-H", "--", pattern, path],
	});
	if (!grep.ok) return "ERROR: Search failed.";
	if (grep.value.exitCode === 1) return "No matches.";
	if (grep.value.exitCode !== 0) return "ERROR: Search failed.";
	return processOutput(grep.value);
}

async function searchTool(
	context: FileToolContext,
	argumentsValue: Record<string, unknown>,
): Promise<string> {
	const normalized = normalizeRelativePath(
		(argumentsValue.path as string | undefined) ?? ".",
		true,
	);
	if (!normalized.ok) return normalized.error;
	const targetError = await searchTargetError(context, normalized.path);
	if (targetError) return targetError;
	return runSearch(context, argumentsValue.pattern as string, normalized.path);
}

function occurrences(text: string, pattern: string): number[] {
	const offsets: number[] = [];
	let from = 0;
	while (from <= text.length - pattern.length) {
		const found = text.indexOf(pattern, from);
		if (found < 0) break;
		offsets.push(found);
		from = found + 1;
	}
	return offsets;
}

async function editTool(
	context: FileToolContext,
	argumentsValue: Record<string, unknown>,
): Promise<string> {
	const normalized = normalizeRelativePath(
		argumentsValue.path as string,
		false,
	);
	if (!normalized.ok) return normalized.error;
	if (protectedPath(context, normalized.path))
		return `ERROR: ${normalized.path} is approved and protected; change the implementation instead.`;
	const scopeError = shaperScopeError(context, normalized.path);
	if (scopeError) return scopeError;
	const current = await readToolText(context, normalized.path);
	if (!current.ok) return current.error;
	const oldText = argumentsValue.old_text as string;
	const matches = occurrences(current.text, oldText);
	if (matches.length !== 1)
		return matches.length === 0
			? "ERROR: old_text was not found in the file."
			: "ERROR: old_text must match exactly once in the file.";
	const start = matches[0];
	if (start === undefined) return "ERROR: old_text was not found in the file.";
	const updated =
		current.text.slice(0, start) +
		(argumentsValue.new_text as string) +
		current.text.slice(start + oldText.length);
	return writeToolText(context, normalized.path, updated, false);
}

async function writeTool(
	context: FileToolContext,
	argumentsValue: Record<string, unknown>,
): Promise<string> {
	const normalized = normalizeRelativePath(
		argumentsValue.path as string,
		false,
	);
	if (!normalized.ok) return normalized.error;
	return writeToolText(
		context,
		normalized.path,
		argumentsValue.content as string,
		true,
	);
}

/** Execute one schema-validated file tool against safe filesystem/process ports. */
export async function dispatchFileTool(
	name: FileToolName,
	argumentsValue: Record<string, unknown>,
	context: FileToolContext,
): Promise<string> {
	switch (name) {
		case "read":
			return readTool(context, argumentsValue);
		case "search":
			return searchTool(context, argumentsValue);
		case "write":
			return writeTool(context, argumentsValue);
		case "edit":
			return editTool(context, argumentsValue);
	}
}
