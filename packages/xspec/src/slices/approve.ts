import type { ApprovalCheckStatus } from "../../../core/src/approval/card";
import { hashApprovalBytes } from "../../../core/src/intent/hash";
import { lintIntent } from "../../../core/src/intent/lint";
import { parseIntent } from "../../../core/src/intent/parse";
import {
	type ApprovalFixtureDriver,
	createApprovalFixtureDriver,
	type FixtureLateMutation,
	fixtureAcceptanceBytes,
	fixtureIntentBytes,
	fixtureSymbolForDigest,
} from "../../../test-support/src/approval-fixture";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

interface ApprovalRecord {
	readonly n: number;
	readonly sha: string;
	readonly by: string;
	readonly commit: string;
	readonly base: string;
	readonly feas: string;
}

interface ApprovalState {
	readonly approvals: Record<string, ApprovalRecord>;
	readonly caches: Map<string, string>;
	lastCache: readonly [string, string];
	checkRuns: number;
	last: string;
	exit: number;
	sha8: string;
	approver: string;
	feas: string;
	bwarn: boolean;
	lwarn: boolean;
	ran: boolean;
}

interface ApproveEvent {
	readonly slug: string;
	readonly given: string;
	readonly prefixOk: boolean;
	readonly stableBeforeCas: boolean;
	readonly newSha8: string;
	readonly sha: string;
	readonly sha8: string;
	readonly by: string;
	readonly byBad: boolean;
	readonly ident: string;
	readonly parseErr: boolean;
	readonly lintErr: boolean;
	readonly lintWarn: boolean;
	readonly missing: boolean;
	readonly setup: string;
	readonly baseTree: string;
	readonly cacheKey: string;
	readonly baseline: string;
	readonly acceptance: string;
	readonly witnessMode: boolean;
	readonly feas: string;
	readonly commit: string;
	readonly baseSha: string;
}

const ENCODER = new TextEncoder();
const FIXTURE_AUTHOR = "Kogen Fixture <fixture@kogen.invalid>";

function emptyState(): ApprovalState {
	return {
		approvals: Object.create(null) as Record<string, ApprovalRecord>,
		caches: new Map(),
		lastCache: ["", ""],
		checkRuns: 0,
		last: "ok",
		exit: 0,
		sha8: "",
		approver: "",
		feas: "",
		bwarn: false,
		lwarn: false,
		ran: false,
	};
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new XspecProtocolError(
			"invalid_event",
			`Approve.${key} must be a string`,
		);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean")
		throw new XspecProtocolError(
			"invalid_event",
			`Approve.${key} must be a boolean`,
		);
	return field;
}

function decodeApproveEvent(event: unknown): ApproveEvent {
	const decoded = decodeSliceEvent(event);
	if (decoded.tag !== "Approve" || decoded.value === undefined)
		throw new XspecProtocolError(
			"invalid_event",
			"approve slice accepts only Approve events",
		);
	const value = decoded.value;
	const required = [
		"slug",
		"given",
		"prefixOk",
		"stableBeforeCas",
		"newSha8",
		"sha",
		"sha8",
		"by",
		"byBad",
		"ident",
		"parseErr",
		"lintErr",
		"lintWarn",
		"missing",
		"setup",
		"baseTree",
		"cacheKey",
		"baseline",
		"acceptance",
		"witnessMode",
		"feas",
		"commit",
		"baseSha",
	];
	if (
		Object.keys(value).length !== required.length ||
		required.some((key) => !Object.hasOwn(value, key))
	)
		throw new XspecProtocolError(
			"invalid_event",
			"Approve event does not match the frozen field schema",
		);
	return {
		slug: stringField(value, "slug"),
		given: stringField(value, "given"),
		prefixOk: booleanField(value, "prefixOk"),
		stableBeforeCas: booleanField(value, "stableBeforeCas"),
		newSha8: stringField(value, "newSha8"),
		sha: stringField(value, "sha"),
		sha8: stringField(value, "sha8"),
		by: stringField(value, "by"),
		byBad: booleanField(value, "byBad"),
		ident: stringField(value, "ident"),
		parseErr: booleanField(value, "parseErr"),
		lintErr: booleanField(value, "lintErr"),
		lintWarn: booleanField(value, "lintWarn"),
		missing: booleanField(value, "missing"),
		setup: stringField(value, "setup"),
		baseTree: stringField(value, "baseTree"),
		cacheKey: stringField(value, "cacheKey"),
		baseline: stringField(value, "baseline"),
		acceptance: stringField(value, "acceptance"),
		witnessMode: booleanField(value, "witnessMode"),
		feas: stringField(value, "feas"),
		commit: stringField(value, "commit"),
		baseSha: stringField(value, "baseSha"),
	};
}

