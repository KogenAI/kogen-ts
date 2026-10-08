import type { GateVerificationResult } from "../gate/verify";
import { countVerificationFailures } from "../gate/verify";
import type { LandPolicy } from "../project/schema";

export const BUILD_AUDIT_MODE = "observational" as const;
export const DEFAULT_BUILD_LAND_POLICY: LandPolicy = "green";

export type BuildAuditVerdict = "valid" | "over_strict" | "contradicts";

export interface BuildAuditAdviceItem {
	readonly id: string;
	readonly verdict: BuildAuditVerdict;
	readonly reason: string;
}

export interface BuildAuditObservation {
	readonly mode: typeof BUILD_AUDIT_MODE;
	readonly items: readonly BuildAuditAdviceItem[];
	readonly warning: boolean;
	readonly demoted: false;
	readonly advisoryItems: readonly [];
}

type AuditVerification = Pick<GateVerificationResult, "acceptance">;
type LandingVerification = Pick<
	GateVerificationResult,
	"status" | "fixes" | "checks" | "acceptance"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuildAuditVerdict(value: unknown): value is BuildAuditVerdict {
	return (
		value === "valid" || value === "over_strict" || value === "contradicts"
	);
}

/**
 * Validate advice against the actual failed acceptance rows. Invalid advice is
 * retained as a warning only; it never changes the rows or their gate result.
 */
export function observeBuildAudit(
	verification: AuditVerification,
	value: unknown,
): BuildAuditObservation {
	const failingIds = new Set(
		verification.acceptance.items
			.filter((item) => item.status !== "pass")
			.map((item) => item.id),
	);
	const seen = new Set<string>();
	const items: BuildAuditAdviceItem[] = [];
	let warning = false;

	if (!isRecord(value) || Object.keys(value).some((key) => key !== "items")) {
		warning = true;
	} else if (!Array.isArray(value.items)) {
		warning = true;
	} else {
		for (const rawItem of value.items) {
			if (!isRecord(rawItem)) {
				warning = true;
				continue;
			}
			if (
				Object.keys(rawItem).some(
					(key) => key !== "id" && key !== "verdict" && key !== "reason",
				) ||
				typeof rawItem.id !== "string" ||
				!failingIds.has(rawItem.id) ||
				seen.has(rawItem.id) ||
				!isBuildAuditVerdict(rawItem.verdict) ||
				typeof rawItem.reason !== "string"
			) {
				warning = true;
				continue;
			}
			seen.add(rawItem.id);
			items.push({
				id: rawItem.id,
				verdict: rawItem.verdict,
				reason: rawItem.reason,
			});
		}
	}

	if (seen.size !== failingIds.size) warning = true;
	return Object.freeze({
		mode: BUILD_AUDIT_MODE,
		items: Object.freeze(items),
		warning,
		demoted: false,
		advisoryItems: Object.freeze([]) as readonly [],
	});
}

/**
 * Both admitted land policy spellings use the same green gate. Landing also
 * requires every approved result and at least one approved change item to pass.
 */
export function isBuildVerificationLandable(input: {
	readonly verification: LandingVerification;
	readonly landPolicy: LandPolicy;
	readonly approvedItemIds: readonly string[];
	readonly approvedChangeItemIds: readonly string[];
}): boolean {
	if (
		(input.landPolicy !== "green" &&
			input.landPolicy !== "green-or-advisory") ||
		input.verification.status !== "green" ||
		countVerificationFailures(input.verification) !== 0 ||
		input.approvedItemIds.length === 0 ||
		input.approvedChangeItemIds.length === 0
	)
		return false;

	const approved = new Set<string>();
	for (const id of input.approvedItemIds) {
		if (typeof id !== "string" || id.length === 0 || approved.has(id))
			return false;
		approved.add(id);
	}
	const changes = new Set<string>();
	for (const id of input.approvedChangeItemIds) {
		if (
			typeof id !== "string" ||
			id.length === 0 ||
			!approved.has(id) ||
			changes.has(id)
		)
			return false;
		changes.add(id);
	}

	const actual = new Map<string, "pass" | "fail">();
	for (const item of input.verification.acceptance.items) {
		if (
			typeof item.id !== "string" ||
			(item.status !== "pass" && item.status !== "fail") ||
			actual.has(item.id)
		)
			return false;
		actual.set(item.id, item.status);
	}
	if (actual.size !== approved.size) return false;
	for (const id of approved) if (actual.get(id) !== "pass") return false;
	if (![...changes].some((id) => actual.get(id) === "pass")) return false;

	return true;
}
