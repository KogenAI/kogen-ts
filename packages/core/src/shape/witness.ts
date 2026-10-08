import { createHash } from "node:crypto";
import type { Result } from "../contracts/errors";
import type { ResolvedRole } from "../project/roles";
import type { RespondResult } from "../provider/retry/respond";
import { userMessageBytes } from "../provider/session/history";
import {
	newConversation,
	type SessionState,
} from "../provider/session/transition";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DECODER = new TextDecoder("utf-8", { fatal: true });

export type WitnessVerdict = "PROVEN" | "PROVEN_WITH_CONCERNS" | "UNPROVEN";
export type WitnessAdjudicationVerdict =
	| "TEST-WRONG"
	| "WITNESS-WRONG"
	| "UNDECIDED";

export interface WitnessRecord {
	readonly verdict: Exclude<WitnessVerdict, "UNPROVEN">;
	readonly commit: string;
	readonly diff_sha256: string;
	readonly base_sha: string;
}

export interface WitnessFailure {
	readonly id: string;
	readonly output: readonly string[];
}

export interface WitnessAdjudication {
	readonly id: string;
	readonly verdict: WitnessAdjudicationVerdict;
	readonly citation: string;
	readonly reason: string;
}

export interface WitnessAdjudicationParse {
	readonly items: readonly WitnessAdjudication[];
	readonly warnings: readonly string[];
}

export interface WitnessRepairDirective {
	readonly id: string;
	readonly kind: "test" | "witness";
	readonly citation: string;
	readonly reason: string;
}

export interface WitnessCandidate {
	readonly commit: string;
	readonly parent: string;
	readonly baseSha: string;
	/** Exact binary patch from baseSha to commit, with no text conversion. */
	readonly diff: Uint8Array;
}

export type WitnessGateResult =
	| {
			readonly kind: "green";
			readonly candidate: WitnessCandidate;
	  }
	| {
			readonly kind: "red";
			readonly failures: readonly WitnessFailure[];
	  }
	| { readonly kind: "stopped"; readonly reason: string };

export interface WitnessGateRequest {
	readonly slug: string;
	readonly baseSha: string;
	readonly intentBytes: Uint8Array;
	readonly acceptanceBytes: Uint8Array;
	readonly round: number;
	readonly difficulty: "easy" | "medium" | "hard";
	readonly rungs: readonly ["R1"] | readonly ["R1", "R2"];
	readonly parallelRungs: boolean;
	readonly workspace: "throwaway";
	readonly sandbox: true;
	readonly realGate: true;
	readonly auditorDemotion: false;
}

export interface WitnessRunEffects {
	/** Must run the production R1 gate; hard difficulty uses B44's parallel R1/R2. */
	runGate(request: WitnessGateRequest): Promise<WitnessGateResult>;
	/** Repair only the requested test/witness sides, then return the test bytes. */
	repair(input: {
		readonly slug: string;
		readonly round: number;
		readonly intentBytes: Uint8Array;
		readonly acceptanceBytes: Uint8Array;
		readonly directives: readonly WitnessRepairDirective[];
	}): Promise<Result<Uint8Array>>;
	/** Revalidate corrected acceptance bytes before spending another gate run. */
	validate(input: {
		readonly intentBytes: Uint8Array;
		readonly acceptanceBytes: Uint8Array;
	}): Promise<boolean>;
	/** Create the ref only if absent; an existing ref is accepted only if identical. */
	publishRef(input: {
		readonly ref: string;
		readonly commit: string;
		readonly expected: null;
	}): Promise<Result<"created" | "same" | "conflict">>;
}

export interface ShapeWitnessRequest {
	readonly slug: string;
	readonly baseSha: string;
	readonly difficulty: "easy" | "medium" | "hard";
	readonly witnessRounds: number;
	readonly requestBytes: Uint8Array;
	readonly intentBytes: Uint8Array;
	readonly acceptanceBytes: Uint8Array;
	readonly sourceSession: SessionState;
	readonly auditorRole: ResolvedRole;
	readonly requestModel: (
		session: SessionState,
		role: ResolvedRole,
	) => Promise<RespondResult>;
	readonly effects: WitnessRunEffects;
	/** Receipts can attach provider usage/counters without coupling Shape to Build. */
	onAdjudicationRequest?: () => void;
}

export interface ShapeWitnessResult {
	readonly verdict: WitnessVerdict;
	readonly witness: WitnessRecord | null;
	readonly concerns: readonly string[];
	readonly gateRuns: number;
	readonly adjudicationRounds: number;
	readonly acceptanceBytes: Uint8Array;
	readonly reason: string | null;
}

