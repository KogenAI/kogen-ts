import { createHash } from "node:crypto";
import {
	type ModelProvider,
	type ModelRole,
	modelProvider,
} from "../../project/roles";
import {
	SessionHistory,
	type SessionItemInput,
	type ToolResultInput,
} from "./history";
import {
	deriveSessionKeys,
	deriveThreadId,
	expandedRunDirectory,
	validateOpaqueId,
} from "./keys";
import {
	type CanonicalToolSchema,
	canonicalJson,
	DEFAULT_STATIC_PREFIX_REGISTRY,
	StaticPrefix,
	type StaticPrefixRegistry,
	type StaticPrefixVersion,
} from "./prefix";

export type SessionProvider = ModelProvider;
export type SessionAuthMode = "owned" | "injected";
export type SessionRole = ModelRole | "fallback_shaper";

export type RoleToolAuthorization = Readonly<
	Partial<Record<ModelRole, readonly string[]>>
>;

export interface CreateSessionInput {
	readonly runDirectory: string;
	readonly provider: SessionProvider;
	readonly authMode: SessionAuthMode;
	readonly role: SessionRole;
	readonly model: string;
	readonly effort: string;
	readonly stage: string;
	readonly attempt?: string;
	readonly rung?: string;
	readonly epoch?: string;
	readonly roleInstructions: string;
	readonly genericInstructions: string;
	readonly toolSchemas: readonly CanonicalToolSchema[];
	readonly toolSchemaVersion: string;
	readonly promptVersion: string;
	readonly adapterVersion: string;
	readonly securityNamespace?: string;
	readonly roleToolAuthorization: RoleToolAuthorization;
	readonly cacheKey?: string;
	readonly initialItems?: readonly SessionItemInput[];
	readonly prefixRegistry?: StaticPrefixRegistry;
}

export interface SessionState {
	readonly runDirectory: string;
	readonly provider: SessionProvider;
	readonly authMode: SessionAuthMode;
	readonly role: SessionRole;
	readonly effectiveRole: ModelRole;
	readonly model: string;
	readonly effort: string;
	readonly stage: string;
	readonly attempt: string;
	readonly rung: string;
	readonly epoch: string;
	readonly cacheKey: string;
	readonly threadId: string;
	readonly protocolSessionId: string;
	readonly roleInstructions: string;
	readonly roleToolAuthorization: RoleToolAuthorization;
	readonly authorizedTools: readonly string[];
	readonly prefixVersion: StaticPrefixVersion;
	readonly prefix: StaticPrefix;
	readonly history: SessionHistory;
	readonly continuationBase: SessionHistory;
	readonly prefixRegistry: StaticPrefixRegistry;
}

export type SessionEvent =
	| { readonly type: "retry" }
	| {
			readonly type: "append_turn";
			readonly responseItems: readonly Uint8Array[];
			readonly toolResults?: readonly ToolResultInput[];
			readonly userNotes?: readonly string[];
	  }
	| {
			readonly type: "append_items";
			readonly items: readonly SessionItemInput[];
	  }
	| {
			readonly type: "model_switch";
			readonly model: string;
			readonly effort: string;
	  }
	| {
			readonly type: "start_conversation";
			readonly stage: string;
			readonly attempt?: string;
			readonly rung?: string;
			readonly epoch?: string;
			readonly role?: SessionRole;
			readonly roleInstructions?: string;
			readonly model?: string;
			readonly effort?: string;
			readonly initialItems?: readonly SessionItemInput[];
	  }
	| {
			readonly type: "accept_checkpoint";
			readonly turn: number;
			readonly item: SessionItemInput;
	  };

const VALID_ROLE_NAMES = new Set<string>([
	"builder",
	"planner",
	"shaper",
	"auditor",
	"reviewer",
	"context",
	"fallback_shaper",
]);

function effectiveRole(role: SessionRole): ModelRole {
	if (!VALID_ROLE_NAMES.has(role))
		throw new TypeError("Session role is invalid.");
	return role === "fallback_shaper" ? "shaper" : role;
}

function validateText(value: string, label: string, allowEmpty = false): void {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.includes("\0")
	)
		throw new TypeError(`${label} is invalid.`);
}

function validateSingleLineText(value: string, label: string): void {
	validateText(value, label);
	if (/[\r\n]/.test(value)) throw new TypeError(`${label} is invalid.`);
}

function validateProviderModel(provider: SessionProvider, model: string): void {
	validateSingleLineText(model, "Model");
	if (modelProvider(model) !== provider)
		throw new TypeError(`Model ${model} does not belong to ${provider}.`);
}

