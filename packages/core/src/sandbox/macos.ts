import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	resolve,
} from "node:path";
import type { ProcessPort } from "../contracts/ports";
import { forcedSandboxUnavailableReason } from "./policy";

export const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
export const MACOS_SANDBOX_PROBE_TIMEOUT_MS = 5_000;
export const MACOS_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES = 4_096;

const PROBE_PROFILE = [
	"(version 1)",
	"(deny default)",
	"(allow process-fork)",
	"(allow process-exec)",
	"(allow file-read*)",
].join("\n");

const DEFAULT_CACHE_SUFFIXES = [
	".cache/mise",
	".hex",
	".cache/rebar3",
	".npm",
	".cargo/registry",
	".cargo/git",
	".cache/go-build",
] as const;

export interface MacOSSandboxPaths {
	/** Canonical checkout root. The caller supplies the checkout, never a worktree. */
	readonly checkout: string;
	/** Local origin roots, including a separate bare origin when one exists. */
	readonly origins?: readonly string[];
	readonly workspace: string;
	readonly runDirectory: string;
	readonly home: string;
	readonly authPath?: string;
	/** Additional cache roots, including GOMODCACHE when it is configured. */
	readonly cachePaths?: readonly string[];
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface MacOSSandboxProbeOptions {
	readonly process: Pick<ProcessPort, "run">;
	readonly platform?: string;
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type MacOSSandboxProbeResult =
	| { readonly available: true }
	| { readonly available: false; readonly reason: string };

function canonicalPath(path: string, label: string): string {
	if (!path || !isAbsolute(path) || path.includes("\0")) {
		throw new TypeError(`${label} must be an absolute filesystem path`);
	}
	const normalized = normalize(resolve(path));
	try {
		return realpathSync.native(normalized);
	} catch {
		// Preserve a not-yet-created cache/auth path while resolving any existing
		// symlinked parent, so profile rules follow the host's physical paths.
		const parent = dirname(normalized);
		if (parent === normalized) return normalized;
		try {
			return join(realpathSync.native(parent), basename(normalized));
		} catch {
			return normalized;
		}
	}
}

function sbplString(value: string): string {
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")}"`;
}

function sbplRegex(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function unique(paths: readonly string[]): string[] {
	return [...new Set(paths)];
}

function subpathRule(operation: string, path: string): string {
	return `(allow ${operation} (subpath ${sbplString(path)}))`;
}

function denySubpathRule(operation: string, path: string): string {
	return `(deny ${operation} (subpath ${sbplString(path)}))`;
}

/**
 * Produce an allowlisted Seatbelt profile for one Build workspace.
 *
 * Reads remain available for toolchains, while writes are allowed only in the
 * workspace, run scratch, /tmp, and the specified tool caches. Explicit deny
 * rules protect checkout/origin data and user credential locations.
 */
export function createMacOSSandboxProfile(paths: MacOSSandboxPaths): string {
	const home = canonicalPath(paths.home, "home");
	const checkout = canonicalPath(paths.checkout, "checkout");
	const workspace = canonicalPath(paths.workspace, "workspace");
	const runDirectory = canonicalPath(paths.runDirectory, "runDirectory");
	const origins = (paths.origins ?? []).map((path, index) =>
		canonicalPath(path, `origins[${index}]`),
	);
	const environment = paths.environment ?? {};
	const cachePaths = [
		...DEFAULT_CACHE_SUFFIXES.map((suffix) => join(home, suffix)),
		...(environment.GOMODCACHE ? [environment.GOMODCACHE] : []),
		...(paths.cachePaths ?? []),
	].map((path, index) => canonicalPath(path, `cachePaths[${index}]`));
	const authPath = paths.authPath
		? canonicalPath(paths.authPath, "authPath")
		: null;

	const writableRoots = unique(
		[workspace, runDirectory, "/tmp", "/private/tmp", ...cachePaths].map(
			(path, index) => canonicalPath(path, `writableRoots[${index}]`),
		),
	);
	const protectedRoots = unique([checkout, ...origins]);
	const lines = [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow file-read*)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow network*)",
		...writableRoots.map((path) => subpathRule("file-write*", path)),
		`(allow file-write* (literal ${sbplString("/dev/null")}))`,
		...protectedRoots.map((path) => denySubpathRule("file-write*", path)),
		...[
			join(home, ".ssh"),
			join(home, ".gnupg"),
			join(home, ".codex"),
			join(home, "Library", "Keychains"),
		].map((path, index) =>
			denySubpathRule(
				"file-read*",
				canonicalPath(path, `secretRoots[${index}]`),
			),
		),
		`(deny file-read* (regex ${sbplString(`^${sbplRegex(canonicalPath(join(home, ".kogen", "credentials"), "credentialPrefix"))}[^/]*(/.*)?$`)}))`,
		...(authPath
			? [`(deny file-read* (literal ${sbplString(authPath)}))`]
			: []),
		'(deny mach-lookup (global-name "com.apple.securityd"))',
	];
	return `${lines.join("\n")}\n`;
}

export function macOSSandboxCommand(
	profilePath: string,
	command: readonly string[],
): string[] {
	if (!isAbsolute(profilePath) || profilePath.includes("\0")) {
		throw new TypeError("sandbox profile path must be absolute");
	}
	if (command.length === 0 || command.some((part) => part.includes("\0"))) {
		throw new TypeError("sandboxed command must contain valid argv");
	}
	return [MACOS_SANDBOX_EXECUTABLE, "-f", profilePath, ...command];
}

function decodeReason(bytes: Uint8Array): string {
	const decoded = new TextDecoder()
		.decode(bytes)
		.replace(/[\r\n\0]/g, " ")
		.trim();
	return decoded.slice(0, 512);
}

/** Probe sandbox-exec by running a no-write command under a valid restrictive profile. */
export async function probeMacOSSandbox(
	options: MacOSSandboxProbeOptions,
): Promise<MacOSSandboxProbeResult> {
	if ((options.platform ?? process.platform) !== "darwin") {
		return {
			available: false,
			reason: "macOS sandbox is unavailable on this host",
		};
	}
	const forcedReason = forcedSandboxUnavailableReason(
		options.environment ?? {},
	);
	if (forcedReason) return { available: false, reason: forcedReason };

	const environment = {
		PATH: "/usr/bin:/bin",
		HOME: options.environment?.HOME ?? "/",
		TMPDIR: "/private/tmp",
		LANG: "C",
		LC_ALL: "C",
	};
	const run = (argv: readonly string[]) =>
		options.process.run({
			argv,
			cwd: options.cwd ?? "/",
			env: environment,
			timeoutMilliseconds: MACOS_SANDBOX_PROBE_TIMEOUT_MS,
			outputLimitBytes: MACOS_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES,
		});
	const launch = await run([
		MACOS_SANDBOX_EXECUTABLE,
		"-p",
		PROBE_PROFILE,
		"/usr/bin/true",
	]);
	if (!launch.ok) return { available: false, reason: launch.error.message };
	if (launch.value.timedOut)
		return {
			available: false,
			reason: "sandbox-exec capability probe timed out",
		};
	if (launch.value.exitCode !== 0) {
		const detail = decodeReason(launch.value.stderr);
		return {
			available: false,
			reason: detail
				? `sandbox-exec capability probe failed: ${detail}`
				: "sandbox-exec capability probe failed",
		};
	}

	// Verify that the profile actually denies writes. A unique /tmp path is safe
	// to try; if the kernel unexpectedly permits it, remove that probe file.
	const probePath = `/private/tmp/.kogen-sandbox-probe-${randomUUID()}`;
	const deniedWrite = await run([
		MACOS_SANDBOX_EXECUTABLE,
		"-p",
		PROBE_PROFILE,
		"/usr/bin/touch",
		probePath,
	]);
	if (!deniedWrite.ok) {
		return { available: false, reason: deniedWrite.error.message };
	}
	if (deniedWrite.value.timedOut) {
		return { available: false, reason: "sandbox denial probe timed out" };
	}
	const deniedReason = decodeReason(deniedWrite.value.stderr);
	if (deniedWrite.value.exitCode === 0) {
		const cleanup = await options.process.run({
			argv: ["/bin/rm", "-f", probePath],
			cwd: options.cwd ?? "/",
			env: environment,
			timeoutMilliseconds: MACOS_SANDBOX_PROBE_TIMEOUT_MS,
			outputLimitBytes: MACOS_SANDBOX_PROBE_OUTPUT_LIMIT_BYTES,
		});
		const cleanupFailed = !cleanup.ok || cleanup.value.exitCode !== 0;
		return {
			available: false,
			reason: cleanupFailed
				? "sandbox denial probe unexpectedly wrote a file and cleanup failed"
				: "sandbox-exec did not enforce file-write denial",
		};
	}
	if (!/operation not permitted|permission denied/i.test(deniedReason)) {
		return {
			available: false,
			reason: deniedReason
				? `sandbox denial probe failed: ${deniedReason}`
				: "sandbox denial probe failed without an operating-system denial",
		};
	}
	return { available: true };
}
