import type { PortError } from "../contracts/errors";
import type {
	ProcessIdentityObservation,
	QueueOwnerIdentity,
} from "../queue/lock";
import { classifyOwnerLiveness } from "../queue/lock";
import type { RunRecord, RunStatus } from "../run/store";

export type RecoveryOwnerDecision = "live" | "stale" | "unknown";

export interface RecoveryOutcome {
	readonly status: Exclude<RunStatus, "running">;
	readonly reason: string;
	readonly reconciled: boolean;
}

export interface RecoveryJournalOutcome {
	readonly status: RunStatus;
	readonly reason: string;
}

export type RecoveryWorkspaceDecision =
	| { readonly kind: "already_durable" }
	| { readonly kind: "publish_unverified" };

export interface RecoveryIssue {
	readonly workspace: string;
	readonly stage:
		| "stop_writers"
		| "snapshot"
		| "publication"
		| "record"
		| "claim_release"
		| "workspace_cleanup"
		| "incoming_cleanup";
	readonly error: PortError;
}

export function recoveryOwnerDecision(
	owner: QueueOwnerIdentity,
	observation: ProcessIdentityObservation,
): RecoveryOwnerDecision {
	return classifyOwnerLiveness(owner, observation);
}

/**
 * Preserve a journaled terminal event when run.json lagged its append. A landing
 * already on the target base takes precedence over interrupted/crashed events.
 */
export function recoveryOutcomeTransition(input: {
	readonly record: RunRecord;
	readonly lastEvent: string | null;
	readonly journalOutcome?: RecoveryJournalOutcome | null;
	readonly onBase: boolean;
}): RecoveryOutcome {
	const { record, lastEvent, onBase } = input;
	const journalOutcome = input.journalOutcome ?? null;
	if (
		record.status === "running" &&
		journalOutcome !== null &&
		journalOutcome.status !== "running"
	) {
		return {
			status: journalOutcome.status,
			reason: journalOutcome.reason,
			reconciled: journalOutcome.status === "landed",
		};
	}
	if (record.status !== "running") {
		return {
			status: record.status,
			reason: journalOutcome?.reason ?? "already_terminal",
			reconciled: false,
		};
	}
	if (onBase)
		return { status: "landed", reason: "reconciled", reconciled: true };
	return {
		status: "failed",
		reason: lastEvent === "interrupted" ? "interrupted" : "crashed",
		reconciled: false,
	};
}

export function recoveryWorkspaceTransition(input: {
	readonly tree: string;
	readonly baseTree: string;
	readonly hasMatchingDurableSnapshot: boolean;
}): RecoveryWorkspaceDecision {
	if (input.tree === input.baseTree || input.hasMatchingDurableSnapshot)
		return { kind: "already_durable" };
	return { kind: "publish_unverified" };
}

export function recoveryMayRemoveWorkspace(
	preservationDurable: boolean,
): boolean {
	return preservationDurable;
}

/** An incoming ref is disposable only once its candidate is on the target base. */
export function recoveryMayRemoveIncoming(
	outcome: RecoveryOutcome,
	record: RunRecord,
): boolean {
	return outcome.status === "landed" && record.landing !== null;
}
