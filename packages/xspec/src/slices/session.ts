import type { ModelProvider, ModelRole } from "../../../core/src/project/roles";
import {
	responseItemBytes,
	userMessageBytes,
} from "../../../core/src/provider/session/history";
import {
	StaticPrefix,
	StaticPrefixRegistry,
	type StaticPrefixVersion,
} from "../../../core/src/provider/session/prefix";
import {
	createSession,
	newConversation,
	type SessionRole,
	type SessionState,
	stepSession,
} from "../../../core/src/provider/session/transition";
import { encodeSessionRequest } from "../../../core/src/provider/session/wire";
import { decodeSliceEvent, type XspecSlice } from "../protocol";

const RUN_ROOT = "/tmp/kogen-xspec-session";
const GENERIC_INSTRUCTIONS = "Use the frozen Kogen provider request protocol.";
const TOOL_AUTHORIZATION = {
	builder: [],
	planner: [],
	shaper: [],
	auditor: [],
	reviewer: [],
	context: [],
} as const;

const MODEL_NAMES = {
	luna: "gpt-6-luna",
	sol: "gpt-6.1-sol",
} as const;

type ModelAlias = "luna" | "sol";

interface SessionObservation {
	version: string;
	stage: string;
	attempt: string;
	rung: string;
	epoch: string;
	epochClass: string;
	model: string;
	runName: string;
	affinityChanged: boolean;
	previous: boolean;
	keyChanged: boolean;
	lite: string;
	last: string;
	sharedAffinity: boolean;
	prefixes: Record<string, string>;
}

interface SessionRuntime {
	observation: SessionObservation;
	session: SessionState | null;
	readonly registry: StaticPrefixRegistry;
	priorRunName: string;
	sharedCacheKey: string | null;
	actualEpoch: string;
	lastWire: Uint8Array | null;
}

function emptyObservation(): SessionObservation {
	return {
		version: "",
		stage: "",
		attempt: "",
		rung: "",
		epoch: "",
		epochClass: "",
		model: "",
		runName: "run-1",
		affinityChanged: false,
		previous: false,
		keyChanged: false,
		lite: "",
		last: "ok",
		sharedAffinity: false,
		prefixes: Object.create(null) as Record<string, string>,
	};
}

function freshRuntime(): SessionRuntime {
	return {
		observation: emptyObservation(),
		session: null,
		registry: new StaticPrefixRegistry(),
		priorRunName: "run-1",
		sharedCacheKey: null,
		actualEpoch: "",
		lastWire: null,
	};
}

function eventObject(
	value: unknown,
	tag: string,
	fields: readonly string[],
): Record<string, unknown> | null {
	const decoded = decodeSliceEvent(value);
	if (decoded.tag !== tag || decoded.value === undefined) return null;
	if (
		Object.keys(decoded.value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(decoded.value ?? {}, field))
	)
		return null;
	return decoded.value;
}

function stringField(
	value: Record<string, unknown>,
	key: string,
): string | null {
	return typeof value[key] === "string" ? (value[key] as string) : null;
}

function booleanField(
	value: Record<string, unknown>,
	key: string,
): boolean | null {
	return typeof value[key] === "boolean" ? (value[key] as boolean) : null;
}

function runDirectory(runName: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(runName))
		throw new TypeError("Xspec run identity is not a safe path component.");
	return `${RUN_ROOT}/${runName}`;
}

function aliasModel(value: string): ModelAlias | null {
	if (value === "luna" || value === "sol") return value;
	return null;
}

function apiModel(alias: ModelAlias): string {
	return MODEL_NAMES[alias];
}

function roleForStage(stage: string): ModelRole {
	return stage === "plan" ? "planner" : "builder";
}

function sessionModel(runtime: SessionRuntime, stage: string): string {
	if (runtime.session !== null) return runtime.session.model;
	return apiModel(stage === "plan" ? "sol" : "luna");
}

function modelRole(role: ModelRole): SessionRole {
	return role;
}

