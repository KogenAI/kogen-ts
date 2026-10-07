import { createHash } from "node:crypto";
import type { PortError, Result } from "../contracts/errors";
import { GIT_MAX_OUTPUT_LIMIT_BYTES } from "../git/command";
import type { PrivateGitRepository } from "../git/repository";
import type { CheckSpec, ProjectConfig } from "../project/schema";

export const ABSENT_PROTECTED_SHA256 = createHash("sha256")
	.update("kogen:absent", "utf8")
	.digest("hex");

const MAX_PROTECTED_PATH_BYTES = 4096;

export interface ProtectedGlob {
	readonly pattern: string;
	readonly matches: (path: string) => boolean;
}

export type ProtectedManifestEntry =
	| {
			readonly path: string;
			readonly sha256: string;
			readonly source: "base" | "approved";
			readonly kind: "regular" | "symlink";
			readonly mode: "100644" | "100755" | "120000";
			readonly objectId: string;
			readonly bytes: Uint8Array;
	  }
	| {
			readonly path: string;
			readonly sha256: typeof ABSENT_PROTECTED_SHA256;
			readonly source: "absent";
			readonly kind: "absent";
			readonly mode: null;
			readonly objectId: null;
			readonly bytes: null;
	  };

export interface ProtectedManifest {
	/** Serialize this exact path-to-SHA map as approval.json.protected_manifest. */
	readonly hashes: Readonly<Record<string, string>>;
	/** Internal restore source data; this does not change the approval JSON shape. */
	readonly entries: readonly ProtectedManifestEntry[];
	/** Retained so newly created paths matching a protected glob can be removed. */
	readonly patterns: readonly ProtectedGlob[];
	readonly baseCommit: string;
	readonly ownPaths: readonly string[];
	/** Directories which must exist to safely restore protected base paths. */
	readonly baseDirectories: readonly string[];
}

export interface BuildProtectedManifestRequest {
	readonly repository: Pick<
		PrivateGitRepository,
		"objectFormat" | "command" | "hashObject"
	>;
	readonly sourceRepository: string;
	readonly baseCommit: string;
	readonly project: Pick<
		ProjectConfig,
		| "protectedPaths"
		| "gatePaths"
		| "checks"
		| "acceptanceChecks"
		| "fix"
		| "acceptance"
	>;
	readonly changesGate: boolean;
	readonly intentPath: string;
	readonly intentBytes: Uint8Array;
	readonly testPath: string;
	readonly testBytes: Uint8Array;
	/** Current checkout file paths preserve absent untracked gate/glob paths. */
	readonly checkoutPaths?: readonly string[];
}

interface GitTreeEntry {
	readonly path: string;
	readonly mode: string;
	readonly type: string;
	readonly objectId: string;
}

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function utf8Bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function compareUtf8(left: string, right: string): number {
	const a = utf8Bytes(left);
	const b = utf8Bytes(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function validRelativePath(value: string, allowTrailingSlash = false): boolean {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		utf8Bytes(value).byteLength > MAX_PROTECTED_PATH_BYTES
	)
		return false;
	const withoutTrailing = allowTrailingSlash
		? value.replace(/\/$/u, "")
		: value;
	if (withoutTrailing.length === 0) return false;
	return withoutTrailing
		.split("/")
		.every(
			(component) =>
				component.length > 0 &&
				component !== "." &&
				component !== ".." &&
				component !== ".git",
		);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function parseClass(
	pattern: string,
	start: number,
): Result<{
	readonly source: string;
	readonly next: number;
}> {
	let index = start + 1;
	let negate = false;
	if (pattern[index] === "!" || pattern[index] === "^") {
		negate = true;
		index += 1;
	}
	let content = "";
	let closed = false;
	for (; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "]") {
			closed = true;
			break;
		}
		if (character === "/")
			return {
				ok: false,
				error: error(
					"invalid_input",
					"Protected glob character classes cannot match `/`.",
				),
			};
		if (character === "\\") content += "\\\\";
		else if (character === "[") content += "\\[";
		else if (character === "^") content += "\\^";
		else content += character;
	}
	if (!closed || content.length === 0)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Protected glob has an invalid character class.",
			),
		};
	return {
		ok: true,
		value: { source: `[${negate ? "^" : ""}${content}]`, next: index + 1 },
	};
}