export const WITNESS_ADJUDICATOR_INSTRUCTIONS =
	'You are Kogen\'s witness adjudicator. For each failing acceptance item, determine whether the test is wrong, the implementation witness is wrong, or the evidence is undecided. Return only JSON with shape {"items":[{"id":string,"verdict":"TEST-WRONG|WITNESS-WRONG|UNDECIDED","citation":string,"reason":string}]} and no tools.';

function validText(bytes: Uint8Array): string | null {
	try {
		return DECODER.decode(bytes);
	} catch {
		return null;
	}
}

function failureText(failures: readonly WitnessFailure[]): string {
	return failures
		.map(
			(failure) =>
				`- ${failure.id}\n${failure.output.map((line) => `  ${line}`).join("\n")}`,
		)
		.join("\n");
}

export function witnessAdjudicationMessage(input: {
	readonly request: string;
	readonly acceptance: string;
	readonly failures: readonly WitnessFailure[];
}): string {
	return [
		"Adjudicate only the listed failing acceptance items. TEST-WRONG means repair that acceptance test and rerun it. WITNESS-WRONG means keep the acceptance test unchanged and repair the implementation. UNDECIDED means leave a feasibility concern.",
		"Verbatim Request:",
		input.request,
		"Acceptance test source:",
		input.acceptance,
		"Failing items and exact gate output:",
		failureText(input.failures),
	].join("\n\n");
}

export function createWitnessAdjudicationSession(input: {
	readonly source: SessionState;
	readonly role: ResolvedRole;
	readonly round: number;
	readonly message: string;
}): SessionState {
	if (
		input.role.name !== "auditor" ||
		!Number.isSafeInteger(input.round) ||
		input.round < 1 ||
		input.source.role === "auditor" ||
		input.source.roleToolAuthorization.auditor === undefined
	)
		throw new TypeError("Witness adjudication input is invalid.");
	const attempt = `shape-witness-round-${input.round}`;
	const session = newConversation(input.source, {
		type: "start_conversation",
		stage: "shape-witness-adjudication",
		attempt,
		rung: attempt,
		epoch: "initial",
		role: "auditor",
		model: input.role.effective.model,
		effort: input.role.effective.effort,
		roleInstructions: WITNESS_ADJUDICATOR_INSTRUCTIONS,
		initialItems: [{ bytes: userMessageBytes(input.message), kind: "message" }],
	});
	if (session.authorizedTools.length !== 0)
		throw new TypeError("Witness adjudication must not have tools.");
	return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function undecided(id: string, reason: string): WitnessAdjudication {
	return { id, verdict: "UNDECIDED", citation: "", reason };
}

/** Invalid, duplicate, missing, or unknown advice can never select a repair. */
export function parseWitnessAdjudication(
	text: string,
	expectedIds: readonly string[],
): WitnessAdjudicationParse {
	const uniqueIds = [...new Set(expectedIds)];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return {
			items: uniqueIds.map((id) =>
				undecided(id, "Malformed adjudication JSON."),
			),
			warnings: ["Witness adjudicator returned malformed JSON."],
		};
	}
	const root = isRecord(parsed) ? parsed : null;
	if (
		root === null ||
		Object.keys(root).length !== 1 ||
		!Array.isArray(root.items)
	) {
		return {
			items: uniqueIds.map((id) =>
				undecided(id, "Invalid adjudication shape."),
			),
			warnings: [
				"Witness adjudicator response must contain only an items array.",
			],
		};
	}
	const expected = new Set(uniqueIds);
	const values = new Map<string, WitnessAdjudication>();
	const duplicates = new Set<string>();
	const warnings: string[] = [];
	for (const raw of root.items) {
		if (!isRecord(raw) || typeof raw.id !== "string" || !expected.has(raw.id)) {
			warnings.push("Witness adjudicator returned an unknown or invalid item.");
			continue;
		}
		if (values.has(raw.id)) {
			values.delete(raw.id);
			duplicates.add(raw.id);
			warnings.push(
				`Witness adjudicator returned duplicate advice for ${raw.id}.`,
			);
			continue;
		}
		if (
			Object.keys(raw).length !== 4 ||
			(raw.verdict !== "TEST-WRONG" &&
				raw.verdict !== "WITNESS-WRONG" &&
				raw.verdict !== "UNDECIDED") ||
			typeof raw.citation !== "string" ||
			typeof raw.reason !== "string"
		) {
			warnings.push(`Witness adjudication for ${raw.id} is incomplete.`);
			continue;
		}
		values.set(raw.id, {
			id: raw.id,
			verdict: raw.verdict,
			citation: raw.citation,
			reason: raw.reason,
		});
	}
	const items = uniqueIds.map((id) => {
		if (duplicates.has(id)) return undecided(id, "Duplicate adjudication.");
		return (
			values.get(id) ?? undecided(id, "No valid adjudication was returned.")
		);
	});
	for (const item of items)
		if (item.verdict === "UNDECIDED")
			warnings.push(`Witness adjudication for ${item.id} remains undecided.`);
	return { items: Object.freeze(items), warnings: Object.freeze(warnings) };
}

