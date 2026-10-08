import type { GateVerificationResult } from "../gate/verify";
import { countVerificationFailures } from "../gate/verify";

type SelectionVerification = Pick<
	GateVerificationResult,
	"status" | "fixes" | "checks" | "acceptance"
>;

export interface BuildSelectionCandidate<T> {
	/** The snapshot/reference the controller can park or land. */
	readonly candidate: T;
	/** One-based attempt order; this is the final deterministic tie-break. */
	readonly ordinal: number;
	/** Results from the real gate run for this exact candidate tree. */
	readonly verification: SelectionVerification;
	/** Exact implementation diff bytes for the candidate snapshot. */
	readonly diff: Uint8Array;
}

export interface BuildCandidateScore {
	readonly passingApprovedItems: number;
	readonly blockingFindings: number;
	readonly implementationDiffLines: number;
	readonly ordinal: number;
}

export interface RankedBuildCandidate<T> {
	readonly candidate: T;
	readonly score: BuildCandidateScore;
	/** A private copy of the selected candidate's diff, including when red. */
	readonly candidateDiff: Uint8Array;
}

function startsWithAscii(line: Uint8Array, value: string): boolean {
	if (line.byteLength < value.length) return false;
	for (let index = 0; index < value.length; index += 1) {
		if (line[index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

function* diffLines(bytes: Uint8Array): Generator<Uint8Array> {
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0x0a) continue;
		let end = index;
		if (end > start && bytes[end - 1] === 0x0d) end -= 1;
		yield bytes.subarray(start, end);
		start = index + 1;
	}
	if (start < bytes.byteLength) {
		let end = bytes.byteLength;
		if (end > start && bytes[end - 1] === 0x0d) end -= 1;
		yield bytes.subarray(start, end);
	}
}

/** Count added and removed source lines in a unified Git diff. */
export function countImplementationDiffLines(diff: Uint8Array): number {
	if (!(diff instanceof Uint8Array))
		throw new TypeError("Candidate diff must be bytes.");
	let inHunk = false;
	let inBinaryPatch = false;
	let changedLines = 0;
	for (const line of diffLines(diff)) {
		if (startsWithAscii(line, "diff --git ")) {
			inHunk = false;
			inBinaryPatch = false;
			continue;
		}
		if (
			startsWithAscii(line, "GIT binary patch") ||
			startsWithAscii(line, "Binary files ")
		) {
			inHunk = false;
			inBinaryPatch = true;
			continue;
		}
		if (inBinaryPatch) continue;
		if (startsWithAscii(line, "@@")) {
			inHunk = true;
			continue;
		}
		if (inHunk && (line[0] === 0x2b || line[0] === 0x2d)) {
			changedLines += 1;
			if (!Number.isSafeInteger(changedLines))
				throw new RangeError("Candidate diff line count is unsafe.");
		}
	}
	return changedLines;
}

function passingItemCount(verification: SelectionVerification): number {
	const seen = new Set<string>();
	let count = 0;
	for (const item of verification.acceptance.items) {
		if (
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			seen.has(item.id) ||
			(item.status !== "pass" && item.status !== "fail")
		)
			throw new TypeError("Candidate acceptance results are invalid.");
		seen.add(item.id);
		if (item.status === "pass") count += 1;
	}
	return count;
}

export function scoreBuildCandidate<T>(
	input: BuildSelectionCandidate<T>,
): BuildCandidateScore {
	if (
		!Number.isSafeInteger(input.ordinal) ||
		input.ordinal < 1 ||
		(input.verification.status !== "green" &&
			input.verification.status !== "red")
	)
		throw new TypeError("Candidate selection input is invalid.");
	return Object.freeze({
		passingApprovedItems: passingItemCount(input.verification),
		blockingFindings: countVerificationFailures(input.verification),
		implementationDiffLines: countImplementationDiffLines(input.diff),
		ordinal: input.ordinal,
	});
}

function compareScores(
	left: BuildCandidateScore,
	right: BuildCandidateScore,
): number {
	if (left.passingApprovedItems !== right.passingApprovedItems)
		return right.passingApprovedItems - left.passingApprovedItems;
	if (left.blockingFindings !== right.blockingFindings)
		return left.blockingFindings - right.blockingFindings;
	if (left.implementationDiffLines !== right.implementationDiffLines)
		return left.implementationDiffLines - right.implementationDiffLines;
	return left.ordinal - right.ordinal;
}

/** Rank actual gate snapshots; auditor advice is deliberately not an input. */
export function rankBuildCandidates<T>(
	candidates: readonly BuildSelectionCandidate<T>[],
): readonly RankedBuildCandidate<T>[] {
	const ordinals = new Set<number>();
	const ranked = candidates.map((input) => {
		if (ordinals.has(input.ordinal))
			throw new TypeError("Candidate attempt ordinals must be unique.");
		ordinals.add(input.ordinal);
		return Object.freeze({
			candidate: input.candidate,
			score: scoreBuildCandidate(input),
			candidateDiff: input.diff.slice(),
		});
	});
	ranked.sort((left, right) => compareScores(left.score, right.score));
	return Object.freeze(ranked);
}

/** Return the best snapshot even when it remains red and cannot land. */
export function selectBestBuildCandidate<T>(
	candidates: readonly BuildSelectionCandidate<T>[],
): RankedBuildCandidate<T> | null {
	return rankBuildCandidates(candidates)[0] ?? null;
}
