import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { PortError, Result } from "../contracts/errors";
import type { GitPort, ProcessResult } from "../contracts/ports";

const GIT_PROBE_TIMEOUT_MS = 30_000;
const GIT_PROBE_OUTPUT_LIMIT_BYTES = 4_096;

export type ProjectResolutionFailureCode =
	| "project_unavailable"
	| "not_a_git_repo"
	| "origin_unavailable"
	| "base_unavailable";

export interface ProjectResolutionError {
	readonly code: ProjectResolutionFailureCode;
	readonly detail: string;
	readonly cause?: PortError | unknown;
}

export interface ProjectPathPort {
	realpath(path: string): Promise<string>;
	isDirectory(path: string): Promise<boolean>;
}

export interface ProjectResolutionRequest {
	/** CLI `--project`; relative paths are anchored at `cwd`. */
	readonly project?: string;
	/** CLI `--origin`; relative paths are anchored at `cwd`. */
	readonly origin?: string;
	/** CLI `--base`. */
	readonly base?: string;
	/** Parsed `.kogen/project.yaml` base setting. */
	readonly configuredBase?: string;
	readonly cwd: string;
	readonly home?: string;
}

export interface ProjectResolutionHost {
	readonly git: Pick<GitPort, "command">;
	readonly paths: ProjectPathPort;
}

export interface ResolvedProject {
	/** Physical top-level Git worktree path. */
	readonly checkout: string;
	/** Physical repository holding approval refs and the target branch. */
	readonly origin: string;
	readonly originIsCheckout: boolean;
	/** Selected user-facing branch name or reference. */
	readonly base: string;
	/** Exact resolved ref used to find `baseSha`. */
	readonly baseRef: string;
	readonly baseSha: string;
}

type Probe =
	| { readonly kind: "ok"; readonly value: string }
	| { readonly kind: "missing" }
	| { readonly kind: "failed"; readonly error: ProjectResolutionError };

function failure(
	code: ProjectResolutionFailureCode,
	detail: string,
	cause?: PortError | unknown,
): ProjectResolutionError {
	return { code, detail, ...(cause === undefined ? {} : { cause }) };
}

function utf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

async function gitProbe(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	options: { readonly trim?: "line" | "nul" | "none" } = {},
): Promise<Probe> {
	let response: Result<ProcessResult>;
	try {
		response = await git.command({
			repository,
			argv,
			timeoutMilliseconds: GIT_PROBE_TIMEOUT_MS,
			outputLimitBytes: GIT_PROBE_OUTPUT_LIMIT_BYTES,
		});
	} catch (cause) {
		return {
			kind: "failed",
			error: failure("base_unavailable", "Git project probe failed", cause),
		};
	}
	if (!response.ok) {
		return {
			kind: "failed",
			error: failure(
				"base_unavailable",
				"Git project probe failed",
				response.error,
			),
		};
	}
	if (response.value.timedOut) {
		return {
			kind: "failed",
			error: failure("base_unavailable", "Git project probe timed out"),
		};
	}
	if (response.value.exitCode !== 0) return { kind: "missing" };
	let value = utf8(response.value.stdout);
	if (value === null) {
		return {
			kind: "failed",
			error: failure(
				"base_unavailable",
				"Git returned non-UTF-8 project metadata",
			),
		};
	}
	if (options.trim === "nul") {
		if (value.endsWith("\0")) value = value.slice(0, -1);
	} else if (options.trim === "line" || options.trim === undefined) {
		value = value.replace(/[\r\n]+$/u, "");
	}
	if (value.includes("\0")) {
		return {
			kind: "failed",
			error: failure(
				"base_unavailable",
				"Git returned invalid project metadata",
			),
		};
	}
	return value.length === 0 ? { kind: "missing" } : { kind: "ok", value };
}

async function canonicalDirectory(
	paths: ProjectPathPort,
	path: string,
): Promise<string | null> {
	try {
		const canonical = await paths.realpath(path);
		return (await paths.isDirectory(canonical)) ? canonical : null;
	} catch {
		return null;
	}
}

async function isGitRepository(
	git: Pick<GitPort, "command">,
	path: string,
): Promise<boolean> {
	return (await gitProbe(git, path, ["rev-parse", "--git-dir"])).kind === "ok";
}

