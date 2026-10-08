import type { LandingRecord } from "../../run/store";

export type LandingPhase =
	| "candidate_ready"
	| "recorded"
	| "incoming"
	| "landed"
	| "synced"
	| "complete"
	| "cleanup_pending";

export interface LandingState {
	readonly phase: LandingPhase;
	readonly record: LandingRecord;
	readonly warnings: readonly string[];
	readonly cleanupPending: boolean;
}

export type LandingEvent =
	| { readonly type: "record_persisted" }
	| { readonly type: "incoming_published" }
	| { readonly type: "base_cas_succeeded" }
	| {
			readonly type: "checkouts_synchronized";
			readonly warnings: readonly string[];
	  }
	| { readonly type: "incoming_deleted" }
	| { readonly type: "cleanup_failed"; readonly warning: string };

export type LandingEffect =
	| { readonly kind: "publish_incoming"; readonly record: LandingRecord }
	| { readonly kind: "cas_base"; readonly record: LandingRecord }
	| { readonly kind: "synchronize_checkouts"; readonly record: LandingRecord }
	| { readonly kind: "delete_incoming"; readonly record: LandingRecord }
	| { readonly kind: "record_cleanup_failure"; readonly record: LandingRecord }
	| { readonly kind: "done"; readonly landed: true };

export interface LandingTransition {
	readonly state: LandingState;
	readonly effect: LandingEffect;
}

export function initialLandingState(record: LandingRecord): LandingState {
	return {
		phase: "candidate_ready",
		record,
		warnings: [],
		cleanupPending: false,
	};
}

/** The production landing effect loop and replay adapter share this ordering. */
export function landingTransition(
	state: LandingState,
	event: LandingEvent,
): LandingTransition {
	if (event.type === "record_persisted" && state.phase === "candidate_ready")
		return {
			state: { ...state, phase: "recorded" },
			effect: { kind: "publish_incoming", record: state.record },
		};
	if (event.type === "incoming_published" && state.phase === "recorded")
		return {
			state: { ...state, phase: "incoming" },
			effect: { kind: "cas_base", record: state.record },
		};
	if (event.type === "base_cas_succeeded" && state.phase === "incoming")
		return {
			state: { ...state, phase: "landed" },
			effect: { kind: "synchronize_checkouts", record: state.record },
		};
	if (
		event.type === "checkouts_synchronized" &&
		(state.phase === "landed" || state.phase === "cleanup_pending")
	)
		return {
			state: {
				...state,
				phase: "synced",
				warnings: [...state.warnings, ...event.warnings],
			},
			effect: { kind: "delete_incoming", record: state.record },
		};
	if (event.type === "incoming_deleted" && state.phase === "synced")
		return {
			state: { ...state, phase: "complete" },
			effect: { kind: "done", landed: true },
		};
	if (
		event.type === "cleanup_failed" &&
		(state.phase === "synced" || state.phase === "landed")
	)
		return {
			state: {
				...state,
				phase: "cleanup_pending",
				warnings: [...state.warnings, event.warning],
				cleanupPending: true,
			},
			effect: { kind: "record_cleanup_failure", record: state.record },
		};
	throw new TypeError(
		`Landing event ${event.type} is invalid during ${state.phase}.`,
	);
}
