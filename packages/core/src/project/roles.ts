/** The role names accepted by `build.roles` in the frozen project schema. */
export const MODEL_ROLES = [
	"builder",
	"planner",
	"shaper",
	"auditor",
	"reviewer",
	"context",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelProvider = "chatgpt" | "grok";
export type RoleValue = Partial<{
	readonly model: string;
	readonly effort: string;
}>;
export type RoleOverrides = ReadonlyMap<ModelRole, RoleValue>;

export type RoleFieldSource = "project" | "machine" | "default";

export interface ModelRef {
	readonly provider: ModelProvider;
	readonly model: string;
	readonly effort: string;
}

export interface NamedRoleDefinition {
	readonly name: ModelRole;
	readonly defaultModel: Readonly<Record<ModelProvider, string>>;
	readonly defaultEffort: Readonly<Record<ModelProvider, string>>;
	readonly overloadFallback: Readonly<Partial<Record<ModelProvider, ModelRef>>>;
}

/**
 * This is the single admitted user-role table. `fallback_shaper` is deliberately
 * absent: it is an internal alias of the resolved shaper, not a role setting.
 */
export const NAMED_ROLE_TABLE: readonly NamedRoleDefinition[] = [
	{
		name: "builder",
		defaultModel: { chatgpt: "gpt-6-luna", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "max", grok: "high" },
		overloadFallback: {
			chatgpt: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
		},
	},
	{
		name: "planner",
		defaultModel: { chatgpt: "gpt-6.1-sol", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "high", grok: "high" },
		overloadFallback: {},
	},
	{
		name: "shaper",
		defaultModel: { chatgpt: "gpt-6.1-sol", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "high", grok: "high" },
		overloadFallback: {},
	},
	{
		name: "auditor",
		defaultModel: { chatgpt: "gpt-6.1-sol", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "high", grok: "high" },
		overloadFallback: {},
	},
	{
		name: "reviewer",
		defaultModel: { chatgpt: "gpt-6.1-sol", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "high", grok: "high" },
		overloadFallback: {
			chatgpt: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
		},
	},
	{
		name: "context",
		defaultModel: { chatgpt: "gpt-6.1-sol", grok: "grok-4.6" },
		defaultEffort: { chatgpt: "high", grok: "high" },
		overloadFallback: {
			chatgpt: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
		},
	},
];

export interface ResolvedRole {
	readonly name: ModelRole;
	readonly requested: Readonly<{
		model: string;
		effort: string;
	}>;
	readonly source: Readonly<{
		model: RoleFieldSource;
		effort: RoleFieldSource;
	}>;
	readonly effective: ModelRef;
	readonly overloadFallback: ModelRef | null;
}

export interface RoleResolutionInput {
	readonly provider?: ModelProvider;
	readonly project?: RoleOverrides;
	readonly machine?: RoleOverrides;
	readonly modelFallback?: boolean;
}

export interface RoleResolution {
	readonly provider: ModelProvider;
	readonly roles: Readonly<Record<ModelRole, ResolvedRole>>;
	readonly fallbackShaper: Readonly<{
		readonly aliasOf: "shaper";
		readonly effective: ModelRef;
	}>;
}

export interface RoleResolutionDiagnostic {
	readonly path: string;
	readonly message: string;
}

export type RoleResolutionResult =
	| { readonly ok: true; readonly value: RoleResolution }
	| {
			readonly ok: false;
			readonly diagnostics: readonly RoleResolutionDiagnostic[];
	  };

export function modelProvider(model: string): ModelProvider {
	return model.startsWith("grok-") ? "grok" : "chatgpt";
}

function sourceValue(
	projectValue: string | undefined,
	machineValue: string | undefined,
	defaultValue: string,
): { readonly value: string; readonly source: RoleFieldSource } {
	if (projectValue !== undefined)
		return { value: projectValue, source: "project" };
	if (machineValue !== undefined)
		return { value: machineValue, source: "machine" };
	return { value: defaultValue, source: "default" };
}

/**
 * Resolve all six admitted roles once, merging model and effort independently.
 * Provider-specific defaults make a Grok selection stay on Grok for every
 * configured or defaulted role. The fallback shaper reuses the effective
 * shaper exactly and has no independently configurable entry.
 */
export function resolveRoles(
	input: RoleResolutionInput = {},
): RoleResolutionResult {
	const provider = input.provider ?? "chatgpt";
	const diagnostics: RoleResolutionDiagnostic[] = [];
	const resolved = new Map<ModelRole, ResolvedRole>();
	const modelFallback = input.modelFallback ?? true;

	for (const definition of NAMED_ROLE_TABLE) {
		const projectValue = input.project?.get(definition.name);
		const machineValue = input.machine?.get(definition.name);
		const model = sourceValue(
			projectValue?.model,
			machineValue?.model,
			definition.defaultModel[provider],
		);
		const effort = sourceValue(
			projectValue?.effort,
			machineValue?.effort,
			definition.defaultEffort[provider],
		);
		const actualProvider = modelProvider(model.value);
		if (actualProvider !== provider) {
			diagnostics.push({
				path: `build.roles.${definition.name}.model`,
				message: `model ${JSON.stringify(model.value)} belongs to ${actualProvider}, but the selected provider is ${provider}`,
			});
		}
		resolved.set(definition.name, {
			name: definition.name,
			requested: { model: model.value, effort: effort.value },
			source: { model: model.source, effort: effort.source },
			effective: {
				provider: actualProvider,
				model: model.value,
				effort: effort.value,
			},
			overloadFallback:
				modelFallback && actualProvider === provider
					? (definition.overloadFallback[provider] ?? null)
					: null,
		});
	}

	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const roles = Object.fromEntries(
		MODEL_ROLES.map((name) => [name, resolved.get(name)]),
	) as Record<ModelRole, ResolvedRole>;
	return {
		ok: true,
		value: {
			provider,
			roles,
			fallbackShaper: {
				aliasOf: "shaper",
				effective: roles.shaper.effective,
			},
		},
	};
}