async function canonicalCheckout(
	request: ProjectResolutionRequest,
	host: ProjectResolutionHost,
): Promise<string | ProjectResolutionError> {
	const requested = request.project ?? request.cwd;
	const candidate = isAbsolute(requested)
		? requested
		: resolvePath(request.cwd, requested);
	const directory = await canonicalDirectory(host.paths, candidate);
	if (directory === null) return failure("project_unavailable", candidate);
	const topLevel = await gitProbe(host.git, directory, [
		"rev-parse",
		"--show-toplevel",
	]);
	if (topLevel.kind === "failed") return topLevel.error;
	if (topLevel.kind !== "ok") return failure("not_a_git_repo", directory);
	const canonical = await canonicalDirectory(host.paths, topLevel.value);
	if (canonical === null) return failure("project_unavailable", topLevel.value);
	return canonical;
}

function remoteToLocalPath(
	remote: string,
	checkout: string,
	request: ProjectResolutionRequest,
): string | null {
	if (remote.startsWith("file://")) {
		try {
			const url = new URL(remote);
			if (
				url.protocol !== "file:" ||
				(url.hostname !== "" && url.hostname !== "localhost") ||
				url.username !== "" ||
				url.password !== "" ||
				url.port !== "" ||
				url.search !== "" ||
				url.hash !== ""
			) {
				return null;
			}
			return fileURLToPath(url);
		} catch {
			return null;
		}
	}
	if (
		/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(remote) ||
		/^[^/\\]+@[^/:\\]+:/u.test(remote)
	) {
		return null;
	}
	if (remote.startsWith("~/")) {
		const home = request.home ?? process.env.HOME;
		if (home === undefined || home.length === 0) return null;
		return resolvePath(home, remote.slice(2));
	}
	return isAbsolute(remote) ? remote : resolvePath(checkout, remote);
}

async function resolveOrigin(
	request: ProjectResolutionRequest,
	checkout: string,
	host: ProjectResolutionHost,
): Promise<string | ProjectResolutionError> {
	if (request.origin !== undefined) {
		const candidate = isAbsolute(request.origin)
			? request.origin
			: resolvePath(request.cwd, request.origin);
		const canonical = await canonicalDirectory(host.paths, candidate);
		if (canonical === null) return failure("origin_unavailable", candidate);
		if (!(await isGitRepository(host.git, canonical))) {
			return failure("origin_unavailable", canonical);
		}
		return canonical;
	}

	const remote = await gitProbe(
		host.git,
		checkout,
		["config", "--local", "--null", "--get", "remote.origin.url"],
		{ trim: "nul" },
	);
	if (remote.kind === "failed") return remote.error;
	if (remote.kind === "ok") {
		const localPath = remoteToLocalPath(remote.value, checkout, request);
		if (localPath !== null) {
			const canonical = await canonicalDirectory(host.paths, localPath);
			if (canonical !== null && (await isGitRepository(host.git, canonical))) {
				return canonical;
			}
		}
	}
	return checkout;
}

function branchName(reference: string, prefix: string): string | null {
	return reference.startsWith(prefix) && reference.length > prefix.length
		? reference.slice(prefix.length)
		: null;
}

async function defaultBase(
	checkout: string,
	origin: string,
	originIsCheckout: boolean,
	host: ProjectResolutionHost,
): Promise<
	| { readonly base: string; readonly ref: string }
	| null
	| ProjectResolutionError