function compileFragment(pattern: string): Result<string> {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:[^/]+/)*";
					index += 2;
				} else {
					source += "[\\s\\S]*";
					index += 1;
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			continue;
		}
		if (character === "[") {
			const parsed = parseClass(pattern, index);
			if (!parsed.ok) return parsed;
			source += parsed.value.source;
			index = parsed.value.next - 1;
			continue;
		}
		if (character === "{") {
			let depth = 1;
			let end = index + 1;
			for (; end < pattern.length && depth > 0; end += 1) {
				if (pattern[end] === "{") depth += 1;
				else if (pattern[end] === "}") depth -= 1;
			}
			if (depth !== 0)
				return {
					ok: false,
					error: error(
						"invalid_input",
						"Protected glob has an unclosed brace alternative.",
					),
				};
			const body = pattern.slice(index + 1, end - 1);
			const alternatives: string[] = [];
			let partStart = 0;
			let nested = 0;
			for (let partIndex = 0; partIndex < body.length; partIndex += 1) {
				if (body[partIndex] === "{") nested += 1;
				else if (body[partIndex] === "}") nested -= 1;
				else if (body[partIndex] === "," && nested === 0) {
					alternatives.push(body.slice(partStart, partIndex));
					partStart = partIndex + 1;
				}
			}
			alternatives.push(body.slice(partStart));
			if (
				alternatives.length < 2 ||
				alternatives.some((item) => item.length === 0)
			)
				return {
					ok: false,
					error: error(
						"invalid_input",
						"Protected glob has invalid brace alternatives.",
					),
				};
			const compiled: string[] = [];
			for (const alternative of alternatives) {
				const part = compileFragment(alternative);
				if (!part.ok) return part;
				compiled.push(part.value);
			}
			source += `(?:${compiled.join("|")})`;
			index = end - 1;
			continue;
		}
		if (character === "}")
			return {
				ok: false,
				error: error(
					"invalid_input",
					"Protected glob has an unmatched closing brace.",
				),
			};
		source += escapeRegex(character ?? "");
	}
	return { ok: true, value: source };
}

/** Compile the frozen protected-path glob syntax; dotfiles have no special case. */
export function compileProtectedGlob(pattern: string): Result<ProtectedGlob> {
	const normalized = pattern.replace(/^(?:\.\/)+/u, "");
	if (!validRelativePath(normalized, true))
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Protected path pattern is invalid: ${pattern}`,
			),
		};
	const trailingSlash = normalized.endsWith("/");
	const body = trailingSlash ? normalized.slice(0, -1) : normalized;
	const fragment = compileFragment(body);
	if (!fragment.ok) return fragment;
	let expression: RegExp;
	try {
		expression = new RegExp(
			`^${fragment.value}${trailingSlash ? "(?:/[\\s\\S]*)?" : ""}$`,
			"u",
		);
	} catch {
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Protected path pattern is invalid: ${pattern}`,
			),
		};
	}
	return {
		ok: true,
		value: { pattern: normalized, matches: (path) => expression.test(path) },
	};
}