function copyAuthorization(
	input: RoleToolAuthorization,
	toolNames: ReadonlySet<string>,
): RoleToolAuthorization {
	const copied: Partial<Record<ModelRole, readonly string[]>> = {};
	for (const role of [
		"builder",
		"planner",
		"shaper",
		"auditor",
		"reviewer",
		"context",
	] as const) {
		const names = input[role];
		if (names === undefined) continue;
		if (!Array.isArray(names) || new Set(names).size !== names.length)
			throw new TypeError(`Tool authorization for ${role} is invalid.`);
		for (const name of names)
			if (typeof name !== "string" || !toolNames.has(name))
				throw new TypeError(
					`Tool authorization for ${role} references an unknown schema.`,
				);
		copied[role] = Object.freeze([...names]);
	}
	return Object.freeze(copied);
}

function createPrefixVersion(
	input: Pick<
		CreateSessionInput,
		| "provider"
		| "model"
		| "adapterVersion"
		| "promptVersion"
		| "toolSchemaVersion"
		| "securityNamespace"
	>,
): StaticPrefixVersion {
	return Object.freeze({
		provider: input.provider,
		model: input.model,
		adapterVersion: input.adapterVersion,
		promptVersion: input.promptVersion,
		toolSchemaVersion: input.toolSchemaVersion,
		...(input.securityNamespace === undefined
			? {}
			: { securityNamespace: input.securityNamespace }),
	});
}

function withPrefix(
	version: StaticPrefixVersion,
	genericInstructions: string,
	toolSchemas: readonly CanonicalToolSchema[],
	registry: StaticPrefixRegistry,
): StaticPrefix {
	return new StaticPrefix(
		{ version, genericInstructions, toolSchemas },
		registry,
	);
}

export function createSession(input: CreateSessionInput): SessionState {
	if (input.authMode !== "owned" && input.authMode !== "injected")
		throw new TypeError("Session auth mode is invalid.");
	const runDirectory = expandedRunDirectory(input.runDirectory);
	const role = input.role;
	const effective = effectiveRole(role);
	validateProviderModel(input.provider, input.model);
	validateSingleLineText(input.effort, "Effort");
	validateSingleLineText(input.stage, "Stage");
	validateText(input.roleInstructions, "Role instructions");
	const registry = input.prefixRegistry ?? DEFAULT_STATIC_PREFIX_REGISTRY;
	const version = createPrefixVersion(input);
	const prefix = withPrefix(
		version,
		input.genericInstructions,
		input.toolSchemas,
		registry,
	);
	const authorization = copyAuthorization(
		input.roleToolAuthorization,
		new Set(prefix.toolNames),
	);
	const allowedNames = authorization[effective];
	if (allowedNames === undefined)
		throw new TypeError(`No tool authorization is defined for ${effective}.`);
	const stageIdentity = {
		runDirectory,
		stage: input.stage,
		...(input.attempt === undefined ? {} : { attempt: input.attempt }),
		...(input.rung === undefined ? {} : { rung: input.rung }),
		...(input.epoch === undefined ? {} : { epoch: input.epoch }),
	};
	const keys = deriveSessionKeys(stageIdentity, input.cacheKey);
	const history = SessionHistory.fromItems(input.initialItems ?? []);
	const continuationBase = SessionHistory.fromItems(input.initialItems ?? []);
	return freezeSession({
		runDirectory,
		provider: input.provider,
		authMode: input.authMode,
		role,
		effectiveRole: effective,
		model: input.model,
		effort: input.effort,
		stage: input.stage,
		attempt: input.attempt ?? "builder",
		rung: input.rung ?? input.attempt ?? "builder",
		epoch: input.epoch ?? "initial",
		cacheKey: keys.cacheKey,
		threadId: keys.threadId,
		protocolSessionId: keys.protocolSessionId,
		roleInstructions: input.roleInstructions,
		roleToolAuthorization: authorization,
		authorizedTools: allowedNames,
		prefixVersion: version,
		prefix,
		history,
		continuationBase,
		prefixRegistry: registry,
	});
}

function freezeSession(state: SessionState): SessionState {
	return Object.freeze({
		...state,
		authorizedTools: Object.freeze([...state.authorizedTools]),
	});
}

function rebuildPrefix(state: SessionState, model: string): StaticPrefix {
	const version = Object.freeze({ ...state.prefixVersion, model });
	return withPrefix(
		version,
		state.prefix.genericInstructions,
		state.prefix.toolSchemas,
		state.prefixRegistry,
	);
}