function intentBytes(event: ApproveEvent): Uint8Array {
	if (event.parseErr) return ENCODER.encode("not an Intent\n");
	if (event.lintErr)
		return ENCODER.encode(
			"---\n" +
				"title: Fixture lint refusal\n" +
				"size: small\n" +
				"domains: [app]\n" +
				"---\n" +
				"Update the fixture output to its expected value.\n\n" +
				"## Acceptance\n\n## Verify\n",
		);
	let bytes = fixtureIntentBytes(event.slug, event.sha);
	if (event.lintWarn) {
		const text = new TextDecoder()
			.decode(bytes)
			.replace(
				"The fixture output contains its expected value.",
				"The fixture output contains its robust expected value.",
			);
		bytes = ENCODER.encode(text);
	}
	return bytes;
}

function alternateHexPrefix(digest: string, width: number): string {
	const length = Math.max(6, Math.min(width, digest.length));
	const first = digest[0] === "0" ? "1" : "0";
	return first + digest.slice(1, length);
}

/**
 * Model hashes are readable identities, not SHA-256 values. Bind the identity
 * to exact fixture bytes, calculate their digest, then resolve the supplied
 * identity prefix onto that digest before testing it. The event's prefixOk
 * boolean is intentionally ignored; this is the xspec I/O seam that prevents
 * a claimed symbolic hash from standing in for source-byte hashing.
 */
function resolveHashPrefix(
	event: ApproveEvent,
	actualDigest: string,
): { readonly givenHash: string; readonly prefixOk: boolean } {
	const identityMatches =
		event.given.length >= 6 &&
		/^[0-9a-f]+$/u.test(event.given) &&
		event.sha.startsWith(event.given);
	const givenHash = identityMatches
		? actualDigest.slice(0, event.given.length)
		: alternateHexPrefix(actualDigest, event.given.length);
	return { givenHash, prefixOk: actualDigest.startsWith(givenHash) };
}

function key(baseTree: string, cacheKey: string): string {
	return JSON.stringify([baseTree, cacheKey]);
}

function stop(state: ApprovalState, code: string, ran: boolean): void {
	state.last = code;
	state.exit = exitOf(code);
	state.ran = ran;
	state.sha8 = "";
	state.approver = "";
	state.feas = "";
	state.bwarn = false;
	state.lwarn = false;
}

function exitOf(code: string): number {
	if (code === "ok") return 0;
	if (code === "needs_decision") return 5;
	if (
		new Set([
			"intent/parse",
			"intent/lint",
			"intent/hash_mismatch",
			"intent/unproven",
			"check/acceptance_check_failed",
		]).has(code)
	)
		return 1;
	if (
		new Set([
			"usage",
			"intent/acceptance_missing",
			"intent/approval_identity_unavailable",
			"intent/approval_by_invalid",
		]).has(code)
	)
		return 2;
	return 3;
}

function observation(state: ApprovalState): unknown {
	return {
		last: state.last,
		exit: state.exit,
		sha8: state.sha8,
		approver: state.approver,
		feas: state.feas,
		bwarn: state.bwarn,
		lwarn: state.lwarn,
		ran: state.ran,
		checkRuns: state.checkRuns,
		cache: state.lastCache,
		approvals: state.approvals,
	};
}

