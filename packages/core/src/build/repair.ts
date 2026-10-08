import type { GateVerificationResult } from "../gate/verify";
import { countVerificationFailures } from "../gate/verify";
import { userMessageBytes } from "../provider/session/history";
import type { SessionState } from "../provider/session/transition";
import { stepSession } from "../provider/session/transition";

export const BUILD_RUNG_REPAIR_LIMIT = 6;

export interface RepairProgress {
	readonly repairsUsed: number;
	readonly previousRedCount: number | null;
	readonly consecutiveRedWithoutCount: number;
}

export type RepairDecision =
	| {
			readonly kind: "repair";
			readonly count: number | null;
			readonly progress: RepairProgress;
	  }
	| {
			readonly kind: "end";
			readonly reason: "no_progress" | "repair_cap";
			readonly count: number | null;
			readonly progress: RepairProgress;
	  };

export function initialRepairProgress(): RepairProgress {
	return {
		repairsUsed: 0,
		previousRedCount: null,
		consecutiveRedWithoutCount: 0,
	};
}

/** Apply the rung's strictly decreasing red-verification progress rule. */
export function decideRepair(
	progress: RepairProgress,
	verification: Pick<
		GateVerificationResult,
		"status" | "fixes" | "checks" | "acceptance"
	>,
): RepairDecision {
	if (
		!Number.isSafeInteger(progress.repairsUsed) ||
		progress.repairsUsed < 0 ||
		progress.repairsUsed > BUILD_RUNG_REPAIR_LIMIT ||
		!Number.isSafeInteger(progress.consecutiveRedWithoutCount) ||
		progress.consecutiveRedWithoutCount < 0 ||
		(progress.previousRedCount !== null &&
			(!Number.isSafeInteger(progress.previousRedCount) ||
				progress.previousRedCount < 0))
	)
		throw new RangeError("Rung repair progress is invalid.");
	if (verification.status !== "red")
		throw new TypeError(
			"Repair progress is only defined for a red verification.",
		);

	const failureCount = countVerificationFailures(verification);
	const count =
		Number.isSafeInteger(failureCount) && failureCount > 0
			? failureCount
			: null;
	if (
		count !== null &&
		progress.previousRedCount !== null &&
		count >= progress.previousRedCount
	) {
		return {
			kind: "end",
			reason: "no_progress",
			count,
			progress,
		};
	}
	if (count === null && progress.consecutiveRedWithoutCount >= 1) {
		return {
			kind: "end",
			reason: "no_progress",
			count,
			progress,
		};
	}
	if (progress.repairsUsed >= BUILD_RUNG_REPAIR_LIMIT) {
		return {
			kind: "end",
			reason: "repair_cap",
			count,
			progress,
		};
	}

	return {
		kind: "repair",
		count,
		progress: {
			repairsUsed: progress.repairsUsed + 1,
			previousRedCount: count ?? progress.previousRedCount,
			consecutiveRedWithoutCount:
				count === null ? progress.consecutiveRedWithoutCount + 1 : 0,
		},
	};
}

/** Only acceptance-only red gates receive the observational Build audit. */
export function isAcceptanceOnlyFailure(
	verification: GateVerificationResult,
): boolean {
	return (
		verification.status === "red" &&
		verification.fixes.every((fix) => !fix.failed) &&
		verification.checks.every(
			(check) => check.status === "green" || check.excused,
		) &&
		(verification.acceptance.failures.length > 0 ||
			verification.acceptance.items.some((item) => item.status !== "pass"))
	);
}

export function buildRepairMessage(feedback: string): string {
	return `Kogen's controller reported this failure. Continue the same session and fix it:\n\n${feedback}`;
}

/** Add a controller note to the existing append-only conversation. */
export function appendBuildControllerNote(
	session: SessionState,
	note: string,
): SessionState {
	if (note.length === 0 || note.includes("\0"))
		throw new TypeError("Build controller note is invalid.");
	return stepSession(session, {
		type: "append_items",
		items: [{ bytes: userMessageBytes(note), kind: "user_note" }],
	});
}