function startConversation(
	state: SessionState,
	event: Extract<SessionEvent, { type: "start_conversation" }>,
): SessionState {
	const role = event.role ?? state.role;
	const resolvedRole = effectiveRole(role);
	validateSingleLineText(event.stage, "Stage");
	const authorization = state.roleToolAuthorization[resolvedRole];
	if (authorization === undefined)
		throw new TypeError(
			`No tool authorization is defined for ${resolvedRole}.`,
		);
	const model = event.model ?? state.model;
	validateProviderModel(state.provider, model);
	validateSingleLineText(event.effort ?? state.effort, "Effort");
	validateText(
		event.roleInstructions ?? state.roleInstructions,
		"Role instructions",
	);
	const attempt = event.attempt ?? "builder";
	const rung = event.rung ?? attempt;
	const epoch = event.epoch ?? "initial";
	const threadId = deriveThreadId({
		runDirectory: state.runDirectory,
		stage: event.stage,
		attempt,
		rung,
		epoch,
	});
	const prefix =
		model === state.model ? state.prefix : rebuildPrefix(state, model);
	const history = SessionHistory.fromItems(event.initialItems ?? []);
	return freezeSession({
		...state,
		role,
		effectiveRole: resolvedRole,
		model,
		effort: event.effort ?? state.effort,
		stage: event.stage,
		attempt,
		rung,
		epoch,
		threadId,
		roleInstructions: event.roleInstructions ?? state.roleInstructions,
		authorizedTools: authorization,
		prefixVersion: prefix.version,
		prefix,
		history,
		continuationBase: SessionHistory.fromItems(event.initialItems ?? []),
	});
}

function isContinuationItem(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const record = value as Record<string, unknown>;
	if (record.role !== "user" || !Array.isArray(record.content)) return false;
	return record.content.some((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			return false;
		const content = entry as Record<string, unknown>;
		return (
			content.type === "input_text" &&
			typeof content.text === "string" &&
			content.text.startsWith("Continuation of the same approved Build.\n\n")
		);
	});
}

function checkpointEpoch(item: SessionItemInput): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(item.bytes),
		);
	} catch (cause) {
		throw new TypeError("Checkpoint item must be valid UTF-8 JSON.", { cause });
	}
	if (!isContinuationItem(parsed))
		throw new TypeError("Checkpoint item lacks the exact continuation marker.");
	const canonical = new TextEncoder().encode(canonicalJson(parsed));
	return createHash("sha256").update(canonical).digest("hex");
}

export function stepSession(
	state: SessionState,
	event: SessionEvent,
): SessionState {
	switch (event.type) {
		case "retry":
			return state;
		case "append_items":
			return freezeSession({
				...state,
				history: state.history.append(event.items),
			});
		case "append_turn":
			return freezeSession({
				...state,
				history: state.history.appendTurn({
					responseItems: event.responseItems,
					model: state.model,
					...(event.toolResults === undefined
						? {}
						: { toolResults: event.toolResults }),
					...(event.userNotes === undefined
						? {}
						: { userNotes: event.userNotes }),
				}),
			});
		case "model_switch": {
			validateProviderModel(state.provider, event.model);
			validateSingleLineText(event.effort, "Effort");
			return freezeSession({
				...state,
				model: event.model,
				effort: event.effort,
				prefixVersion: Object.freeze({
					...state.prefixVersion,
					model: event.model,
				}),
				prefix: rebuildPrefix(state, event.model),
				history: state.history.withoutEncryptedReasoningFromOtherModels(
					event.model,
				),
			});
		}
		case "start_conversation":
			return startConversation(state, event);
		case "accept_checkpoint": {
			if (!Number.isSafeInteger(event.turn) || event.turn < 0)
				throw new TypeError("Checkpoint turn must be a non-negative integer.");
			const epoch = checkpointEpoch(event.item);
			const history = SessionHistory.fromItems([
				...state.continuationBase.snapshotItems(),
				event.item,
			]);
			return freezeSession({
				...state,
				epoch,
				threadId: deriveThreadId({
					runDirectory: state.runDirectory,
					stage: state.stage,
					attempt: state.attempt,
					rung: state.rung,
					epoch,
				}),
				history,
			});
		}
	}
}

export function newConversation(
	state: SessionState,
	event: Extract<SessionEvent, { type: "start_conversation" }>,
): SessionState {
	return startConversation(state, event);
}

export function selectedRoleAuthorization(
	state: SessionState,
): readonly string[] {
	return state.authorizedTools;
}

export function providerForSession(state: SessionState): SessionProvider {
	return state.provider;
}

export function opaqueSessionKey(value: string): string {
	return validateOpaqueId(value, "session key");
}
