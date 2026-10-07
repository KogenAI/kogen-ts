import { Buffer } from "node:buffer";
import {
	accessSync,
	constants,
	lstatSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	delimiter,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../contracts/ports";

export const LINUX_SANDBOX_PROBE_TIMEOUT_MS = 5_000;
export const LINUX_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES = 4_096;

export type LinuxSandboxUnavailableCode =
	| "unsupported-host"
	| "bwrap-not-found"
	| "user-namespace-unavailable"
	| "probe-timeout"
	| "probe-failed";

export type LinuxSandboxProbe =
	| {
			readonly available: true;
			readonly bwrapPath: string;
	  }
	| {
			readonly available: false;
			readonly reason: LinuxSandboxUnavailableCode;
			readonly detail: string;
	  };

export interface LinuxSandboxProbeOptions {
	readonly process: Pick<ProcessPort, "run">;
	readonly hostPlatform?: string;
	readonly bwrapPath?: string | null;
	readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly timeoutMilliseconds?: number;
}

export interface LinuxSandboxMountOptions {
	readonly homeDirectory: string;
	readonly workspaceDirectory: string;
	readonly runDirectory: string;
	readonly checkoutDirectory: string;
	readonly originDirectory: string;
	readonly command: ProcessRequest;
	readonly writableCacheDirectories?: readonly string[];
	readonly authPath?: string | null;
	readonly userRuntimeDirectory?: string | null;
}

export interface LinuxSandboxProcessOptions extends LinuxSandboxMountOptions {
	readonly bwrapPath: string;
}

export interface SandboxUnavailableObservation {
	readonly kind: "sandbox_unavailable";
	readonly reason: string;
}

export type LinuxSandboxResolution =
	| {
			readonly mode: "off" | "already-confined";
			readonly request: ProcessRequest;
	  }
	| {
			readonly mode: "confined";
			readonly request: ProcessRequest;
	  }
	| {
			readonly mode: "unconfined";
			readonly request: ProcessRequest;
			readonly warning: string;
			readonly event: SandboxUnavailableObservation;
			readonly report: "unconfined";
	  };

export class LinuxSandboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LinuxSandboxError";
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error))
		return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function executableAt(path: string): string | null {
	try {
		const resolvedPath = realpathSync(path);
		if (!statSync(resolvedPath).isFile()) return null;
		accessSync(resolvedPath, constants.X_OK);
		return resolvedPath;
	} catch {
		return null;
	}
}

function findBwrap(
	hostEnvironment: Readonly<Record<string, string | undefined>>,
): string | null {
	const path = hostEnvironment.PATH;
	if (path === undefined) return null;
	for (const directory of path.split(delimiter)) {
		const candidate = resolve(
			directory.length === 0 ? "." : directory,
			"bwrap",
		);
		const executable = executableAt(candidate);
		if (executable !== null) return executable;
	}
	return null;
}

function resolveBwrapPath(
	value: string | null | undefined,
	hostEnvironment: Readonly<Record<string, string | undefined>>,
): string | null {
	if (value === null) return null;
	if (value === undefined) return findBwrap(hostEnvironment);
	if (!isAbsolute(value)) return null;
	return executableAt(value);
}

function decodeOutput(bytes: Uint8Array): string {
	return new TextDecoder().decode(
		bytes.subarray(0, LINUX_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES),
	);
}

function resultDetail(result: ProcessResult): string {
	return [decodeOutput(result.stderr), decodeOutput(result.stdout)]
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n")
		.slice(0, LINUX_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES)
		.replace(/[\r\n\t]+/g, " ");
}

function errorDetail(error: PortError): string {
	const message = error.message.trim().replace(/[\r\n\t]+/g, " ");
	return message.length === 0 ? error.code : message;
}

function isNamespaceFailure(detail: string): boolean {
	return /(?:user[\s-]*namespace|namespace|unshare).*(?:failed|denied|unavailable|not supported|does not support|operation not permitted|no permissions)|no permissions to create.*namespace|kernel.*does not support.*namespaces|operation not permitted|permission denied/i.test(
		detail,
	);
}

function probeArgv(bwrapPath: string): string[] {
	return [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--bind",
		"/tmp",
		"/tmp",
		"--disable-userns",
		"--cap-drop",
		"ALL",
		"--",
		"/bin/true",
	];
}

