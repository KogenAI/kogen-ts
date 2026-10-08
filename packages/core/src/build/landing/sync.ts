import type { PortError, Result } from "../../contracts/errors";
import type { GitPort, ProcessResult } from "../../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../../git/command";

const DECODER = new TextDecoder("utf-8", { fatal: true });
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface LandingCheckout {
	readonly path: string;
	readonly state: "clean" | "dirty" | "stale";
}

export interface LandingCheckoutSyncPlan {
	readonly origin: string;
	readonly branch: string;
	readonly expectedParent: string;
	readonly candidateCommit: string;
	readonly checkouts: readonly LandingCheckout[];
}

function failure(message: string): PortError {
	return { code: "unavailable", message, retryable: true };
}

function decode(bytes: Uint8Array, label: string): Result<string> {
	try {
		return { ok: true, value: DECODER.decode(bytes) };
	} catch (cause) {
		return {
			ok: false,
			error: {
				...failure(`Git returned invalid UTF-8 while ${label}.`),
				cause,
			},
		};
	}
}

async function git(
	port: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await port.command({
			repository,
			argv,
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return {
			ok: false,
			error: { ...failure(`Git ${argv[0] ?? "command"} failed.`), cause },
		};
	}
}

async function requireSuccess(
	port: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	const result = await git(port, repository, argv, outputLimitBytes);
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return {
			ok: false,
			error: failure(
				`Git ${argv[0] ?? "command"} failed with exit ${String(result.value.exitCode)}.`,
			),
		};
	return result;
}

export function parseWorktreeList(bytes: Uint8Array): Result<
	readonly {
		readonly path: string;
		readonly head: string;
		readonly branch: string | null;
	}[]
> {
	const decoded = decode(bytes, "reading the worktree list");
	if (!decoded.ok) return decoded;
	const fields = decoded.value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const rows: { path: string; head: string; branch: string | null }[] = [];
	let current: {
		path?: string;
		head?: string;
		branch: string | null;
		bare?: boolean;
	} = {
		branch: null,
	};
	const finish = (): boolean => {
		if (current.path === undefined && current.head === undefined) return true;
		if (current.bare === true) {
			const valid =
				current.path?.startsWith("/") === true && current.head === undefined;
			current = { branch: null };
			return valid;
		}
		if (
			current.path === undefined ||
			!current.path.startsWith("/") ||
			current.head === undefined ||
			!OBJECT_ID.test(current.head)
		)
			return false;
		rows.push({
			path: current.path,
			head: current.head,
			branch: current.branch,
		});
		current = { branch: null };
		return true;
	};
	for (const field of fields) {
		if (field.length === 0) {
			if (!finish())
				return {
					ok: false,
					error: failure("Git returned a malformed worktree record."),
				};
			continue;
		}
		if (field.startsWith("worktree ")) current.path = field.slice(9);
		else if (field === "bare") current.bare = true;
		else if (field.startsWith("HEAD ")) current.head = field.slice(5);
		else if (field.startsWith("branch ")) current.branch = field.slice(7);
	}
	if (!finish())
		return {
			ok: false,
			error: failure("Git returned a malformed worktree record."),
		};
	return { ok: true, value: rows };
}

export async function planLandingCheckoutSync(
	gitPort: Pick<GitPort, "command">,
	input: {
		readonly origin: string;
		readonly branch: string;
		readonly expectedParent: string;
		readonly candidateCommit: string;
	},
): Promise<Result<LandingCheckoutSyncPlan>> {
	if (
		input.origin.length === 0 ||
		input.origin.includes("\0") ||
		input.branch.length === 0 ||
		/[\r\n\0]/u.test(input.branch) ||
		!OBJECT_ID.test(input.expectedParent) ||
		!OBJECT_ID.test(input.candidateCommit) ||
		input.expectedParent.length !== input.candidateCommit.length
	)
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "Checkout sync inputs are invalid.",
				retryable: false,
			},
		};
	const listed = await requireSuccess(gitPort, input.origin, [
		"worktree",
		"list",
		"--porcelain",
		"-z",
	]);
	if (!listed.ok) return listed;
	const rows = parseWorktreeList(listed.value.stdout);
	if (!rows.ok) return rows;
	const checkouts: LandingCheckout[] = [];
	for (const row of rows.value) {
		if (row.branch !== `refs/heads/${input.branch}`) continue;
		if (row.head !== input.expectedParent) {
			checkouts.push({ path: row.path, state: "stale" });
			continue;
		}
		const status = await requireSuccess(gitPort, row.path, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);
		if (!status.ok) return status;
		checkouts.push({
			path: row.path,
			state: status.value.stdout.byteLength === 0 ? "clean" : "dirty",
		});
	}
	return {
		ok: true,
		value: {
			origin: input.origin,
			branch: input.branch,
			expectedParent: input.expectedParent,
			candidateCommit: input.candidateCommit,
			checkouts,
		},
	};
}

function warning(commit: string, branch: string, path: string): string {
	return `land: warning: landed ${commit} on ${branch}; your checkout at ${path} has local changes and was not updated; run \`git reset --keep ${commit}\`, or merge it yourself`;
}

export async function applyLandingCheckoutSync(
	gitPort: Pick<GitPort, "command">,
	plan: LandingCheckoutSyncPlan,
): Promise<readonly string[]> {
	const warnings: string[] = [];
	for (const checkout of plan.checkouts) {
		if (checkout.state !== "clean") {
			warnings.push(warning(plan.candidateCommit, plan.branch, checkout.path));
			continue;
		}
		const symbolic = await git(
			gitPort,
			checkout.path,
			["symbolic-ref", "--quiet", "HEAD"],
			4096,
		);
		let branchRef: string | null = null;
		if (
			symbolic.ok &&
			!symbolic.value.timedOut &&
			symbolic.value.exitCode === 0
		) {
			const decoded = decode(
				symbolic.value.stdout,
				"checking a checkout branch",
			);
			if (decoded.ok) branchRef = decoded.value.trimEnd();
		}
		if (branchRef !== `refs/heads/${plan.branch}`) {
			warnings.push(warning(plan.candidateCommit, plan.branch, checkout.path));
			continue;
		}
		const updated = await git(
			gitPort,
			checkout.path,
			["read-tree", "-m", "-u", plan.expectedParent, plan.candidateCommit],
			4096,
		);
		if (!updated.ok || updated.value.timedOut || updated.value.exitCode !== 0)
			warnings.push(warning(plan.candidateCommit, plan.branch, checkout.path));
	}
	return warnings;
}