function status(value: string): ApprovalCheckStatus {
	if (
		value === "green" ||
		value === "red" ||
		value === "unavailable" ||
		value === "timeout" ||
		value === "mutating"
	)
		return value;
	return "green";
}

async function runEffect(
	driver: ApprovalFixtureDriver,
	event: ApproveEvent,
	actualHash: string,
	actualGivenHash: string,
	lateMutation: FixtureLateMutation | undefined,
): Promise<void> {
	const feasible =
		event.feas === "PROVEN" || event.feas === "PROVEN with concerns";
	const witness = feasible
		? {
				verdict:
					event.feas === "PROVEN"
						? ("PROVEN" as const)
						: ("PROVEN_WITH_CONCERNS" as const),
				diff_sha256: "0".repeat(64),
			}
		: undefined;
	const result = await driver.approve({
		slug: event.slug,
		givenHash: actualGivenHash,
		...(event.by === "" ? {} : { by: event.by }),
		baseline: status(event.baseline),
		...(lateMutation === undefined ? {} : { lateMutation }),
		...(event.witnessMode
			? {
					witnessRequired: true,
					...(witness === undefined ? {} : { witness }),
				}
			: {}),
	});
	if (result.ok) {
		if (result.value.approvalSha256 !== actualHash)
			throw new XspecProtocolError(
				"invalid_event",
				"approval effect returned a digest that differs from exact fixture bytes",
			);
		return;
	}
	if (
		result.error.code !== "intent/hash_mismatch" &&
		result.error.code !== "intent/unproven"
	)
		throw new XspecProtocolError(
			"invalid_event",
			`approval effect failed unexpectedly: ${result.error.code}`,
		);
}

