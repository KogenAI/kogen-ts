import type { PortError, Result } from "../contracts/errors";
import type { GitPort, GitRequest, ProcessResult } from "../contracts/ports";
import {
	isValidQueueOwnerIdentity,
	type ProcessIdentityPort,
	type QueueOwnerIdentity,
} from "./lock";

export const PROJECT_CLAIM_REF = "refs/kogen/claim";
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CLAIM_PATH = ".kogen/claim";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ClaimOwnerStatus = "live" | "stale" | "unknown";

export type ClaimOwnerInspector = (
	runId: string,
) => Promise<Result<ClaimOwnerStatus>>;

export interface BuildClaim {
	readonly runId: string;
	readonly commit: string;
	readonly owner: QueueOwnerIdentity;
}

export type BuildClaimAcquisition =
	| {
			readonly kind: "acquired";
			readonly claim: BuildClaim;
			readonly tookOver: boolean;
	  }
	| {
			readonly kind: "held";
			readonly ownerRunId: string;
			readonly ownerCommit: string;
			readonly ownerStatus: "live" | "unknown";
	  };

interface ExistingClaim {
	readonly runId: string;
	readonly commit: string;
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function gitRequest(
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = 64 * 1024,
): GitRequest {
	return {
		repository,
		argv,
		...(stdin === undefined ? {} : { stdin }),
		timeoutMilliseconds: 30_000,
		outputLimitBytes,
	};
}

async function runGit(
	git: GitPort,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes?: number,
): Promise<Result<ProcessResult>> {
	try {
		return await git.command(
			gitRequest(repository, argv, stdin, outputLimitBytes),
		);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message: "Git claim operation failed.",
				retryable: true,
				cause,
			},
		};
	}
}

function commandError(result: ProcessResult, operation: string): PortError {
	return portError(
		result.timedOut ? "timeout" : "unavailable",
		result.timedOut
			? `Git ${operation} timed out.`
			: `Git ${operation} failed with exit ${String(result.exitCode)}.`,
		true,
	);
}

async function checkedText(
	git: GitPort,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes?: number,
): Promise<Result<string>> {
	const result = await runGit(git, repository, argv, stdin, outputLimitBytes);
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return {
			ok: false,
			error: commandError(result.value, argv[0] ?? "command"),
		};
	try {
		return { ok: true, value: decoder.decode(result.value.stdout) };
	} catch {
		return {
			ok: false,
			error: portError(
				"unavailable",
				`Git ${argv[0] ?? "command"} returned invalid UTF-8.`,
			),
		};
	}
}

function parseObjectId(text: string): string | null {
	const value = text.trimEnd();
	return OBJECT_ID_PATTERN.test(value) ? value : null;
}

async function outputObjectId(
	git: GitPort,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
): Promise<Result<string>> {
	const text = await checkedText(git, repository, argv, stdin, 256);
	if (!text.ok) return text;
	const objectId = parseObjectId(text.value);
	return objectId === null
		? {
				ok: false,
				error: portError(
					"unavailable",
					`Git ${argv[0] ?? "command"} returned an invalid object id.`,
				),
			}
		: { ok: true, value: objectId };
}

async function writeClaimCommit(
	git: GitPort,
	repository: string,
	runId: string,
): Promise<Result<string>> {
	const blob = await outputObjectId(
		git,
		repository,
		["hash-object", "-w", "--stdin"],
		encoder.encode(`${runId}\n`),
	);
	if (!blob.ok) return blob;
	const claimTree = await outputObjectId(
		git,
		repository,
		["mktree"],
		encoder.encode(`100644 blob ${blob.value}\tclaim\n`),
	);
	if (!claimTree.ok) return claimTree;
	const rootTree = await outputObjectId(
		git,
		repository,
		["mktree"],
		encoder.encode(`040000 tree ${claimTree.value}\t.kogen\n`),
	);
	if (!rootTree.ok) return rootTree;
	const commitBytes = encoder.encode(
		`tree ${rootTree.value}\nauthor Kogen <kogen@invalid> 0 +0000\ncommitter Kogen <kogen@invalid> 0 +0000\n\nKogen project claim\n\nKogen-Run: ${runId}\n`,
	);
	return outputObjectId(
		git,
		repository,
		["hash-object", "-w", "-t", "commit", "--stdin"],
		commitBytes,
	);
}