> {
	if (originIsCheckout) {
		const remoteHead = await gitProbe(host.git, checkout, [
			"symbolic-ref",
			"--quiet",
			"refs/remotes/origin/HEAD",
		]);
		if (remoteHead.kind === "failed") return remoteHead.error;
		if (remoteHead.kind === "ok") {
			const name = branchName(remoteHead.value, "refs/remotes/origin/");
			if (name !== null) return { base: name, ref: remoteHead.value };
		}
	} else {
		const originHead = await gitProbe(host.git, origin, [
			"symbolic-ref",
			"--quiet",
			"HEAD",
		]);
		if (originHead.kind === "failed") return originHead.error;
		if (originHead.kind === "ok") {
			const name = branchName(originHead.value, "refs/heads/");
			if (name !== null) return { base: name, ref: originHead.value };
		}
	}

	const currentBranch = await gitProbe(host.git, checkout, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	if (currentBranch.kind === "failed") return currentBranch.error;
	if (currentBranch.kind === "ok") {
		return {
			base: currentBranch.value,
			ref: `refs/heads/${currentBranch.value}`,
		};
	}
	return null;
}

async function resolveBaseRef(
	base: string,
	origin: string,
	originIsCheckout: boolean,
	host: ProjectResolutionHost,
): Promise<
	{ readonly ref: string; readonly sha: string } | null | ProjectResolutionError
> {
	if (
		base.length === 0 ||
		/[\0\r\n]/u.test(base) ||
		base.endsWith("^{commit}")
	) {
		return null;
	}
	if (
		base.startsWith("refs/") &&
		!base.startsWith("refs/heads/") &&
		!(originIsCheckout && base.startsWith("refs/remotes/origin/"))
	) {
		return null;
	}
	const candidates = base.startsWith("refs/")
		? [base]
		: [
				`refs/heads/${base}`,
				...(originIsCheckout ? [`refs/remotes/origin/${base}`] : []),
			];
	for (const ref of candidates) {
		const resolved = await gitProbe(host.git, origin, [
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${ref}^{commit}`,
		]);
		if (resolved.kind === "failed") return resolved.error;
		if (resolved.kind !== "ok") continue;
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(resolved.value)) {
			return failure(
				"base_unavailable",
				"Git returned an invalid base object id",
			);
		}
		return { ref, sha: resolved.value };
	}
	return null;
}

/** Resolve canonical checkout, local origin and exact base without fetching. */
export async function resolveProject(
	request: ProjectResolutionRequest,
	host: ProjectResolutionHost,
): Promise<Result<ResolvedProject, ProjectResolutionError>> {
	const checkout = await canonicalCheckout(request, host);
	if (typeof checkout !== "string") return { ok: false, error: checkout };
	const origin = await resolveOrigin(request, checkout, host);
	if (typeof origin !== "string") return { ok: false, error: origin };
	const originIsCheckout = origin === checkout;
	const selectedBase = request.base ?? request.configuredBase;
	let baseName: string;
	let proposedRef: string | undefined;
	if (selectedBase !== undefined) {
		baseName = selectedBase;
	} else {
		const fallback = await defaultBase(
			checkout,
			origin,
			originIsCheckout,
			host,
		);
		if (fallback instanceof Object && "code" in fallback) {
			return { ok: false, error: fallback };
		}
		if (fallback === null) {
			return {
				ok: false,
				error: failure(
					"base_unavailable",
					"no configured or current branch is available",
				),
			};
		}
		baseName = fallback.base;
		proposedRef = fallback.ref;
	}
	const resolved =
		proposedRef === undefined
			? await resolveBaseRef(baseName, origin, originIsCheckout, host)
			: await resolveBaseRef(proposedRef, origin, originIsCheckout, host);
	if (resolved instanceof Object && "code" in resolved) {
		return { ok: false, error: resolved };
	}
	if (resolved === null) {
		return { ok: false, error: failure("base_unavailable", baseName) };
	}
	return {
		ok: true,
		value: {
			checkout,
			origin,
			originIsCheckout,
			base: baseName,
			baseRef: resolved.ref,
			baseSha: resolved.sha,
		},
	};
}

/** Build the v1.3 state-root key from the already canonical checkout path. */
export function projectStateRootKey(canonicalCheckout: string): string {
	const name = basename(canonicalCheckout)
		.replace(/[^A-Za-z0-9._-]+/gu, "-")
		.slice(0, 40);
	const safeName = name.length === 0 ? "checkout" : name;
	const digest = createHash("sha256")
		.update(canonicalCheckout, "utf8")
		.digest("hex")
		.slice(0, 10);
	return `${safeName}-${digest}`;
}

export function projectStateRootPath(
	home: string,
	canonicalCheckout: string,
): string {
	return join(
		home,
		".kogen",
		"workspaces",
		projectStateRootKey(canonicalCheckout),
	);
}

/** Node-backed path adapter for controller composition and local integrations. */
export const nodeProjectPathPort: ProjectPathPort = {
	realpath(path) {
		return realpath(path);
	},
	async isDirectory(path) {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	},
};