async function applyApprove(
	state: ApprovalState,
	driver: ApprovalFixtureDriver,
	event: ApproveEvent,
): Promise<unknown> {
	const isHashed = event.given !== "";
	const intentSource = intentBytes(event);
	let acceptanceSource = fixtureAcceptanceBytes(event.slug, event.sha);
	driver.writeSources(event.slug, {
		intent: intentSource,
		acceptance: acceptanceSource,
	});
	if (event.missing) driver.removeAcceptance(event.slug);
	const parsed = parseIntent(intentSource);
	const parseFailed = !parsed.ok;
	const findings = parsed.ok ? lintIntent(parsed.intent) : [];
	const lintFailed = findings.some((finding) => finding.severity === "error");
	const lintWarning = findings.some((finding) => finding.severity === "style");
	if (event.missing) acceptanceSource = new Uint8Array();
	const realApprovalHash = hashApprovalBytes(intentSource, acceptanceSource);
	const prefix = resolveHashPrefix(event, realApprovalHash);
	// --by selects the approval identity. Git still needs a hermetic commit
	// author for the fixture's actual commit-tree effect.
	const identity = event.by === "" ? event.ident : FIXTURE_AUTHOR;
	await driver.configureIdentity(identity);
	const approver = event.by !== "" ? event.by : event.ident;
	const hasByError =
		event.byBad ||
		(event.by !== "" &&
			(event.by.trim().length === 0 || /[\r\n\0]/u.test(event.by)));
	let actualLateMutation: FixtureLateMutation | undefined;
	if (!event.stableBeforeCas) {
		const changedIntent = fixtureIntentBytes(event.slug, event.newSha8);
		const changedAcceptance = fixtureAcceptanceBytes(event.slug, event.newSha8);
		actualLateMutation = {
			source: "intent",
			bytes: changedIntent,
		};
		// The source identity records a reversible symbol-to-byte binding. Hash
		// both before and after mutation; newSha8 is only the model-side name.
		fixtureSymbolForDigest(
			hashApprovalBytes(changedIntent, changedAcceptance),
			event.newSha8,
		);
	}
	const tupleKey = key(event.baseTree, event.cacheKey);
	let ran = false;
	let baseline = event.baseline;
	if (hasByError) stop(state, "intent/approval_by_invalid", false);
	else if (isHashed && event.missing)
		stop(state, "intent/acceptance_missing", false);
	else if (isHashed && !prefix.prefixOk) {
		stop(state, "intent/hash_mismatch", false);
		state.sha8 = event.sha8;
	} else if (parseFailed) stop(state, "intent/parse", false);
	else if (lintFailed) stop(state, "intent/lint", false);
	else if (event.missing) stop(state, "intent/acceptance_missing", false);
	else if (approver === "")
		stop(state, "intent/approval_identity_unavailable", false);
	else {
		const cacheHit = state.caches.has(tupleKey);
		if (!cacheHit && event.setup !== "ok")
			stop(state, "environment/setup_failed", false);
		else {
			baseline = cacheHit
				? (state.caches.get(tupleKey) ?? event.baseline)
				: event.baseline;
			ran = !cacheHit;
			if (!cacheHit) {
				state.caches.set(tupleKey, baseline);
				state.checkRuns += 1;
			}
			state.lastCache = [event.baseTree, event.cacheKey];
			if (event.acceptance === "tool_missing")
				stop(state, "environment/tool_missing", ran);
			else if (event.acceptance !== "green")
				stop(state, "check/acceptance_check_failed", ran);
			else if (!isHashed) {
				state.last = "needs_decision";
				state.exit = 5;
				state.sha8 = event.sha8;
				state.approver = approver;
				state.feas = event.feas;
				state.bwarn = baseline === "red";
				state.lwarn = lintWarning;
				state.ran = ran;
			} else if (!event.stableBeforeCas) {
				stop(state, "intent/hash_mismatch", ran);
				state.sha8 = event.newSha8;
			} else if (
				event.witnessMode &&
				event.feas !== "PROVEN" &&
				event.feas !== "PROVEN with concerns"
			) {
				stop(state, "intent/unproven", ran);
			} else {
				const actualHashWidth = event.given.length;
				const actualGivenHash = realApprovalHash.slice(0, actualHashWidth);
				const sourceMap = fixtureSymbolForDigest(realApprovalHash, event.sha);
				if (sourceMap.digest !== realApprovalHash)
					throw new XspecProtocolError(
						"invalid_event",
						"symbolic approval identity did not bind to actual source bytes",
					);
				await runEffect(
					driver,
					event,
					realApprovalHash,
					actualGivenHash,
					undefined,
				);
				const old = state.approvals[event.slug];
				state.approvals[event.slug] = {
					n: (old?.n ?? 0) + 1,
					sha: event.sha,
					by: approver,
					commit: event.commit,
					base: event.baseSha,
					feas: event.feas,
				};
				state.last = "ok";
				state.exit = 0;
				state.sha8 = event.sha8;
				state.approver = approver;
				state.feas = event.feas;
				state.bwarn = baseline === "red";
				state.lwarn = lintWarning;
				state.ran = ran;
			}
		}
	}
	if (
		state.last === "intent/hash_mismatch" &&
		isHashed &&
		!state.ran &&
		event.stableBeforeCas &&
		!event.missing &&
		!parseFailed &&
		!lintFailed &&
		approver !== ""
	) {
		await runEffect(
			driver,
			event,
			realApprovalHash,
			prefix.givenHash,
			undefined,
		);
	}
	if (
		state.last === "intent/hash_mismatch" &&
		isHashed &&
		event.stableBeforeCas === false &&
		!event.missing &&
		!parseFailed &&
		!lintFailed &&
		approver !== "" &&
		state.ran
	) {
		await runEffect(
			driver,
			event,
			realApprovalHash,
			prefix.givenHash,
			actualLateMutation,
		);
	}
	if (state.last === "needs_decision" || state.last === "ok") {
		state.bwarn = baseline === "red";
		state.lwarn = lintWarning;
	}
	return observation(state);
}

export async function createApproveSlice(): Promise<XspecSlice> {
	const driver = await createApprovalFixtureDriver();
	let state = emptyState();
	return {
		async reset() {
			await driver.reset();
			state = emptyState();
			return observation(state);
		},
		async apply(value: unknown) {
			const event = decodeApproveEvent(value);
			return applyApprove(state, driver, event);
		},
		close() {
			driver.close();
		},
	};
}
