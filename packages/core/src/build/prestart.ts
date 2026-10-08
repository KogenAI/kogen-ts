import type { PortError, Result } from "../contracts/errors";
import type { GitPort, ProcessResult } from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../git/command";
import {
	type IntentPredicate,
	isValidIntentSlug,
	parseIntent,
} from "../intent/parse";
import {
	type CheckedPredicate,
	checkIntentPredicates,
	intentPredicates,
	PREDICATE_FILE_MAX_BYTES,
} from "../intent/predicates";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TRAILER_LOG_FORMAT =
	"--format=%H%x1f%(trailers:key=Kogen-Intent,valueonly)%x1e";

export interface BuildPrestartBase {
	readonly commit: string;
	readonly tree: string;
}

export interface BuildPrestartRecheckedEvent {
	readonly event: "shaping_rechecked";
	readonly base: string;
	readonly predicates: readonly IntentPredicate[];
	readonly dependency_commits: readonly {
		readonly slug: string;
		readonly commit: string;
	}[];
}

export interface BuildPrestartStaleEvent {
	readonly event: "shaping_stale";
	readonly name: string;
	readonly path: string;
}

export type BuildPrestartResult =
	| { readonly kind: "skipped" }
	| {
			readonly kind: "ready";
			readonly checked: readonly CheckedPredicate[];
			readonly event: BuildPrestartRecheckedEvent;
	  }
	| {
			readonly kind: "stale";
			readonly event: BuildPrestartStaleEvent;
			readonly reason: "intent/shaping_stale";
			readonly statusDetail: string;
	  }
	| {
			readonly kind: "blocked";
			readonly missingDependencies: readonly string[];
			readonly statusDetail: string;
	  }
	| {
			readonly kind: "invalid";
			readonly message: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly message: string;
			readonly cause?: PortError;
	  };

export interface BuildPrestartRequest {
	readonly git: Pick<GitPort, "command">;
	readonly origin: string;
	readonly approval: { readonly intentBytes: Uint8Array };
	readonly base: BuildPrestartBase;
}

function invalid(message: string): BuildPrestartResult {
	return { kind: "invalid", message };
}

function portError(
	code: PortError["code"],
	message: string,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable: code === "io" || code === "timeout" || code === "unavailable",
		...(cause === undefined ? {} : { cause }),
	};
}

function gitRequest(
	origin: string,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
) {
	return {
		repository: origin,
		argv,
		timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
		outputLimitBytes,
	};
}

async function runGit(
	git: Pick<GitPort, "command">,
	origin: string,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await git.command(gitRequest(origin, argv, outputLimitBytes));
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				cause instanceof Error
					? `Build pre-start Git query failed: ${cause.message}`
					: "Build pre-start Git query failed.",
				cause,
			),
		};
	}
}

function completed(result: ProcessResult, action: string): PortError | null {
	if (result.timedOut)
		return portError("timeout", `Git timed out while ${action}.`);
	if (result.signal !== null || result.exitCode === null)
		return portError("unavailable", `Git was interrupted while ${action}.`);
	return null;
}

async function readBaseFile(
	git: Pick<GitPort, "command">,
	origin: string,
	baseCommit: string,
	path: string,
): Promise<Result<Uint8Array>> {
	const result = await runGit(
		git,
		origin,
		["cat-file", "blob", `${baseCommit}:${path}`],
		Math.min(PREDICATE_FILE_MAX_BYTES, GIT_MAX_OUTPUT_LIMIT_BYTES),
	);
	if (!result.ok) return result;
	const failure = completed(result.value, `reading predicate path ${path}`);
	if (failure !== null) return { ok: false, error: failure };
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: portError("not_found", `Base path ${path} is missing.`),
		};
	return { ok: true, value: result.value.stdout.slice() };
}

function parseDependencyLog(bytes: Uint8Array): Map<string, string> | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const landed = new Map<string, string>();
	for (const rawRecord of text.split("\u001e")) {
		const record = rawRecord.replace(/^\n+/u, "").replace(/\n+$/u, "");
		if (record.length === 0) continue;
		const separator = record.indexOf("\u001f");
		if (separator < 0) return null;
		const commit = record.slice(0, separator);
		if (!OBJECT_ID.test(commit)) return null;
		const trailerValues = record.slice(separator + 1);
		for (const slug of trailerValues.split("\n")) {
			if (isValidIntentSlug(slug) && !landed.has(slug))
				landed.set(slug, commit);
		}
	}
	return landed;
}