function makeSession(
	runtime: SessionRuntime,
	input: {
		runName: string;
		stage: string;
		attempt: string;
		rung: string;
		epoch: string;
		model: string;
		role: ModelRole;
		cacheKey?: string;
	},
): SessionState {
	const model = input.model;
	const provider: ModelProvider = model.startsWith("grok-")
		? "grok"
		: "chatgpt";
	const reasoning = responseItemBytes({
		type: "reasoning",
		encrypted_content: `fixture-reasoning:${model}`,
	});
	return createSession({
		runDirectory: runDirectory(input.runName),
		provider,
		authMode: "injected",
		role: modelRole(input.role),
		model,
		effort:
			provider === "grok"
				? "high"
				: model === MODEL_NAMES.luna
					? "max"
					: "high",
		stage: input.stage,
		attempt: input.attempt,
		rung: input.rung,
		epoch: input.epoch,
		roleInstructions: `You are Kogen's ${input.role}.`,
		genericInstructions: GENERIC_INSTRUCTIONS,
		toolSchemas: [],
		toolSchemaVersion: "xspec-session-tools-v1",
		promptVersion: "xspec-session-prompt-v1",
		adapterVersion: "responses-v1",
		roleToolAuthorization: TOOL_AUTHORIZATION,
		prefixRegistry: runtime.registry,
		initialItems: [
			{ bytes: userMessageBytes("approved"), kind: "message" },
			{
				bytes: reasoning,
				kind: "reasoning",
				model,
				encrypted: true,
			},
		],
		...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
	});
}

function transitionConversation(
	runtime: SessionRuntime,
	input: {
		stage: string;
		attempt: string;
		rung: string;
		epoch: string;
		role?: ModelRole;
	},
): void {
	const current = runtime.session;
	const next =
		current === null
			? makeSession(runtime, {
					runName: runtime.observation.runName,
					stage: input.stage,
					attempt: input.attempt,
					rung: input.rung,
					epoch: input.epoch,
					model: sessionModel(runtime, input.stage),
					role: input.role ?? roleForStage(input.stage),
					...(runtime.observation.sharedAffinity &&
					runtime.sharedCacheKey !== null
						? { cacheKey: runtime.sharedCacheKey }
						: {}),
				})
			: newConversation(current, {
					type: "start_conversation",
					stage: input.stage,
					attempt: input.attempt,
					rung: input.rung,
					epoch: input.epoch,
					role: input.role ?? roleForStage(input.stage),
				});
	runtime.session = next;
	runtime.actualEpoch = input.epoch;
	runtime.observation.keyChanged =
		current !== null && current.threadId !== next.threadId;
	runtime.observation.affinityChanged = false;
	runtime.lastWire = null;
}

function bind(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Bind", ["stage", "attempt", "rung"]);
	const stage = object === null ? null : stringField(object, "stage");
	const attemptInput = object === null ? null : stringField(object, "attempt");
	const rungInput = object === null ? null : stringField(object, "rung");
	const knownAttempts = ["", "builder", "fresh-1", "fresh-2", "escalation"];
	const knownRungs = ["", "builder", "1", "2", "fresh-1"];
	if (
		(stage !== "develop" && stage !== "plan") ||
		attemptInput === null ||
		rungInput === null ||
		!knownAttempts.includes(attemptInput) ||
		!knownRungs.includes(rungInput)
	) {
		state.last = "bad_bind";
		return;
	}
	const attempt = attemptInput === "" ? "builder" : attemptInput;
	const rung = rungInput === "" ? attempt : rungInput;
	const same =
		state.stage === stage &&
		state.attempt === attempt &&
		state.rung === rung &&
		state.epoch === "initial";
	const previousThreadId = runtime.session?.threadId ?? null;
	transitionConversation(runtime, {
		stage,
		attempt,
		rung,
		epoch: "initial",
		role: roleForStage(stage),
	});
	state.version = "v2";
	state.stage = stage;
	state.attempt = attempt;
	state.rung = rung;
	state.epoch = "initial";
	state.epochClass = "initial";
	state.keyChanged =
		previousThreadId !== null &&
		previousThreadId !== runtime.session?.threadId &&
		!same;
	state.last = "ok";
}

function touch(runtime: SessionRuntime): void {
	const state = runtime.observation;
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	runtime.lastWire = encodeSessionRequest(runtime.session).body;
	runtime.session = stepSession(runtime.session, { type: "retry" });
	state.keyChanged = false;
	state.affinityChanged = false;
	state.last = "ok";
}

function chooseModel(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Model", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	const alias = name === null ? null : aliasModel(name);
	if (alias === null) {
		state.last = "bad_model";
		return;
	}
	const model = apiModel(alias);
	runtime.session = stepSession(runtime.session, {
		type: "model_switch",
		model,
		effort: alias === "luna" ? "max" : "medium",
	});
	state.model = alias;
	state.keyChanged = false;
	state.affinityChanged = false;
	state.last = "ok";
}