export function isLiteralProtectedPattern(pattern: string): boolean {
	const body = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	return !/[?*[{]/u.test(body);
}

export function matchesProtectedPath(
	patterns: readonly ProtectedGlob[],
	path: string,
): boolean {
	return patterns.some((pattern) => pattern.matches(path));
}

function parseTreeEntries(
	bytes: Uint8Array,
	objectFormat: "sha1" | "sha256",
): Result<readonly GitTreeEntry[]> {
	if (bytes.byteLength === 0) return { ok: true, value: [] };
	if (bytes[bytes.byteLength - 1] !== 0)
		return {
			ok: false,
			error: error("unknown", "Git returned an unterminated base-tree path."),
		};
	const entries: GitTreeEntry[] = [];
	const objectIdLength = objectFormat === "sha1" ? 40 : 64;
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0) continue;
		const record = bytes.subarray(start, index);
		start = index + 1;
		let tab = -1;
		for (let offset = 0; offset < record.byteLength; offset += 1) {
			if (record[offset] === 0x09) {
				tab = offset;
				break;
			}
		}
		if (tab < 0)
			return {
				ok: false,
				error: error("unknown", "Git returned a malformed base-tree entry."),
			};
		let header: string;
		let path: string;
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			header = decoder.decode(record.subarray(0, tab));
			path = decoder.decode(record.subarray(tab + 1));
		} catch {
			return {
				ok: false,
				error: error(
					"invalid_input",
					"The protected base contains a path that cannot be represented as UTF-8.",
				),
			};
		}
		const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]+)$/u.exec(header);
		const mode = match?.[1];
		const type = match?.[2];
		const objectId = match?.[3];
		if (
			mode === undefined ||
			type === undefined ||
			objectId === undefined ||
			objectId.length !== objectIdLength ||
			!/^[0-9a-f]+$/u.test(objectId)
		)
			return {
				ok: false,
				error: error("unknown", "Git returned an invalid base-tree entry."),
			};
		if (!validRelativePath(path))
			return {
				ok: false,
				error: error("unknown", "Git returned an unsafe base-tree path."),
			};
		entries.push({ path, mode, type, objectId });
	}
	return { ok: true, value: entries };
}

