import { createHash } from "node:crypto";
import type { Result } from "../contracts/errors";
import { parseWitnessRecord, type WitnessRecord } from "../shape/witness";
import type {
	BuildBaseSnapshot,
	BuildCandidate,
	BuildEffectFailure,
	RungWorkspace,
} from "./controller";
import type { LoadedBuildApproval } from "./load";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type BuildWitnessResult =
	| {
			readonly kind: "green";
			readonly candidate: BuildCandidate;
			readonly workspace: RungWorkspace;
			readonly witness: WitnessRecord;
	  }
	| {
			/** B3 declined the proof and the caller must continue at B4. */
			readonly kind: "ladder";
			readonly reason:
				| "missing"
				| "invalid"
				| "stale_ref"
				| "stale_diff"
				| "red";
	  }
	| { readonly kind: "stopped"; readonly failure: BuildEffectFailure };

export interface BuildWitnessEffects {
	readRef(input: {
		readonly ref: string;
	}): Promise<Result<string | null, BuildEffectFailure>>;
	/** Exact no-filter binary diff from baseCommit to witnessCommit. */
	readDiff(input: {
		readonly baseCommit: string;
		readonly witnessCommit: string;
	}): Promise<Result<Uint8Array, BuildEffectFailure>>;
	createWorkspace(input: {
		readonly runId: string;
		readonly workspace: "throwaway";
		readonly base: BuildBaseSnapshot;
		readonly approval: LoadedBuildApproval;
	}): Promise<Result<RungWorkspace, BuildEffectFailure>>;
	applyWitness(input: {
		readonly workspace: RungWorkspace;
		readonly witnessCommit: string;
		readonly witnessBase: string;
		readonly currentBase: BuildBaseSnapshot;
	}): Promise<Result<void, BuildEffectFailure>>;
	/** Runs the actual sandboxed approval gate. This port must make no model call. */
	verify(input: {
		readonly workspace: RungWorkspace;
		readonly approval: LoadedBuildApproval;
		readonly base: BuildBaseSnapshot;
		readonly sandbox: true;
		readonly modelCalls: false;
		readonly auditorDemotion: false;
	}): Promise<
		Result<
			{ readonly kind: "green" | "red"; readonly verifiedTree: string },
			BuildEffectFailure
		>
	>;
	cleanup(input: {
		readonly runId: string;
		readonly workspace: RungWorkspace;
	}): Promise<Result<void, BuildEffectFailure>>;
}

export interface BuildWitnessRequest {
	readonly runId: string;
	readonly approval: LoadedBuildApproval;
	readonly base: BuildBaseSnapshot;
	readonly effects: BuildWitnessEffects;
}

function stopped(failure: BuildEffectFailure): BuildWitnessResult {
	return { kind: "stopped", failure };
}