async function readDependencyCommits(
	request: BuildPrestartRequest,
	dependencies: readonly string[],
): Promise<Result<ReadonlyMap<string, string>>> {
	if (dependencies.length === 0)
		return { ok: true, value: new Map<string, string>() };
	const result = await runGit(request.git, request.origin, [
		"log",
		TRAILER_LOG_FORMAT,
		"--grep=^Kogen-Intent:",
		request.base.commit,
	]);
	if (!result.ok) return result;
	const failure = completed(result.value, "checking landed dependencies");
	if (failure !== null) return { ok: false, error: failure };
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: portError(
				"unavailable",
				"Git could not read reachable Build-base commits.",
			),
		};
	const commits = parseDependencyLog(result.value.stdout);
	if (commits === null)
		return {
			ok: false,
			error: portError(
				"unknown",
				"Git returned malformed Kogen-Intent trailers for the Build base.",
			),
		};
	return { ok: true, value: commits };
}

/** Recheck immutable shaping assumptions and dependency landings before planning. */
export async function checkBuildPrestart(
	request: BuildPrestartRequest,
): Promise<BuildPrestartResult> {
	if (!request.origin.startsWith("/") || request.origin.includes("\0"))
		return invalid("Build origin must be an absolute repository path.");
	if (
		!OBJECT_ID.test(request.base.commit) ||
		!OBJECT_ID.test(request.base.tree)
	)
		return invalid("Build base commit and tree identities are invalid.");
	const parsed = parseIntent(request.approval.intentBytes);
	if (!parsed.ok)
		return invalid("The immutable approved Intent cannot be parsed.");
	const predicates = intentPredicates(parsed.intent);
	const dependencies = parsed.intent.frontmatter.blocksOn;
	if (predicates.length === 0 && dependencies.length === 0)
		return { kind: "skipped" };
	if (dependencies.some((slug) => !isValidIntentSlug(slug)))
		return invalid("The approved blocks_on list contains an invalid slug.");

	const dependencyResult = await readDependencyCommits(request, dependencies);
	if (!dependencyResult.ok)
		return {
			kind: "unavailable",
			message: dependencyResult.error.message,
			cause: dependencyResult.error,
		};
	const missingDependencies = dependencies.filter(
		(slug) => !dependencyResult.value.has(slug),
	);
	if (missingDependencies.length > 0) {
		const unique = [...new Set(missingDependencies)];
		return {
			kind: "blocked",
			missingDependencies: unique,
			statusDetail: `waiting for delivered dependencies: ${unique.join(", ")}`,
		};
	}

	const predicateResult = await checkIntentPredicates(predicates, {
		read: (path) =>
			readBaseFile(request.git, request.origin, request.base.commit, path),
	});
	if (predicateResult.kind === "invalid")
		return { kind: "invalid", message: predicateResult.message };
	if (predicateResult.kind === "unavailable")
		return {
			kind: "unavailable",
			message: `Could not recheck ${JSON.stringify(predicateResult.predicate.name)} at ${JSON.stringify(predicateResult.predicate.path)}: ${predicateResult.error.message}`,
			cause: predicateResult.error,
		};
	if (predicateResult.kind === "stale") {
		const { name, path } = predicateResult.predicate;
		const detail =
			predicateResult.reason === "path_missing"
				? `Shaping predicate ${JSON.stringify(name)} is stale because ${JSON.stringify(path)} is missing from the Build base.`
				: `Shaping predicate ${JSON.stringify(name)} is stale because ${JSON.stringify(path)} no longer contains its approved text.`;
		return {
			kind: "stale",
			event: { event: "shaping_stale", name, path },
			reason: "intent/shaping_stale",
			statusDetail: detail,
		};
	}

	const dependencyCommits = dependencies.map((slug) => ({
		slug,
		commit: dependencyResult.value.get(slug) as string,
	}));
	return {
		kind: "ready",
		checked: predicateResult.checked,
		event: {
			event: "shaping_rechecked",
			base: request.base.commit,
			predicates: predicates.map((predicate) => ({ ...predicate })),
			dependency_commits: dependencyCommits,
		},
	};
}
