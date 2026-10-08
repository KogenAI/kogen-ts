import type { IntentRemoveLifecycle } from "../../../core/src/approval/remove";
import { hashApprovalBytes } from "../../../core/src/intent/hash";
import { parseIntent } from "../../../core/src/intent/parse";
import {
	type ApprovalFixtureDriver,
	createApprovalFixtureDriver,
	type FixtureSourceBytes,
	fixtureAcceptanceBytes,
	fixtureIntentBytes,
	fixtureSymbolForDigest,
} from "../../../test-support/src/approval-fixture";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

interface ApprovalRefRecord {
	readonly n: number;
	readonly hash: string;
}

interface IntentState {
	readonly life: Record<string, string>;
	readonly refs: Record<string, ApprovalRefRecord>;
	readonly activeBuilds: Set<string>;
	readonly forceRequired: Set<string>;
	readonly danglingRefs: Set<string>;
	readonly landedSources: Set<string>;
	shown: string;
	casTries: number;
	did: string;
	last: string;
	exit: number;
}

const KNOWN_SLUGS = new Set(["alpha", "bravo"]);
const VALID_APPROVAL_IDENTITIES = new Set(["abcd1234", "bbbb2222", "cccc3333"]);

function emptyState(): IntentState {
	return {
		life: Object.create(null) as Record<string, string>,
		refs: Object.create(null) as Record<string, ApprovalRefRecord>,
		activeBuilds: new Set(),
		forceRequired: new Set(),
		danglingRefs: new Set(),
		landedSources: new Set(),
		shown: "",
		casTries: 0,
		did: "",
		last: "ok",
		exit: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventValue(value: unknown, tag: string): Record<string, unknown> {
	const decoded = decodeSliceEvent(value);
	if (decoded.tag !== tag || decoded.value === undefined)
		throw new XspecProtocolError(
			"invalid_event",
			`intent slice expected a ${tag} event`,
		);
	const expected =
		tag === "Shape"
			? ["slug", "result"]
			: tag === "Approve"
				? ["slug", "mode", "hash", "prefixOk", "race"]
				: tag === "Remove"
					? ["slug", "force"]
					: ["slug", "status"];
	if (
		Object.keys(decoded.value).length !== expected.length ||
		expected.some((key) => !Object.hasOwn(decoded.value ?? {}, key))
	)
		throw new XspecProtocolError(
			"invalid_event",
			`${tag} event does not match the frozen field schema`,
		);
	return decoded.value;
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new XspecProtocolError(
			"invalid_event",
			`${eventName(value)}.${key} must be a string`,
		);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean")
		throw new XspecProtocolError(
			"invalid_event",
			`${eventName(value)}.${key} must be a boolean`,
		);
	return field;
}

function eventName(value: Record<string, unknown>): string {
	return typeof value.__tag === "string" ? value.__tag : "Intent event";
}

function has(state: IntentState, slug: string): boolean {
	return Object.hasOwn(state.life, slug);
}

function lifeOf(state: IntentState, slug: string): string {
	return state.life[slug] ?? "";
}

function isBound(life: string): boolean {
	return new Set([
		"approved",
		"building",
		"failed",
		"parked",
		"interrupted",
		"landed",
	]).has(life);
}

function stop(state: IntentState, code: string): void {
	state.last = code;
	state.exit = exitOf(code);
	state.did = "";
	state.shown = "";
}

function exitOf(code: string): number {
	if (code === "ok") return 0;
	if (code === "needs_decision") return 5;
	if (code === "provider/overload") return 4;
	if (new Set(["candidate/repair_limit", "intent/hash_mismatch"]).has(code))
		return 1;
	if (
		new Set([
			"intent/not_found",
			"intent/request_unavailable",
			"intent/remove_blocked",
			"intent/remove_requires_force",
			"unknown_slug",
		]).has(code)
	)
		return 2;
	return 70;
}

function observation(state: IntentState): unknown {
	return {
		last: state.last,
		exit: state.exit,
		did: state.did,
		shown: state.shown,
		casTries: state.casTries,
		life: state.life,
		refs: state.refs,
	};
}

function writeShapeSource(slug: string, sequence: number): FixtureSourceBytes {
	return {
		intent: fixtureIntentBytes(slug, `shape-${String(sequence)}`),
		acceptance: fixtureAcceptanceBytes(slug, `shape-${String(sequence)}`),
	};
}

async function shape(
	state: IntentState,
	driver: ApprovalFixtureDriver,
	sequence: number,
	value: Record<string, unknown>,
): Promise<void> {
	const slug = stringField(value, "slug");
	const result = stringField(value, "result");
	if (!KNOWN_SLUGS.has(slug)) {
		stop(state, "unknown_slug");
		return;
	}
	if (result === "empty") {
		stop(state, "intent/request_unavailable");
		return;
	}
	if (result === "provider") {
		stop(state, "provider/overload");
		return;
	}
	if (result === "failed") {
		stop(state, "candidate/repair_limit");
		state.did = "shape_failed";
		return;
	}
	if (result !== "valid") {
		stop(state, "unknown_result");
		return;
	}
	if (isBound(lifeOf(state, slug))) {
		state.last = "ok";
		state.exit = 0;
		state.did = "shaped";
		state.shown = "";
		return;
	}
	const source = writeShapeSource(slug, sequence);
	const parsed = parseIntent(source.intent);
	if (!parsed.ok)
		throw new XspecProtocolError(
			"invalid_event",
			"valid Shape fixture did not parse as an Intent",
		);
	// Shape is represented by a tracked source pair in the real checkout so the
	// production remove transition exercises Git's path-limited removal.
	await driver.recordSources(slug, source);
	state.life[slug] = "shaped";
	state.last = "ok";
	state.exit = 0;
	state.did = "shaped";
	state.shown = "";
}

function alternatePrefix(digest: string): string {
	return (digest[0] === "0" ? "1" : "0") + digest.slice(1, 8);
}

function hashIdentity(
	hashSymbol: string,
	source: FixtureSourceBytes,
): {
	readonly actualDigest: string;
	readonly givenHash: string;
	readonly prefixOk: boolean;
} {
	const actualDigest = hashApprovalBytes(source.intent, source.acceptance);
	const isBoundIdentity = VALID_APPROVAL_IDENTITIES.has(hashSymbol);
	const givenHash = isBoundIdentity
		? actualDigest.slice(0, Math.min(hashSymbol.length, actualDigest.length))
		: alternatePrefix(actualDigest);
	return {
		actualDigest,
		givenHash,
		prefixOk: actualDigest.startsWith(givenHash),
	};
}

async function approve(
	state: IntentState,
	driver: ApprovalFixtureDriver,
	value: Record<string, unknown>,
): Promise<void> {
	const slug = stringField(value, "slug");
	const mode = stringField(value, "mode");
	const hash = stringField(value, "hash");
	const eventPrefixOk = booleanField(value, "prefixOk");
	const race = stringField(value, "race");
	if (!KNOWN_SLUGS.has(slug)) {
		stop(state, "unknown_slug");
		return;
	}
	if (!has(state, slug)) {
		stop(state, "intent/not_found");
		return;
	}
	if (mode === "card") {
		state.last = "needs_decision";
		state.exit = 5;
		state.did = "card";
		state.shown = hash;
		state.casTries = 0;
		return;
	}
	if (mode !== "commit") {
		stop(state, "unknown_mode");
		return;
	}
	if (race !== "none" && race !== "once" && race !== "twice") {
		stop(state, "unknown_race");
		return;
	}
	const current = driver.readSources(slug);
	const source = VALID_APPROVAL_IDENTITIES.has(hash)
		? {
				intent: fixtureIntentBytes(slug, hash),
				acceptance: fixtureAcceptanceBytes(slug, hash),
			}
		: current;
	driver.writeSources(slug, source);
	const resolved = hashIdentity(hash, source);
	// Bind each model-side hash identity to the source digest calculated from
	// real bytes. prefixOk is an injected modeling field and is not read here.
	fixtureSymbolForDigest(resolved.actualDigest, hash);
	const actualPrefixOk = resolved.prefixOk;
	void eventPrefixOk;
	if (!actualPrefixOk) {
		const failed = await driver.approve({
			slug,
			givenHash: resolved.givenHash,
		});
		if (failed.ok || failed.error.code !== "intent/hash_mismatch")
			throw new XspecProtocolError(
				"invalid_event",
				"real approval hash mismatch did not refuse before CAS",
			);
		stop(state, "intent/hash_mismatch");
		state.shown = hash;
		state.casTries = 0;
		return;
	}
	if (race === "twice") {
		const result = await driver.approve({
			slug,
			givenHash: resolved.givenHash,
			casRace: 2,
		});
		if (result.ok || result.error.code !== "environment/approval_cas_failed")
			throw new XspecProtocolError(
				"invalid_event",
				"real approval CAS did not exhaust both injected compare-and-swap races",
			);
		if (Object.hasOwn(state.refs, slug)) state.life[slug] = "approved";
		else state.danglingRefs.add(slug);
		state.last = "controller/approval_cas_lost";
		state.exit = 70;
		state.did = "";
		state.shown = "";
		state.casTries = 2;
		return;
	}
	const result = await driver.approve({
		slug,
		givenHash: resolved.givenHash,
		...(race === "once" ? { casRace: 1 as const } : {}),
	});
	if (!result.ok)
		throw new XspecProtocolError(
			"invalid_event",
			`real approval commit failed: ${result.error.code}`,
		);
	if (result.value.approvalSha256 !== resolved.actualDigest)
		throw new XspecProtocolError(
			"invalid_event",
			"approval ref does not bind the exact fixture source bytes",
		);
	const old = state.refs[slug];
	state.life[slug] = "approved";
	state.refs[slug] = { n: (old?.n ?? 0) + 1, hash };
	state.danglingRefs.delete(slug);
	state.last = "ok";
	state.exit = 0;
	state.did = "approved";
	state.shown = hash;
	state.casTries = race === "once" ? 2 : 1;
}

async function remove(
	state: IntentState,
	driver: ApprovalFixtureDriver,
	value: Record<string, unknown>,
): Promise<void> {
	const slug = stringField(value, "slug");
	const force = booleanField(value, "force");
	if (!KNOWN_SLUGS.has(slug)) {
		stop(state, "unknown_slug");
		return;
	}
	if (!has(state, slug)) {
		stop(state, "intent/not_found");
		return;
	}
	const landed =
		state.landedSources.has(slug) || lifeOf(state, slug) === "landed";
	const buildDisposition =
		lifeOf(state, slug) === "failed" ||
		lifeOf(state, slug) === "parked" ||
		lifeOf(state, slug) === "interrupted"
			? (lifeOf(state, slug) as "failed" | "parked" | "interrupted")
			: null;
	const lifecycle: IntentRemoveLifecycle = {
		activeBuild: state.activeBuilds.has(slug),
		landed,
		buildDisposition,
	};
	const result = await driver.remove({ slug, force, lifecycle });
	if (!result.ok) {
		const code = result.error.code;
		if (
			code === "intent/remove_blocked" ||
			code === "intent/remove_requires_force" ||
			code === "intent/not_found"
		) {
			stop(state, code);
			return;
		}
		throw new XspecProtocolError(
			"invalid_event",
			`real Intent removal failed: ${code}`,
		);
	}
	delete state.life[slug];
	delete state.refs[slug];
	state.danglingRefs.delete(slug);
	state.last = "ok";
	state.exit = 0;
	state.did = "removed";
	state.shown = "";
	state.casTries = 0;
}

async function adopt(
	state: IntentState,
	value: Record<string, unknown>,
): Promise<void> {
	const slug = stringField(value, "slug");
	const status = stringField(value, "status");
	if (!KNOWN_SLUGS.has(slug)) {
		stop(state, "unknown_slug");
		return;
	}
	if (
		!new Set(["building", "failed", "parked", "interrupted", "landed"]).has(
			status,
		)
	) {
		stop(state, "bad_adopt");
		return;
	}
	if (
		lifeOf(state, slug) !== "approved" &&
		!(lifeOf(state, slug) === "building" && status !== "building")
	) {
		stop(state, "bad_adopt");
		return;
	}
	state.life[slug] = status;
	if (status === "landed") {
		for (const name of Object.keys(state.life)) state.landedSources.add(name);
	}
	if (status === "building") state.activeBuilds.add(slug);
	else state.activeBuilds.delete(slug);
	if (status === "failed" || status === "parked" || status === "interrupted")
		state.forceRequired.add(slug);
	state.last = "ok";
	state.exit = 0;
	state.did = "adopted";
	state.shown = "";
}

async function applyIntentEvent(
	state: IntentState,
	driver: ApprovalFixtureDriver,
	value: unknown,
	sequence: number,
): Promise<unknown> {
	if (!isRecord(value) || typeof value.tag !== "string")
		throw new XspecProtocolError(
			"invalid_event",
			"Intent event must be tagged",
		);
	if (value.tag === "Shape") {
		await shape(state, driver, sequence, eventValue(value, "Shape"));
	} else if (value.tag === "Approve") {
		await approve(state, driver, eventValue(value, "Approve"));
	} else if (value.tag === "Remove") {
		await remove(state, driver, eventValue(value, "Remove"));
	} else if (value.tag === "Adopt") {
		await adopt(state, eventValue(value, "Adopt"));
	} else {
		throw new XspecProtocolError(
			"invalid_event",
			`intent slice does not accept event tag ${JSON.stringify(value.tag)}`,
		);
	}
	return observation(state);
}

export async function createIntentSlice(): Promise<XspecSlice> {
	const driver = await createApprovalFixtureDriver();
	let state = emptyState();
	let sequence = 0;
	return {
		async reset() {
			await driver.reset();
			state = emptyState();
			sequence = 0;
			return observation(state);
		},
		async apply(event: unknown) {
			sequence += 1;
			return applyIntentEvent(state, driver, event, sequence);
		},
		close() {
			driver.close();
		},
	};
}