/** Probe the exact namespace and read-only-root features used by the Linux plan. */
export async function probeLinuxSandbox(
	options: LinuxSandboxProbeOptions,
): Promise<LinuxSandboxProbe> {
	const hostPlatform = options.hostPlatform ?? process.platform;
	if (hostPlatform !== "linux") {
		return {
			available: false,
			reason: "unsupported-host",
			detail: "Linux confinement requires a Linux host",
		};
	}

	const hostEnvironment = options.hostEnvironment ?? process.env;
	const bwrapPath = resolveBwrapPath(options.bwrapPath, hostEnvironment);
	if (bwrapPath === null) {
		return {
			available: false,
			reason: "bwrap-not-found",
			detail: "bubblewrap executable was not found on PATH",
		};
	}

	const request: ProcessRequest = {
		argv: probeArgv(bwrapPath),
		cwd: "/",
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		timeoutMilliseconds:
			options.timeoutMilliseconds ?? LINUX_SANDBOX_PROBE_TIMEOUT_MS,
		outputLimitBytes: LINUX_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES,
	};

	let response: Result<ProcessResult>;
	try {
		response = await options.process.run(request);
	} catch (error) {
		const detail =
			error instanceof Error
				? error.message
				: "bubblewrap probe could not start";
		return { available: false, reason: "probe-failed", detail };
	}

	if (!response.ok) {
		const detail = errorDetail(response.error);
		if (response.error.code === "not_found") {
			return { available: false, reason: "bwrap-not-found", detail };
		}
		if (
			response.error.code === "permission_denied" ||
			isNamespaceFailure(detail)
		) {
			return {
				available: false,
				reason: "user-namespace-unavailable",
				detail,
			};
		}
		return { available: false, reason: "probe-failed", detail };
	}

	if (response.value.timedOut) {
		return {
			available: false,
			reason: "probe-timeout",
			detail: "bubblewrap capability probe timed out",
		};
	}

	const detail = resultDetail(response.value);
	if (response.value.exitCode === 0 && response.value.signal === null) {
		return { available: true, bwrapPath };
	}
	if (isNamespaceFailure(detail)) {
		return {
			available: false,
			reason: "user-namespace-unavailable",
			detail: detail || "bubblewrap could not create the requested namespaces",
		};
	}
	return {
		available: false,
		reason: "probe-failed",
		detail: detail || "bubblewrap capability probe exited unsuccessfully",
	};
}

function normalizedAbsolutePath(path: string, description: string): string {
	if (!isAbsolute(path)) {
		throw new LinuxSandboxError(`${description} must be an absolute path`);
	}
	return resolve(path);
}

function existingDirectory(path: string, description: string): string {
	const normalized = normalizedAbsolutePath(path, description);
	try {
		const canonical = realpathSync(normalized);
		if (!statSync(canonical).isDirectory()) {
			throw new LinuxSandboxError(`${description} must be a directory`);
		}
		return canonical;
	} catch (error) {
		if (error instanceof LinuxSandboxError) throw error;
		throw new LinuxSandboxError(`${description} is not an existing directory`);
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function isWithinOrSame(path: string, root: string): boolean {
	const pathFromRoot = relative(root, path);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." &&
			!pathFromRoot.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromRoot))
	);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function defaultCacheDirectories(
	homeDirectory: string,
	environment: Readonly<Record<string, string>>,
): string[] {
	const candidates = [
		join(homeDirectory, ".cache/mise"),
		join(homeDirectory, ".hex"),
		join(homeDirectory, ".cache/rebar3"),
		join(homeDirectory, ".npm"),
		join(homeDirectory, ".cargo/registry"),
		join(homeDirectory, ".cargo/git"),
		join(homeDirectory, ".cache/go-build"),
	];
	const goModuleCache = environment.GOMODCACHE;
	if (goModuleCache !== undefined && isAbsolute(goModuleCache)) {
		candidates.push(goModuleCache);
	}
	return unique(
		candidates
			.filter((candidate) => exists(candidate))
			.map((candidate) => {
				try {
					return realpathSync(candidate);
				} catch {
					return "";
				}
			})
			.filter((candidate) => {
				try {
					return candidate.length > 0 && statSync(candidate).isDirectory();
				} catch {
					return false;
				}
			}),
	);
}

function missingDirectories(path: string): string[] {
	const missing: string[] = [];
	let cursor = path;
	while (!exists(cursor)) {
		missing.push(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) {
			throw new LinuxSandboxError(`cannot create sandbox mount point ${path}`);
		}
		cursor = parent;
	}
	try {
		if (!statSync(cursor).isDirectory()) {
			throw new LinuxSandboxError(
				`sandbox mount parent is not a directory: ${cursor}`,
			);
		}
	} catch (error) {
		if (error instanceof LinuxSandboxError) throw error;
		throw new LinuxSandboxError(
			`sandbox mount parent is unavailable: ${cursor}`,
		);
	}
	return missing.reverse();
}