async function readExistingClaim(
	git: GitPort,
	repository: string,
): Promise<Result<ExistingClaim | null>> {
	const refList = await checkedText(
		git,
		repository,
		["for-each-ref", "--format=%(objectname)", PROJECT_CLAIM_REF],
		undefined,
		256,
	);
	if (!refList.ok) return refList;
	const lines = refList.value.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) return { ok: true, value: null };
	if (lines.length !== 1 || !OBJECT_ID_PATTERN.test(lines[0] ?? ""))
		return {
			ok: false,
			error: portError("invalid_input", "Project claim ref is malformed."),
		};
	const commit = lines[0];
	if (commit === undefined) {
		return {
			ok: false,
			error: portError("invalid_input", "Project claim ref is malformed."),
		};
	}
	const rawCommit = await checkedText(
		git,
		repository,
		["cat-file", "commit", commit],
		undefined,
		16 * 1024,
	);
	if (!rawCommit.ok) return rawCommit;
	const headerEnd = rawCommit.value.indexOf("\n\n");
	if (headerEnd < 0)
		return {
			ok: false,
			error: portError("invalid_input", "Project claim commit is malformed."),
		};
	const header = rawCommit.value.slice(0, headerEnd).split("\n");
	const treeLine = header[0];
	const tree = treeLine?.startsWith("tree ") ? treeLine.slice(5) : "";
	if (
		header.length !== 3 ||
		!OBJECT_ID_PATTERN.test(tree) ||
		header[0] !== `tree ${tree}` ||
		header[1] !== "author Kogen <kogen@invalid> 0 +0000" ||
		header[2] !== "committer Kogen <kogen@invalid> 0 +0000"
	)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Project claim must be a parentless commit.",
			),
		};
	const treeList = await checkedText(
		git,
		repository,
		["ls-tree", "-r", "-z", "--full-tree", tree],
		undefined,
		1024,
	);
	if (!treeList.ok) return treeList;
	const treeEntry = treeList.value;
	const separator = treeEntry.indexOf("\t");
	const terminator = treeEntry.indexOf("\0");
	if (
		separator < 0 ||
		terminator !== treeEntry.length - 1 ||
		treeEntry.slice(separator + 1, terminator) !== CLAIM_PATH
	)
		return {
			ok: false,
			error: portError("invalid_input", "Project claim tree is malformed."),
		};
	const treeFields = treeEntry.slice(0, separator).split(" ");
	const blob = treeFields[2];
	if (
		treeFields.length !== 3 ||
		treeFields[0] !== "100644" ||
		treeFields[1] !== "blob" ||
		blob === undefined ||
		!OBJECT_ID_PATTERN.test(blob)
	)
		return {
			ok: false,
			error: portError("invalid_input", "Project claim tree is malformed."),
		};
	const blobBytes = await runGit(
		git,
		repository,
		["cat-file", "blob", blob],
		undefined,
		128,
	);
	if (!blobBytes.ok) return blobBytes;
	if (blobBytes.value.timedOut || blobBytes.value.exitCode !== 0)
		return {
			ok: false,
			error: commandError(blobBytes.value, "claim blob read"),
		};
	let runId: string;
	try {
		runId = decoder.decode(blobBytes.value.stdout);
	} catch {
		return {
			ok: false,
			error: portError("invalid_input", "Project claim owner id is malformed."),
		};
	}
	if (!RUN_ID_PATTERN.test(runId.trimEnd()) || runId !== `${runId.trimEnd()}\n`)
		return {
			ok: false,
			error: portError("invalid_input", "Project claim owner id is malformed."),
		};
	const ownerRunId = runId.trimEnd();
	const message = rawCommit.value.slice(headerEnd + 2);
	if (message !== `Kogen project claim\n\nKogen-Run: ${ownerRunId}\n`)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Project claim trailer does not match its tree.",
			),
		};
	return { ok: true, value: { runId: ownerRunId, commit } };
}

async function compareAndSetClaim(
	git: GitPort,
	repository: string,
	newCommit: string,
	expectedCommit: string | null,
): Promise<Result<boolean>> {
	const zero = "0".repeat(newCommit.length);
	const args = [
		"update-ref",
		PROJECT_CLAIM_REF,
		newCommit,
		expectedCommit ?? zero,
	];
	const result = await runGit(git, repository, args, undefined, 4096);
	if (!result.ok) return result;
	if (result.value.timedOut)
		return {
			ok: false,
			error: commandError(result.value, "claim compare-and-swap"),
		};
	return { ok: true, value: result.value.exitCode === 0 };
}