function objectId(value: string): boolean {
	return OBJECT_ID.test(value);
}

function diffHash(diff: Uint8Array): string {
	return createHash("sha256").update(diff).digest("hex");
}

function unproven(input: {
	readonly gateRuns: number;
	readonly adjudicationRounds: number;
	readonly acceptanceBytes: Uint8Array;
	readonly concerns?: readonly string[];
	readonly reason: string;
}): ShapeWitnessResult {
	return {
		verdict: "UNPROVEN",
		witness: null,
		concerns: Object.freeze([...(input.concerns ?? [])]),
		gateRuns: input.gateRuns,
		adjudicationRounds: input.adjudicationRounds,
		acceptanceBytes: input.acceptanceBytes.slice(),
		reason: input.reason,
	};
}

/**
 * Run bounded, observational adjudication around the throwaway witness gate.
 * The caller binds runGate to the production rung/gate effects; hard plans are
 * explicitly routed to the concurrent R1/R2 policy and demotion is impossible.
 */
export async function runShapeWitness(
	request: ShapeWitnessRequest,
): Promise<ShapeWitnessResult> {
	if (
		!SLUG.test(request.slug) ||
		!objectId(request.baseSha) ||
		!Number.isSafeInteger(request.witnessRounds) ||
		request.witnessRounds < 0 ||
		request.auditorRole.name !== "auditor" ||
		request.sourceSession.role === "auditor"
	)
		return unproven({
			gateRuns: 0,
			adjudicationRounds: 0,
			acceptanceBytes: request.acceptanceBytes,
			reason: "Witness input is invalid.",
		});
	const requestText = validText(request.requestBytes);
	const intentBytes = request.intentBytes.slice();
	let acceptanceBytes = request.acceptanceBytes.slice();
	if (
		requestText === null ||
		validText(intentBytes) === null ||
		validText(acceptanceBytes) === null
	)
		return unproven({
			gateRuns: 0,
			adjudicationRounds: 0,
			acceptanceBytes,
			reason: "Witness source bytes are not valid UTF-8.",
		});
	const concerns: string[] = [];
	let gateRuns = 0;
	let adjudicationRounds = 0;
	while (true) {
		let gate: WitnessGateResult;
		try {
			gateRuns += 1;
			gate = await request.effects.runGate({
				slug: request.slug,
				baseSha: request.baseSha,
				intentBytes: intentBytes.slice(),
				acceptanceBytes: acceptanceBytes.slice(),
				round: gateRuns,
				difficulty: request.difficulty,
				rungs: request.difficulty === "hard" ? ["R1", "R2"] : ["R1"],
				parallelRungs: request.difficulty === "hard",
				workspace: "throwaway",
				sandbox: true,
				realGate: true,
				auditorDemotion: false,
			});
		} catch (cause) {
			return unproven({
				gateRuns,
				adjudicationRounds,
				acceptanceBytes,
				concerns,
				reason: cause instanceof Error ? cause.message : "Witness gate failed.",
			});
		}
		if (gate.kind === "stopped")
			return unproven({
				gateRuns,
				adjudicationRounds,
				acceptanceBytes,
				concerns,
				reason: gate.reason,
			});
		if (gate.kind === "green") {
			if (
				gate.candidate.baseSha !== request.baseSha ||
				gate.candidate.parent !== request.baseSha ||
				!objectId(gate.candidate.commit) ||
				gate.candidate.commit.length !== request.baseSha.length ||
				!objectId(gate.candidate.parent)
			) {
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason:
						"Green witness does not bind a commit and diff to the resolved base.",
				});
			}
			const record: WitnessRecord = Object.freeze({
				verdict: concerns.length === 0 ? "PROVEN" : "PROVEN_WITH_CONCERNS",
				commit: gate.candidate.commit,
				diff_sha256: diffHash(gate.candidate.diff),
				base_sha: request.baseSha,
			});
			let published: Result<"created" | "same" | "conflict">;
			try {
				published = await request.effects.publishRef({
					ref: `refs/kogen/witness/${request.slug}`,
					commit: record.commit,
					expected: null,
				});
			} catch (cause) {
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason:
						cause instanceof Error
							? cause.message
							: "Witness ref publication failed.",
				});
			}
			if (!published.ok || published.value === "conflict")
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: published.ok
						? "Witness ref already names a different commit."
						: published.error.message,
				});
			return {
				verdict: record.verdict,
				witness: record,
				concerns: Object.freeze([...concerns]),
				gateRuns,
				adjudicationRounds,
				acceptanceBytes: acceptanceBytes.slice(),
				reason: null,
			};
		}
		const failureIds = gate.failures.map((failure) => failure.id);
		if (
			gate.failures.length === 0 ||
			new Set(failureIds).size !== failureIds.length ||
			failureIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id))
		)
			return unproven({
				gateRuns,
				adjudicationRounds,
				acceptanceBytes,
				concerns,
				reason:
					"Red witness has no complete set of adjudicable assertion failures.",
			});
		if (adjudicationRounds >= request.witnessRounds)
			return unproven({
				gateRuns,
				adjudicationRounds,
				acceptanceBytes,
				concerns,
				reason: "Witness adjudication round limit reached.",
			});
		adjudicationRounds += 1;
		let acceptanceText: string;
		try {
			acceptanceText = DECODER.decode(acceptanceBytes);
			const message = witnessAdjudicationMessage({
				request: requestText,
				acceptance: acceptanceText,
				failures: gate.failures,
			});
			const session = createWitnessAdjudicationSession({
				source: request.sourceSession,
				role: request.auditorRole,
				round: adjudicationRounds,
				message,
			});
			request.onAdjudicationRequest?.();
			const response = await request.requestModel(session, request.auditorRole);
			if (
				response.kind !== "completed" ||
				response.response.tool_calls.length !== 0
			) {
				concerns.push(
					"Witness adjudication was unavailable or proposed tools.",
				);
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: "Witness adjudication did not return a tool-less result.",
				});
			}
			const parsed = parseWitnessAdjudication(
				response.response.text,
				failureIds,
			);
			for (const warning of parsed.warnings) concerns.push(warning);
			const directives: WitnessRepairDirective[] = [];
			for (const item of parsed.items) {
				if (item.verdict === "UNDECIDED") {
					concerns.push(
						`feasibility_concern ${item.id}: ${item.reason || "Adjudication was undecided."}`,
					);
				} else {
					directives.push({
						id: item.id,
						kind: item.verdict === "TEST-WRONG" ? "test" : "witness",
						citation: item.citation,
						reason: item.reason,
					});
				}
			}
			if (directives.length === 0)
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: "Witness adjudication left all failed items unresolved.",
				});
			const previousAcceptance = acceptanceBytes.slice();
			const repaired = await request.effects.repair({
				slug: request.slug,
				round: adjudicationRounds,
				intentBytes: intentBytes.slice(),
				acceptanceBytes: acceptanceBytes.slice(),
				directives: Object.freeze(directives),
			});
			if (!repaired.ok)
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: repaired.error.message,
				});
			const hasTestRepair = directives.some((item) => item.kind === "test");
			if (!hasTestRepair && !bytesEqual(previousAcceptance, repaired.value))
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: "Witness-only repair changed the acceptance test bytes.",
				});
			acceptanceBytes = repaired.value.slice();
			if (
				hasTestRepair &&
				!(await request.effects.validate({
					intentBytes: intentBytes.slice(),
					acceptanceBytes: acceptanceBytes.slice(),
				}))
			)
				return unproven({
					gateRuns,
					adjudicationRounds,
					acceptanceBytes,
					concerns,
					reason: "Corrected acceptance test did not pass Shape validation.",
				});
		} catch (cause) {
			return unproven({
				gateRuns,
				adjudicationRounds,
				acceptanceBytes,
				concerns,
				reason:
					cause instanceof Error
						? cause.message
						: "Witness adjudication or repair failed.",
			});
		}
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

/** Read a validated record from approval metadata without trusting its fields. */
export function parseWitnessRecord(value: unknown): WitnessRecord | null {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 4 ||
		(value.verdict !== "PROVEN" && value.verdict !== "PROVEN_WITH_CONCERNS") ||
		typeof value.commit !== "string" ||
		!OBJECT_ID.test(value.commit) ||
		typeof value.diff_sha256 !== "string" ||
		!SHA256.test(value.diff_sha256) ||
		typeof value.base_sha !== "string" ||
		!OBJECT_ID.test(value.base_sha) ||
		value.commit.length !== value.base_sha.length
	)
		return null;
	return Object.freeze({
		verdict: value.verdict,
		commit: value.commit,
		diff_sha256: value.diff_sha256,
		base_sha: value.base_sha,
	});
}