function objectId(value: string): boolean {
	return OBJECT_ID.test(value);
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function ladder(
	reason: Extract<BuildWitnessResult, { kind: "ladder" }>["reason"],
): BuildWitnessResult {
	return { kind: "ladder", reason };
}

function validateRequest(request: BuildWitnessRequest): boolean {
	return (
		request.runId.length > 0 &&
		!request.runId.includes("\0") &&
		SLUG.test(request.approval.slug) &&
		objectId(request.approval.baseSha) &&
		objectId(request.base.commit) &&
		objectId(request.base.tree) &&
		request.base.commit.length === request.approval.baseSha.length &&
		request.base.tree.length === request.base.commit.length
	);
}

/**
 * B3 checks the approval's immutable witness/ref/diff binding, applies that
 * exact commit to the current Build base in a throwaway workspace, then runs
 * the real sandboxed gate. A red or stale proof tells the controller to enter
 * the normal ladder; the green path contains no model/provider port.
 */
export async function reverifyApprovedWitness(
	request: BuildWitnessRequest,
): Promise<BuildWitnessResult> {
	if (!validateRequest(request))
		return stopped({
			code: "controller/witness_input_invalid",
			message: "Build witness input is invalid.",
			exitCode: 70,
		});
	const metadataWitness = request.approval.metadata.witness;
	if (metadataWitness === null || metadataWitness === undefined)
		return ladder("missing");
	const witness = parseWitnessRecord(metadataWitness);
	if (
		witness === null ||
		witness.base_sha !== request.approval.baseSha ||
		witness.commit.length !== request.approval.baseSha.length
	)
		return ladder("invalid");
	const ref = `refs/kogen/witness/${request.approval.slug}`;
	let refResult: Awaited<ReturnType<BuildWitnessEffects["readRef"]>>;
	try {
		refResult = await request.effects.readRef({ ref });
	} catch (cause) {
		return stopped({
			code: "environment/witness_ref_unavailable",
			message:
				cause instanceof Error
					? cause.message
					: "Could not inspect witness ref.",
			exitCode: 3,
		});
	}
	if (!refResult.ok) return stopped(refResult.error);
	if (refResult.value !== witness.commit) return ladder("stale_ref");
	let diffResult: Awaited<ReturnType<BuildWitnessEffects["readDiff"]>>;
	try {
		diffResult = await request.effects.readDiff({
			baseCommit: witness.base_sha,
			witnessCommit: witness.commit,
		});
	} catch (cause) {
		return stopped({
			code: "environment/witness_diff_unavailable",
			message:
				cause instanceof Error
					? cause.message
					: "Could not inspect witness diff.",
			exitCode: 3,
		});
	}
	if (!diffResult.ok) return stopped(diffResult.error);
	if (digest(diffResult.value) !== witness.diff_sha256)
		return ladder("stale_diff");

	let workspaceResult: Awaited<
		ReturnType<BuildWitnessEffects["createWorkspace"]>
	>;
	try {
		workspaceResult = await request.effects.createWorkspace({
			runId: request.runId,
			workspace: "throwaway",
			base: request.base,
			approval: request.approval,
		});
	} catch (cause) {
		return stopped({
			code: "environment/witness_workspace_failed",
			message:
				cause instanceof Error
					? cause.message
					: "Could not create witness workspace.",
			exitCode: 3,
		});
	}
	if (!workspaceResult.ok) return stopped(workspaceResult.error);
	const workspace = workspaceResult.value;
	if (
		typeof workspace.id !== "string" ||
		workspace.id.length === 0 ||
		typeof workspace.root !== "string" ||
		workspace.root.length === 0
	)
		return cleanupAfterFailure(request, workspace, {
			code: "controller/witness_workspace_invalid",
			message: "Witness workspace identity is invalid.",
			exitCode: 70,
		});
	let applied: Awaited<ReturnType<BuildWitnessEffects["applyWitness"]>>;
	try {
		applied = await request.effects.applyWitness({
			workspace,
			witnessCommit: witness.commit,
			witnessBase: witness.base_sha,
			currentBase: request.base,
		});
	} catch (cause) {
		return cleanupAfterFailure(request, workspace, {
			code: "environment/witness_apply_failed",
			message:
				cause instanceof Error
					? cause.message
					: "Could not apply witness commit.",
			exitCode: 3,
		});
	}
	if (!applied.ok)
		return cleanupAfterFailure(request, workspace, applied.error);
	let verified: Awaited<ReturnType<BuildWitnessEffects["verify"]>>;
	try {
		verified = await request.effects.verify({
			workspace,
			approval: request.approval,
			base: request.base,
			sandbox: true,
			modelCalls: false,
			auditorDemotion: false,
		});
	} catch (cause) {
		return cleanupAfterFailure(request, workspace, {
			code: "environment/witness_verify_failed",
			message:
				cause instanceof Error ? cause.message : "Could not verify witness.",
			exitCode: 3,
		});
	}
	if (!verified.ok)
		return cleanupAfterFailure(request, workspace, verified.error);
	if (verified.value.kind === "red") {
		try {
			const cleaned = await request.effects.cleanup({
				runId: request.runId,
				workspace,
			});
			if (!cleaned.ok) return stopped(cleaned.error);
		} catch (cause) {
			return stopped({
				code: "environment/witness_cleanup_failed",
				message:
					cause instanceof Error
						? cause.message
						: "Could not clean witness workspace.",
				exitCode: 3,
			});
		}
		return ladder("red");
	}
	if (
		!objectId(verified.value.verifiedTree) ||
		verified.value.verifiedTree.length !== request.base.tree.length
	) {
		return cleanupAfterFailure(request, workspace, {
			code: "controller/witness_tree_invalid",
			message: "Witness gate returned an invalid verified tree.",
			exitCode: 70,
		});
	}
	const candidate: BuildCandidate = Object.freeze({
		rung: "witness",
		workspace,
		verifiedTree: verified.value.verifiedTree,
		verdict: "green",
	});
	return { kind: "green", candidate, workspace, witness };
}

async function cleanupAfterFailure(
	request: BuildWitnessRequest,
	workspace: RungWorkspace,
	failure: BuildEffectFailure,
): Promise<BuildWitnessResult> {
	try {
		const cleaned = await request.effects.cleanup({
			runId: request.runId,
			workspace,
		});
		if (!cleaned.ok)
			return stopped({
				code: cleaned.error.code,
				message: `${failure.message}; cleanup failed: ${cleaned.error.message}`,
				exitCode: cleaned.error.exitCode,
			});
	} catch (cause) {
		return stopped({
			code: "environment/witness_cleanup_failed",
			message: `${failure.message}; cleanup failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
			exitCode: 3,
		});
	}
	return stopped(failure);
}