/**
 * Acquire refs/kogen/claim with Git's atomic create/CAS. The caller resolves
 * an existing run's saved PID/start identity before reporting it stale.
 */
export async function acquireBuildClaim(
	git: GitPort,
	origin: string,
	runId: string,
	owner: QueueOwnerIdentity,
	inspectOwner: ClaimOwnerInspector,
): Promise<Result<BuildClaimAcquisition>> {
	if (
		origin.length === 0 ||
		!origin.startsWith("/") ||
		origin.includes("\0") ||
		!RUN_ID_PATTERN.test(runId) ||
		!isValidQueueOwnerIdentity(owner)
	)
		return {
			ok: false,
			error: portError("invalid_input", "Project origin or run id is invalid."),
		};
	let replacedStaleOwner = false;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const existing = await readExistingClaim(git, origin);
		if (!existing.ok) return existing;
		let expected: string | null = null;
		if (existing.value !== null) {
			let ownerStatus: Result<ClaimOwnerStatus>;
			try {
				ownerStatus = await inspectOwner(existing.value.runId);
			} catch (cause) {
				return {
					ok: false,
					error: {
						code: "unknown",
						message: "Project claim owner inspection failed.",
						retryable: true,
						cause,
					},
				};
			}
			if (!ownerStatus.ok) return ownerStatus;
			if (ownerStatus.value !== "stale")
				return {
					ok: true,
					value: {
						kind: "held",
						ownerRunId: existing.value.runId,
						ownerCommit: existing.value.commit,
						ownerStatus: ownerStatus.value,
					},
				};
			expected = existing.value.commit;
			replacedStaleOwner = true;
		}
		const candidate = await writeClaimCommit(git, origin, runId);
		if (!candidate.ok) return candidate;
		const installed = await compareAndSetClaim(
			git,
			origin,
			candidate.value,
			expected,
		);
		if (!installed.ok) return installed;
		if (installed.value)
			return {
				ok: true,
				value: {
					kind: "acquired",
					claim: { runId, commit: candidate.value, owner },
					tookOver: replacedStaleOwner,
				},
			};
	}
	return {
		ok: false,
		error: portError(
			"conflict",
			"Project claim changed during both acquisition attempts.",
			true,
		),
	};
}

/** Delete only the exact claim commit returned to its owner at acquisition. */
export async function releaseBuildClaim(
	git: GitPort,
	origin: string,
	claim: BuildClaim,
	identity: ProcessIdentityPort,
): Promise<Result<boolean>> {
	if (
		origin.length === 0 ||
		!origin.startsWith("/") ||
		origin.includes("\0") ||
		!RUN_ID_PATTERN.test(claim.runId) ||
		!OBJECT_ID_PATTERN.test(claim.commit) ||
		!isValidQueueOwnerIdentity(claim.owner)
	)
		return {
			ok: false,
			error: portError("invalid_input", "Project claim handle is invalid."),
		};
	const currentOwner = identity.current();
	if (!isValidQueueOwnerIdentity(currentOwner))
		return {
			ok: false,
			error: portError("invalid_input", "Current process identity is invalid."),
		};
	if (
		currentOwner.pid !== claim.owner.pid ||
		currentOwner.startedMs !== claim.owner.startedMs
	)
		return { ok: true, value: false };
	const current = await readExistingClaim(git, origin);
	if (!current.ok) return current;
	if (
		current.value === null ||
		current.value.commit !== claim.commit ||
		current.value.runId !== claim.runId
	)
		return { ok: true, value: false };
	const result = await runGit(
		git,
		origin,
		["update-ref", "-d", PROJECT_CLAIM_REF, claim.commit],
		undefined,
		4096,
	);
	if (!result.ok) return result;
	if (result.value.timedOut)
		return { ok: false, error: commandError(result.value, "claim release") };
	if (result.value.exitCode === 0) return { ok: true, value: true };
	const afterFailure = await readExistingClaim(git, origin);
	if (!afterFailure.ok) return afterFailure;
	if (afterFailure.value === null || afterFailure.value.commit !== claim.commit)
		return { ok: true, value: false };
	return {
		ok: false,
		error: commandError(result.value, "claim release"),
	};
}