function setStage(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Stage", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	if (name !== "develop" && name !== "plan") {
		state.last = "bad_bind";
		return;
	}
	transitionConversation(runtime, {
		stage: name,
		attempt: state.attempt,
		rung: state.rung,
		epoch: runtime.actualEpoch,
		role: roleForStage(name),
	});
	state.stage = name;
	state.last = "ok";
}

function setAttempt(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Attempt", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	if (!["builder", "fresh-1", "fresh-2", "escalation"].includes(name ?? "")) {
		state.last = "bad_bind";
		return;
	}
	transitionConversation(runtime, {
		stage: state.stage,
		attempt: name as string,
		rung: state.rung,
		epoch: runtime.actualEpoch,
	});
	state.attempt = name as string;
	state.last = "ok";
}

function setRung(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Rung", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	if (!["1", "2", "builder", "fresh-1"].includes(name ?? "")) {
		state.last = "bad_bind";
		return;
	}
	transitionConversation(runtime, {
		stage: state.stage,
		attempt: state.attempt,
		rung: name as string,
		epoch: runtime.actualEpoch,
	});
	state.rung = name as string;
	state.last = "ok";
}

function setEpoch(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Epoch", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	if (name !== "mutation-advice" && name !== "summarizer") {
		state.last = "bad_epoch";
		return;
	}
	const epoch = name === "summarizer" ? "checkpoint-1" : "mutation-advice";
	transitionConversation(runtime, {
		stage: state.stage,
		attempt: state.attempt,
		rung: state.rung,
		epoch,
	});
	state.epoch = epoch;
	state.epochClass = name === "summarizer" ? "checkpoint" : "mutation-advice";
	state.last = "ok";
}

function accept(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Accept", ["ok"]);
	const ok = object === null ? null : booleanField(object, "ok");
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	if (ok !== true) {
		state.last = "no_epoch";
		return;
	}
	const item = responseItemBytes({
		role: "user",
		content: [
			{
				type: "input_text",
				text: "Continuation of the same approved Build.\n\ncheckpoint summary",
			},
		],
	});
	const previousThread = runtime.session.threadId;
	runtime.session = stepSession(runtime.session, {
		type: "accept_checkpoint",
		turn: 0,
		item: { bytes: item, kind: "user_note" },
	});
	runtime.actualEpoch = runtime.session.epoch;
	state.epoch = "digest";
	state.epochClass = "checkpoint";
	state.keyChanged = previousThread !== runtime.session.threadId;
	state.affinityChanged = false;
	state.last = "ok";
}

function prefixTupleKey(parts: readonly string[]): string {
	return `[${parts.map((part) => `'${part.replaceAll("'", "\\'")}'`).join(", ")}]`;
}

function staticPrefix(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "Prefix", [
		"provider",
		"model",
		"adapter",
		"prompt",
		"bytes",
	]);
	const provider = object === null ? null : stringField(object, "provider");
	const model = object === null ? null : stringField(object, "model");
	const adapter = object === null ? null : stringField(object, "adapter");
	const prompt = object === null ? null : stringField(object, "prompt");
	const bytes = object === null ? null : stringField(object, "bytes");
	if (
		provider === null ||
		model === null ||
		adapter === null ||
		prompt === null ||
		bytes === null ||
		provider === "" ||
		model === "" ||
		adapter === "" ||
		prompt === "" ||
		bytes === ""
	) {
		state.last = "bad_prefix";
		return;
	}
	const providerName: ModelProvider | null =
		provider === "chatgpt" ? "chatgpt" : provider === "grok" ? "grok" : null;
	const alias = aliasModel(model);
	const actualModel = alias === null ? model : apiModel(alias);
	if (
		providerName === null ||
		(actualModel.startsWith("grok-") ? "grok" : "chatgpt") !== providerName
	) {
		state.last = "bad_prefix";
		return;
	}
	const version: StaticPrefixVersion = {
		provider: providerName,
		model: actualModel,
		adapterVersion: adapter,
		promptVersion: prompt,
		toolSchemaVersion: "xspec-session-prefix-v1",
	};
	try {
		new StaticPrefix(
			{ version, genericInstructions: bytes, toolSchemas: [] },
			runtime.registry,
		);
	} catch (cause) {
		if (cause instanceof TypeError && cause.message.includes("version change"))
			state.last = "static_prefix_changed";
		else state.last = "bad_prefix";
		return;
	}
	state.prefixes[prefixTupleKey([provider, model, adapter, prompt])] = bytes;
	state.last = "ok";
}