async function readBaseTree(
	repository: BuildProtectedManifestRequest["repository"],
	baseCommit: string,
): Promise<Result<readonly GitTreeEntry[]>> {
	const tree = await repository.command(
		["ls-tree", "-rz", "--full-tree", baseCommit],
		{
			outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES,
		},
	);
	if (!tree.ok) return tree;
	if (tree.value.timedOut)
		return {
			ok: false,
			error: error(
				"timeout",
				"Reading the protected base tree timed out.",
				true,
			),
		};
	if (tree.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Reading the protected base tree failed with exit ${tree.value.exitCode}.`,
				true,
			),
		};
	return parseTreeEntries(tree.value.stdout, repository.objectFormat);
}

async function readBlob(
	repository: BuildProtectedManifestRequest["repository"],
	entry: GitTreeEntry,
): Promise<Result<Uint8Array>> {
	if (
		entry.type !== "blob" ||
		!["100644", "100755", "120000"].includes(entry.mode)
	)
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Protected path is not a regular file or symlink: ${entry.path}`,
			),
		};
	const blob = await repository.command(["cat-file", "blob", entry.objectId], {
		outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES,
	});
	if (!blob.ok) return blob;
	if (blob.value.timedOut)
		return {
			ok: false,
			error: error(
				"timeout",
				`Reading protected path timed out: ${entry.path}`,
				true,
			),
		};
	if (blob.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Reading protected path failed: ${entry.path}`,
				true,
			),
		};
	return { ok: true, value: blob.value.stdout.slice() };
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function parentDirectories(path: string): readonly string[] {
	const parts = path.split("/");
	const result: string[] = [];
	for (let index = 1; index < parts.length; index += 1)
		result.push(parts.slice(0, index).join("/"));
	return result;
}

function directorySet(paths: readonly string[]): Set<string> {
	const result = new Set<string>();
	for (const path of paths) {
		for (const parent of parentDirectories(path)) result.add(parent);
	}
	return result;
}

function stripDotSlash(path: string): string {
	return path.replace(/^(?:\.\/)+/u, "");
}

function validProgramPath(path: string): boolean {
	return validRelativePath(path);
}

function firstNonOption(argv: readonly string[]): string | undefined {
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== undefined && !argument.startsWith("-")) return argument;
	}
	return undefined;
}

function commandProgramCandidates(spec: CheckSpec): readonly string[] {
	const executable = spec.argv[0];
	if (executable === undefined) return [];
	const name = executable.split("/").at(-1) ?? executable;
	if (name === "make") return ["Makefile", "GNUmakefile", "makefile"];
	if (
		[
			"sh",
			"bash",
			"zsh",
			"dash",
			"python",
			"python3",
			"ruby",
			"node",
			"perl",
			"elixir",
			"escript",
		].includes(name)
	) {
		const program = firstNonOption(spec.argv);
		return program === undefined ? [] : [stripDotSlash(program)];
	}
	return [stripDotSlash(executable)];
}

function programCandidates(
	project: BuildProtectedManifestRequest["project"],
): readonly string[] {
	const candidates = new Set<string>();
	for (const check of [
		...project.checks,
		...project.acceptanceChecks,
		...project.fix,
	])
		for (const path of commandProgramCandidates(check)) candidates.add(path);
	const acceptanceArgv = project.acceptance.run;
	if (acceptanceArgv !== undefined && acceptanceArgv.length > 0) {
		// `acceptance.run` is argv rather than a CheckSpec. It follows the same
		// interpreter/make/executable resolution, without a timeout field.
		for (const path of commandProgramCandidates({
			name: "acceptance",
			argv: acceptanceArgv,
			timeoutMs: 1,
		}))
			candidates.add(path);
	}
	return [...candidates].filter(validProgramPath).sort(compareUtf8);
}

function compiledPatterns(
	patterns: readonly string[],
): Result<readonly ProtectedGlob[]> {
	const compiled: ProtectedGlob[] = [];
	for (const pattern of patterns) {
		const value = compileProtectedGlob(pattern);
		if (!value.ok) return value;
		compiled.push(value.value);
	}
	return { ok: true, value: compiled };
}

/**
 * Build the v1.3 protected manifest from the saved origin base, never from
 * mutable checkout bytes. Own Intent/test entries use their approved bytes.
 */
export async function buildProtectedManifest(
	request: BuildProtectedManifestRequest,
): Promise<Result<ProtectedManifest>> {
	const oidLength = request.repository.objectFormat === "sha1" ? 40 : 64;
	if (
		request.baseCommit.length !== oidLength ||
		!/^[0-9a-f]+$/u.test(request.baseCommit) ||
		!validRelativePath(request.intentPath) ||
		!validRelativePath(request.testPath) ||
		request.intentPath === request.testPath
	)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Protected manifest base or own paths are invalid.",
			),
		};
	const fetched = await request.repository.command([
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		request.sourceRepository,
		request.baseCommit,
	]);
	if (!fetched.ok) return fetched;
	if (fetched.value.timedOut)
		return {
			ok: false,
			error: error(
				"timeout",
				"Fetching the protected base commit timed out.",
				true,
			),
		};
	if (fetched.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Fetching the protected base commit failed with exit ${fetched.value.exitCode}.`,
				true,
			),
		};

	const treeResult = await readBaseTree(request.repository, request.baseCommit);
	if (!treeResult.ok) return treeResult;
	const tree = new Map(treeResult.value.map((entry) => [entry.path, entry]));
	const basePaths = [...tree.keys()];
	const allBaseDirectories = directorySet(basePaths);
	const checkoutPaths = request.checkoutPaths ?? [];
	for (const path of checkoutPaths)
		if (!validRelativePath(path))
			return {
				ok: false,
				error: error("invalid_input", `Checkout path is invalid: ${path}`),
			};
	const checkoutDirectories = directorySet(checkoutPaths);
	const rawPatterns = [
		...request.project.protectedPaths,
		...(request.changesGate ? [] : request.project.gatePaths),
	];
	const patternResult = compiledPatterns(rawPatterns);
	if (!patternResult.ok) return patternResult;
	const patterns = patternResult.value;
	const candidatePaths = new Set<string>();

	// All base-tree paths selected by a protected pattern get their origin bytes.
	for (const path of basePaths)
		if (matchesProtectedPath(patterns, path)) candidatePaths.add(path);

	// A protected path present only in the checkout is explicitly recorded as
	// absent in the base, so approval's stale-check cannot silently accept it.
	for (const path of checkoutPaths)
		if (matchesProtectedPath(patterns, path)) candidatePaths.add(path);

	for (const pattern of rawPatterns) {
		const normalized = stripDotSlash(pattern);
		if (!isLiteralProtectedPattern(normalized)) continue;
		if (
			allBaseDirectories.has(normalized) ||
			checkoutDirectories.has(normalized)
		)
			continue;
		if (!validRelativePath(normalized))
			return {
				ok: false,
				error: error(
					"invalid_input",
					`Protected literal path is invalid: ${pattern}`,
				),
			};
		candidatePaths.add(normalized);
	}

	const gatePaths = request.changesGate
		? []
		: [
				".kogen/project.yaml",
				...request.project.gatePaths.map(stripDotSlash),
				...programCandidates(request.project),
			];
	for (const path of gatePaths) {
		const compiled = compileProtectedGlob(path);
		if (!compiled.ok) return compiled;
		if (/[?*[{]/u.test(path)) {
			for (const candidate of basePaths)
				if (compiled.value.matches(candidate)) candidatePaths.add(candidate);
			for (const candidate of checkoutPaths)
				if (compiled.value.matches(candidate)) candidatePaths.add(candidate);
			continue;
		}
		if (
			path === ".kogen/project.yaml" ||
			tree.has(path) ||
			checkoutPaths.includes(path)
		)
			candidatePaths.add(path);
	}

	const entries: ProtectedManifestEntry[] = [];
	const hashes: Record<string, string> = Object.create(null);
	for (const path of [...candidatePaths].sort(compareUtf8)) {
		if (path === request.intentPath || path === request.testPath) continue;
		const origin = tree.get(path);
		if (origin === undefined) {
			const absent: ProtectedManifestEntry = {
				path,
				sha256: ABSENT_PROTECTED_SHA256,
				source: "absent",
				kind: "absent",
				mode: null,
				objectId: null,
				bytes: null,
			};
			entries.push(absent);
			hashes[path] = absent.sha256;
			continue;
		}
		const blob = await readBlob(request.repository, origin);
		if (!blob.ok) return blob;
		const kind = origin.mode === "120000" ? "symlink" : "regular";
		const entry: ProtectedManifestEntry = {
			path,
			sha256: sha256(blob.value),
			source: "base",
			kind,
			mode: origin.mode as "100644" | "100755" | "120000",
			objectId: origin.objectId,
			bytes: blob.value,
		};
		entries.push(entry);
		hashes[path] = entry.sha256;
	}

	for (const [path, bytes] of [
		[request.intentPath, request.intentBytes],
		[request.testPath, request.testBytes],
	] as const) {
		const object = await request.repository.hashObject(bytes);
		if (!object.ok) return object;
		const entry: ProtectedManifestEntry = {
			path,
			sha256: sha256(bytes),
			source: "approved",
			kind: "regular",
			mode: "100644",
			objectId: object.value,
			bytes: bytes.slice(),
		};
		entries.push(entry);
		hashes[path] = entry.sha256;
	}

	entries.sort((left, right) => compareUtf8(left.path, right.path));
	const protectedDirectories = new Set<string>();
	for (const path of [...candidatePaths, request.intentPath, request.testPath])
		for (const parent of parentDirectories(path))
			if (allBaseDirectories.has(parent)) protectedDirectories.add(parent);
	return {
		ok: true,
		value: {
			hashes,
			entries,
			patterns,
			baseCommit: request.baseCommit,
			ownPaths: [request.intentPath, request.testPath].sort(compareUtf8),
			baseDirectories: [...protectedDirectories].sort(compareUtf8),
		},
	};
}

/** Effective check program paths under §2.5.2, useful to local policy tests. */
export function effectiveGateProgramPaths(
	project: BuildProtectedManifestRequest["project"],
): readonly string[] {
	return programCandidates(project);
}