function secretMountTarget(path: string, description: string): string {
	const normalized = normalizedAbsolutePath(path, description);
	if (!exists(normalized)) return normalized;
	try {
		return realpathSync(normalized);
	} catch {
		throw new LinuxSandboxError(`${description} has an unresolved symlink`);
	}
}

function appendHiddenDirectory(
	argv: string[],
	path: string,
	description: string,
): string {
	const normalized = secretMountTarget(path, description);
	if (!exists(normalized)) {
		for (const directory of missingDirectories(normalized)) {
			argv.push("--dir", directory);
		}
		argv.push("--tmpfs", normalized);
		return normalized;
	}

	let isDirectory: boolean;
	try {
		isDirectory = statSync(normalized).isDirectory();
	} catch {
		throw new LinuxSandboxError(`${description} is unavailable`);
	}
	if (isDirectory) {
		argv.push("--tmpfs", normalized);
		return normalized;
	}
	argv.push("--ro-bind", "/dev/null", normalized);
	return normalized;
}

function credentialPaths(homeDirectory: string): string[] {
	const base = join(homeDirectory, ".kogen");
	const result = [join(base, "credentials")];
	try {
		for (const entry of readdirSync(base)) {
			if (entry.startsWith("credentials")) result.push(join(base, entry));
		}
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	return unique(result);
}

function secretDirectories(
	options: LinuxSandboxMountOptions,
	homeDirectory: string,
): string[] {
	const userRuntimeDirectory =
		options.userRuntimeDirectory === undefined
			? (process.env.XDG_RUNTIME_DIR ??
				(typeof process.getuid === "function"
					? `/run/user/${process.getuid()}`
					: null))
			: options.userRuntimeDirectory;
	return unique([
		...credentialPaths(homeDirectory),
		join(homeDirectory, ".ssh"),
		join(homeDirectory, ".gnupg"),
		join(homeDirectory, ".codex"),
		join(homeDirectory, ".local/share/keyrings"),
		...(userRuntimeDirectory === null ? [] : [userRuntimeDirectory]),
	]);
}

function ensureNoSecretWriteMounts(
	writableDirectories: readonly string[],
	hiddenDirectories: readonly string[],
): void {
	for (const writable of writableDirectories) {
		if (writable === "/") {
			throw new LinuxSandboxError("the filesystem root cannot be writable");
		}
		for (const hidden of hiddenDirectories) {
			if (
				isWithinOrSame(writable, hidden) ||
				isWithinOrSame(hidden, writable)
			) {
				throw new LinuxSandboxError(
					"writable sandbox path overlaps a hidden credential path",
				);
			}
		}
	}
}

function ensureProtectedDirectoriesStayReadOnly(
	writableDirectories: readonly string[],
	protectedDirectories: readonly string[],
): void {
	for (const writable of writableDirectories) {
		for (const protectedDirectory of protectedDirectories) {
			if (
				isWithinOrSame(writable, protectedDirectory) ||
				isWithinOrSame(protectedDirectory, writable)
			) {
				throw new LinuxSandboxError(
					"writable sandbox path overlaps a protected checkout or origin",
				);
			}
		}
	}
}

function commandWorkingDirectory(
	command: ProcessRequest,
	workspaceDirectory: string,
): string {
	const cwd = existingDirectory(command.cwd, "command working directory");
	if (!isWithinOrSame(cwd, workspaceDirectory)) {
		throw new LinuxSandboxError(
			"command working directory must be inside the workspace",
		);
	}
	return cwd;
}

function hiddenAuthFile(
	authPath: string | null | undefined,
	hiddenDirectories: readonly string[],
): string | null {
	if (authPath === undefined || authPath === null) return null;
	const normalized = normalizedAbsolutePath(authPath, "KOGEN_AUTH_PATH");
	if (!exists(normalized)) return null;
	let canonical: string;
	try {
		canonical = realpathSync(normalized);
		if (statSync(canonical).isDirectory()) {
			throw new LinuxSandboxError("KOGEN_AUTH_PATH must name a file");
		}
	} catch (error) {
		if (error instanceof LinuxSandboxError) throw error;
		throw new LinuxSandboxError("KOGEN_AUTH_PATH is unavailable");
	}
	if (
		hiddenDirectories.some((directory) => isWithinOrSame(canonical, directory))
	)
		return null;
	return canonical;
}

/** Return the exact bwrap request for one candidate or project command. */
export function createLinuxSandboxProcessRequest(
	options: LinuxSandboxProcessOptions,
): ProcessRequest {
	const bwrapPath = normalizedAbsolutePath(options.bwrapPath, "bwrap path");
	const homeDirectory = existingDirectory(
		options.homeDirectory,
		"home directory",
	);
	const workspaceDirectory = existingDirectory(
		options.workspaceDirectory,
		"workspace directory",
	);
	const runDirectory = existingDirectory(options.runDirectory, "run directory");
	const workingDirectory = commandWorkingDirectory(
		options.command,
		workspaceDirectory,
	);
	if (options.command.argv.length === 0) {
		throw new LinuxSandboxError("sandbox command argv must not be empty");
	}
	for (const argument of options.command.argv) {
		if (argument.includes("\0")) {
			throw new LinuxSandboxError("sandbox command argv contains a NUL byte");
		}
	}

	const cacheDirectories =
		options.writableCacheDirectories ??
		defaultCacheDirectories(homeDirectory, options.command.env);
	const canonicalCaches = cacheDirectories.map((path) =>
		existingDirectory(path, "writable cache directory"),
	);
	const protectedDirectories = unique([
		existingDirectory(options.checkoutDirectory, "checkout directory"),
		existingDirectory(options.originDirectory, "origin directory"),
	]);
	const writableDirectories = unique([
		workspaceDirectory,
		runDirectory,
		...canonicalCaches,
	]).sort(
		(left, right) =>
			left.length - right.length ||
			Buffer.compare(Buffer.from(left), Buffer.from(right)),
	);

	const hiddenDirectories: string[] = [];
	const argv = [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--bind",
		"/tmp",
		"/tmp",
	];

	ensureProtectedDirectoriesStayReadOnly(
		writableDirectories,
		protectedDirectories,
	);
	for (const directory of protectedDirectories) {
		if (directory === "/") {
			throw new LinuxSandboxError(
				"the filesystem root cannot be a protected checkout or origin",
			);
		}
		argv.push("--ro-bind", directory, directory);
	}

	for (const directory of secretDirectories(options, homeDirectory)) {
		const hidden = appendHiddenDirectory(
			argv,
			directory,
			`credential directory ${directory}`,
		);
		hiddenDirectories.push(hidden);
	}

	ensureNoSecretWriteMounts(writableDirectories, hiddenDirectories);

	for (const directory of writableDirectories) {
		argv.push("--bind", directory, directory);
	}

	const authPath =
		options.authPath === undefined
			? process.env.KOGEN_AUTH_PATH
			: options.authPath;
	const authFile = hiddenAuthFile(authPath, hiddenDirectories);
	if (authFile !== null) {
		// /dev/null is readable; an empty mode-000 tmpfs denies reads entirely.
		argv.push("--perms", "000", "--tmpfs", authFile);
	}

	argv.push(
		"--disable-userns",
		"--cap-drop",
		"ALL",
		"--chdir",
		workingDirectory,
		"--",
		...options.command.argv,
	);

	return {
		...options.command,
		argv,
		cwd: "/",
	};
}

function fallbackReason(
	probe: Extract<LinuxSandboxProbe, { available: false }>,
): string {
	if (probe.reason === "user-namespace-unavailable") {
		return probe.detail.length > 0
			? `user namespaces are unavailable: ${probe.detail}`
			: "user namespaces are unavailable";
	}
	if (probe.reason === "bwrap-not-found") return "bubblewrap is unavailable";
	if (probe.reason === "unsupported-host") return probe.detail;
	if (probe.reason === "probe-timeout") return probe.detail;
	return probe.detail.length > 0
		? `bubblewrap capability probe failed: ${probe.detail}`
		: "bubblewrap capability probe failed";
}

/** Convert probe results into the observable confined or unconfined mode. */
export function resolveLinuxSandbox(
	command: ProcessRequest,
	options: {
		readonly enabled: boolean;
		readonly alreadyConfined?: boolean;
		readonly probe: LinuxSandboxProbe;
		readonly mount?: Omit<LinuxSandboxProcessOptions, "command" | "bwrapPath">;
	},
): LinuxSandboxResolution {
	if (!options.enabled) return { mode: "off", request: command };
	if (options.alreadyConfined === true) {
		return { mode: "already-confined", request: command };
	}
	if (!options.probe.available) {
		const reason = fallbackReason(options.probe);
		return {
			mode: "unconfined",
			request: command,
			warning:
				"kogen: warning: sandbox unavailable: " +
				reason +
				"; building unconfined",
			event: { kind: "sandbox_unavailable", reason },
			report: "unconfined",
		};
	}
	if (options.mount === undefined) {
		throw new LinuxSandboxError("Linux sandbox mount options are required");
	}
	return {
		mode: "confined",
		request: createLinuxSandboxProcessRequest({
			...options.mount,
			command,
			bwrapPath: options.probe.bwrapPath,
		}),
	};
}