function newRun(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "NewRun", ["name"]);
	const name = object === null ? null : stringField(object, "name");
	if (name === null || name === "" || name === state.runName) {
		state.last = "bad_run";
		return;
	}
	const oldRunName = state.runName;
	const oldCacheKey =
		runtime.session?.cacheKey ??
		makeSession(runtime, {
			runName: oldRunName,
			stage: "develop",
			attempt: "builder",
			rung: "builder",
			epoch: "initial",
			model: apiModel("luna"),
			role: "builder",
		}).cacheKey;
	const sharedKey = state.sharedAffinity
		? (runtime.sharedCacheKey ?? oldCacheKey)
		: null;
	runtime.priorRunName = oldRunName;
	runtime.sharedCacheKey = sharedKey;
	runtime.session = null;
	runtime.actualEpoch = "";
	runtime.lastWire = null;
	const prefixes = state.prefixes;
	const sharedAffinity = state.sharedAffinity;
	runtime.observation = {
		...emptyObservation(),
		runName: name,
		sharedAffinity,
		prefixes,
		affinityChanged: !sharedAffinity,
		last: "ok",
	};
}

function setAffinityScope(runtime: SessionRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "AffinityScope", ["shared"]);
	const shared = object === null ? null : booleanField(object, "shared");
	if (state.version !== "") {
		state.last = "already_bound";
		return;
	}
	if (shared === null) {
		state.last = "bad_event";
		return;
	}
	state.sharedAffinity = shared;
	state.affinityChanged = false;
	state.last = "ok";
}

function lite(runtime: SessionRuntime): void {
	const state = runtime.observation;
	if (runtime.session === null) {
		state.last = "not_bound";
		return;
	}
	const request = encodeSessionRequest(runtime.session);
	runtime.lastWire = request.body;
	state.lite =
		runtime.session.protocolSessionId !== runtime.session.cacheKey ? "v1" : "";
	state.keyChanged = false;
	state.affinityChanged = false;
	state.last = state.lite === "v1" ? "ok" : "bad_lite";
}

function previous(runtime: SessionRuntime): void {
	const state = runtime.observation;
	if (runtime.session !== null) {
		const request = encodeSessionRequest(runtime.session);
		runtime.lastWire = request.body;
		state.previous = new TextDecoder()
			.decode(request.body)
			.includes("previous_response_id");
	}
	state.last = state.previous ? "sent" : "never_sent";
}

function modelObservation(runtime: SessionRuntime): SessionObservation {
	const state = runtime.observation;
	return {
		version: state.version,
		stage: state.stage,
		attempt: state.attempt,
		rung: state.rung,
		epoch: state.epoch,
		epochClass: state.epochClass,
		model: state.model,
		runName: state.runName,
		affinityChanged: state.affinityChanged,
		previous: state.previous,
		keyChanged: state.keyChanged,
		lite: state.lite,
		last: state.last,
		sharedAffinity: state.sharedAffinity,
		prefixes: Object.fromEntries(
			Object.entries(state.prefixes).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
	};
}

export function createSessionSlice(): XspecSlice {
	let runtime = freshRuntime();
	return {
		async reset() {
			runtime = freshRuntime();
			return modelObservation(runtime);
		},
		async apply(event: unknown) {
			const decoded = decodeSliceEvent(event);
			switch (decoded.tag) {
				case "Init":
					runtime = freshRuntime();
					break;
				case "Bind":
					bind(runtime, event);
					break;
				case "Turn":
				case "Repair":
					touch(runtime);
					break;
				case "Model":
					chooseModel(runtime, event);
					break;
				case "Stage":
					setStage(runtime, event);
					break;
				case "Attempt":
					setAttempt(runtime, event);
					break;
				case "Rung":
					setRung(runtime, event);
					break;
				case "Epoch":
					setEpoch(runtime, event);
					break;
				case "Accept":
					accept(runtime, event);
					break;
				case "Previous":
					previous(runtime);
					break;
				case "Lite":
					lite(runtime);
					break;
				case "NewRun":
					newRun(runtime, event);
					break;
				case "AffinityScope":
					setAffinityScope(runtime, event);
					break;
				case "Prefix":
					staticPrefix(runtime, event);
					break;
				default:
					runtime.observation.last = "bad_event";
			}
			return modelObservation(runtime);
		},
	};
}
