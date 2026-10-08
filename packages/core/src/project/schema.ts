import { type LadderOptions, parseLadderOptions } from "../build/ladder";
import type { YamlBlockNode, YamlMapNode } from "../yaml/block";
import { parseYaml } from "../yaml/parse";
import {
	MODEL_ROLES,
	type ModelRole,
	type RoleOverrides,
	type RoleValue,
} from "./roles";

export interface ConfigDiagnostic {
	readonly message: string;
	readonly line?: number;
}

export type ConfigParseResult<Value> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly diagnostics: readonly ConfigDiagnostic[] };

export interface CheckSpec {
	readonly name: string;
	readonly argv: readonly string[];
	readonly timeoutMs: number;
}

export type RecipeName =
	| "ladder"
	| "ladder-diverse"
	| "ladder-luna"
	| "ladder-sol-low"
	| "ladder-sol-medium"
	| "ladder-sol-high"
	| "plan-shell"
	| "staged"
	| "direct"
	| "direct-escalate"
	| "direct-shell"
	| "escalate-shell";

export type LandPolicy = "green" | "green-or-advisory";
export type LunaProviderMode = "responses" | "lite";
export type AcceptanceAdapter = "exunit" | "command" | "rails";

export interface AcceptanceConfig {
	readonly adapter: AcceptanceAdapter;
	readonly timeoutMs: number;
	readonly extension?: string;
	readonly candidateDirectory?: string;
	readonly run?: readonly string[];
}

export interface ShapingConfig {
	readonly proof: "none" | "witness";
	readonly witnessRounds: number;
}

export interface PartialBuildConfig {
	readonly recipe?: RecipeName | `${RecipeName}+edge`;
	readonly ladder?: LadderOptions;
	readonly budgetMs?: number;
	readonly roles?: RoleOverrides;
	readonly wallMinutes?: number;
	readonly edgeTests?: boolean;
	readonly modelFallback?: boolean;
	readonly contextBytes?: number;
	readonly planMaxWords?: number;
	readonly toolResultTokens?: number;
	readonly modelGenerationTokens?: number;
	readonly lunaProviderMode?: LunaProviderMode;
	readonly land?: LandPolicy;
	readonly auditorDemotion?: false;
}

export interface ProjectBuildConfig extends PartialBuildConfig {
	readonly recipe: RecipeName | `${RecipeName}+edge`;
	readonly ladder: LadderOptions;
	readonly budgetMs: number;
	readonly roles: RoleOverrides;
	readonly wallMinutes: number;
	readonly edgeTests: boolean;
	readonly modelFallback: boolean;
	readonly planMaxWords: number;
	readonly toolResultTokens: number;
	readonly lunaProviderMode: LunaProviderMode;
	readonly land: LandPolicy;
	readonly auditorDemotion: false;
}

export interface ProjectConfig {
	readonly name: string;
	readonly checks: readonly CheckSpec[];
	readonly acceptanceChecks: readonly CheckSpec[];
	readonly setup: readonly CheckSpec[];
	readonly setupOutputs: readonly string[];
	readonly setupInputs: readonly string[];
	readonly fix: readonly CheckSpec[];
	readonly format?: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly gatePaths: readonly string[];
	readonly domains: ReadonlyMap<string, readonly string[]>;
	readonly env: ReadonlyMap<string, string>;
	readonly sandbox: boolean;
	readonly base?: string;
	readonly acceptance: AcceptanceConfig;
	readonly shaping: ShapingConfig;
	readonly build: ProjectBuildConfig;
	readonly account?: string;
}

export interface MachineConfig {
	readonly build: PartialBuildConfig;
}

const PROJECT_KEYS = new Set([
	"name",
	"checks",
	"acceptance_checks",
	"setup",
	"setup_outputs",
	"setup_inputs",
	"fix",
	"format",
	"protected_paths",
	"gate_paths",
	"domains",
	"env",
	"sandbox",
	"base",
	"acceptance",
	"shaping",
	"build",
	"account",
]);

const BUILD_KEYS = new Set([
	"recipe",
	"ladder",
	"budget_ms",
	"roles",
	"wall_minutes",
	"edge_tests",
	"model_fallback",
	"context_bytes",
	"plan_max_words",
	"tool_result_tokens",
	"model_generation_tokens",
	"luna_provider_mode",
	"land",
	"auditor_demotion",
]);

const CHECK_KEYS = new Set(["name", "argv", "timeout_ms"]);
const ACCEPTANCE_KEYS = new Set([
	"adapter",
	"timeout_ms",
	"ext",
	"candidate_dir",
	"run",
]);
const SHAPING_KEYS = new Set(["proof", "witness_rounds"]);
const ROLE_KEYS = new Set(["model", "effort"]);

const RECIPE_NAMES: readonly RecipeName[] = [
	"ladder",
	"ladder-diverse",
	"ladder-luna",
	"ladder-sol-low",
	"ladder-sol-medium",
	"ladder-sol-high",
	"plan-shell",
	"staged",
	"direct",
	"direct-escalate",
	"direct-shell",
	"escalate-shell",
];

function isMap(node: YamlBlockNode | undefined): node is YamlMapNode {
	return node?.kind === "map";
}

function scalar(node: YamlBlockNode | undefined): string | undefined {
	return node?.kind === "scalar" ? node.value : undefined;
}

function mapEntries(node: YamlMapNode): Iterable<[string, YamlBlockNode]> {
	return node.entries.entries();
}

function addUnknownKeys(
	map: YamlMapNode,
	allowed: ReadonlySet<string>,
	path: string,
	issues: ConfigDiagnostic[],
): void {
	for (const [key] of mapEntries(map)) {
		if (allowed.has(key)) continue;
		issues.push({ message: `${path} has unknown key ${JSON.stringify(key)}` });
	}
}

function parseYamlMap(
	input: Uint8Array,
	rootMessage: string,
): ConfigParseResult<YamlMapNode> {
	const parsed = parseYaml(input);
	if (parsed.issue !== null) {
		return {
			ok: false,
			diagnostics: [
				{
					message: parsed.issue.message,
					...(parsed.issue.line === undefined
						? {}
						: { line: parsed.issue.line }),
				},
			],
		};
	}
	if (parsed.node === null || parsed.node.kind !== "map") {
		return {
			ok: false,
			diagnostics: [{ message: rootMessage, line: 1 }],
		};
	}
	return { ok: true, value: parsed.node };
}

function parseStringList(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
	options: { readonly required?: boolean; readonly nonEmpty?: boolean } = {},
): readonly string[] {
	if (node === undefined) {
		if (options.required)
			issues.push({ message: `missing required key \`${path}\`` });
		return [];
	}
	if (node.kind !== "sequence") {
		issues.push({ message: `${path} must be a list` });
		return [];
	}
	const values: string[] = [];
	for (const [index, item] of node.items.entries()) {
		const value = scalar(item);
		if (value === undefined || (options.nonEmpty && value.length === 0)) {
			issues.push({
				message: `${path}[${index + 1}] must be ${options.nonEmpty ? "a non-empty string" : "a string"}`,
			});
			continue;
		}
		values.push(value);
	}
	if (options.nonEmpty && values.length === 0 && node.items.length === 0) {
		issues.push({ message: `${path} must be a non-empty list` });
	}
	return values;
}

function parseBoolean(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
	defaultValue: boolean,
): boolean {
	if (node === undefined) return defaultValue;
	const value = scalar(node);
	if (value === "true") return true;
	if (value === "false") return false;
	issues.push({ message: `${path} must be true or false` });
	return defaultValue;
}

function parseInteger(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
	options: {
		readonly defaultValue?: number;
		readonly minimum: number;
		readonly maximum?: number;
		readonly required?: boolean;
		readonly description?: string;
	},
): number | undefined {
	if (node === undefined) {
		if (options.required)
			issues.push({ message: `missing required key \`${path}\`` });
		return options.defaultValue;
	}
	const value = scalar(node);
	const number =
		value !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(value)
			? Number(value)
			: Number.NaN;
	if (
		!Number.isSafeInteger(number) ||
		number < options.minimum ||
		(options.maximum !== undefined && number > options.maximum)
	) {
		const description =
			options.description ??
			(options.maximum === undefined
				? `an integer ≥ ${options.minimum}`
				: `an integer from ${options.minimum} to ${options.maximum}`);
		issues.push({ message: `${path} must be ${description}` });
		return options.defaultValue;
	}
	return number;
}

function parseString(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
	options: { readonly required?: boolean; readonly nonEmpty?: boolean } = {},
): string | undefined {
	if (node === undefined) {
		if (options.required)
			issues.push({ message: `missing required key \`${path}\`` });
		return undefined;
	}
	const value = scalar(node);
	if (value === undefined || (options.nonEmpty && value.length === 0)) {
		issues.push({
			message: `${path} must be ${options.nonEmpty ? "a non-empty string" : "a string"}`,
		});
		return undefined;
	}
	return value;
}

function parseCheckSpecs(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
	options: { readonly required?: boolean } = {},
): readonly CheckSpec[] {
	if (node === undefined) {
		if (options.required)
			issues.push({ message: `missing required key \`${path}\`` });
		return [];
	}
	if (node.kind !== "sequence") {
		issues.push({ message: `${path} must be a list` });
		return [];
	}
	const checks: CheckSpec[] = [];
	const names = new Set<string>();
	for (const [index, item] of node.items.entries()) {
		const rowPath = `${path}[${index + 1}]`;
		if (!isMap(item)) {
			issues.push({ message: `${rowPath} must be a map` });
			continue;
		}
		addUnknownKeys(item, CHECK_KEYS, rowPath, issues);
		const name = parseString(
			item.entries.get("name"),
			`${rowPath}.name`,
			issues,
			{
				required: true,
				nonEmpty: true,
			},
		);
		const argv = parseStringList(
			item.entries.get("argv"),
			`${rowPath}.argv`,
			issues,
			{
				required: true,
				nonEmpty: true,
			},
		);
		const timeoutMs = parseInteger(
			item.entries.get("timeout_ms"),
			`${rowPath}.timeout_ms`,
			issues,
			{ minimum: 1, required: true, description: "a positive integer" },
		);
		if (name !== undefined && names.has(name)) {
			issues.push({
				message: `${path} has duplicate name ${JSON.stringify(name)}`,
			});
		}
		if (name !== undefined) names.add(name);
		if (name !== undefined && timeoutMs !== undefined && argv.length > 0) {
			checks.push({ name, argv, timeoutMs });
		}
	}
	return checks;
}

function parsePathList(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
): readonly string[] {
	const values = parseStringList(node, path, issues);
	for (const [index, value] of values.entries()) {
		if (!isSafeRelativePath(value)) {
			issues.push({
				message: `${path}[${index + 1}] must be a safe relative path`,
			});
		}
	}
	return values;
}

/** Shared cross-platform path check for setup inputs and outputs. */
export function isSafeRelativePath(value: string): boolean {
	if (
		value.length === 0 ||
		/[\0\r\n\\]/u.test(value) ||
		value.startsWith("/") ||
		/^[A-Za-z]:/u.test(value)
	) {
		return false;
	}
	const segments = value.split("/");
	return segments.every(
		(segment) =>
			segment.length > 0 &&
			segment !== "." &&
			segment !== ".." &&
			segment !== ".git",
	);
}

function pathsOverlap(left: string, right: string): boolean {
	return (
		left === right ||
		left.startsWith(`${right}/`) ||
		right.startsWith(`${left}/`)
	);
}

function validateNoOverlaps(
	values: readonly string[],
	path: string,
	issues: ConfigDiagnostic[],
): void {
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === undefined) continue;
		for (let earlier = 0; earlier < index; earlier += 1) {
			const previous = values[earlier];
			if (previous !== undefined && pathsOverlap(previous, value)) {
				issues.push({
					message: `${path} has overlapping paths ${JSON.stringify(previous)} and ${JSON.stringify(value)}`,
				});
				break;
			}
		}
	}
}

function parseStringMap(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
): ReadonlyMap<string, string> {
	if (node === undefined) return new Map();
	if (!isMap(node)) {
		issues.push({ message: `${path} must be a map` });
		return new Map();
	}
	const output = new Map<string, string>();
	for (const [key, item] of mapEntries(node)) {
		const value = scalar(item);
		if (value === undefined) {
			issues.push({ message: `${path}.${key} must be a string` });
			continue;
		}
		output.set(key, value);
	}
	return output;
}

function parseStringListMap(
	node: YamlBlockNode | undefined,
	path: string,
	issues: ConfigDiagnostic[],
): ReadonlyMap<string, readonly string[]> {
	if (node === undefined) return new Map();
	if (!isMap(node)) {
		issues.push({ message: `${path} must be a map` });
		return new Map();
	}
	const output = new Map<string, readonly string[]>();
	for (const [key, item] of mapEntries(node)) {
		output.set(key, parseStringList(item, `${path}.${key}`, issues));
	}
	return output;
}

function parseRoleOverrides(
	node: YamlBlockNode | undefined,
	issues: ConfigDiagnostic[],
): RoleOverrides {
	if (node === undefined) return new Map();
	if (!isMap(node)) {
		issues.push({ message: "build.roles must be a map" });
		return new Map();
	}
	const output = new Map<ModelRole, RoleValue>();
	const roleSet = new Set<string>(MODEL_ROLES);
	for (const [roleName, roleNode] of mapEntries(node)) {
		if (!roleSet.has(roleName)) {
			issues.push({
				message: `build.roles has unknown role ${JSON.stringify(roleName)}`,
			});
			continue;
		}
		if (!isMap(roleNode)) {
			issues.push({ message: `build.roles.${roleName} must be a map` });
			continue;
		}
		const role = roleName as ModelRole;
		addUnknownKeys(roleNode, ROLE_KEYS, `build.roles.${roleName}`, issues);
		const model = parseString(
			roleNode.entries.get("model"),
			`build.roles.${roleName}.model`,
			issues,
			{
				nonEmpty: true,
			},
		);
		const effort = parseString(
			roleNode.entries.get("effort"),
			`build.roles.${roleName}.effort`,
			issues,
			{
				nonEmpty: true,
			},
		);
		output.set(role, {
			...(model === undefined ? {} : { model }),
			...(effort === undefined ? {} : { effort }),
		});
	}
	return output;
}

function parseLadder(
	node: YamlBlockNode | undefined,
	issues: ConfigDiagnostic[],
): LadderOptions | undefined {
	if (node === undefined) return undefined;
	if (!isMap(node)) {
		issues.push({ message: "build.ladder must be a map" });
		return undefined;
	}
	const raw: Record<string, unknown> = {};
	for (const [key, value] of node.entries) {
		const text = scalar(value);
		if (key === "max_rungs" || key === "repeat_from") {
			raw[key] =
				key === "repeat_from" && text === "null"
					? null
					: text !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(text)
						? Number(text)
						: (text ?? "invalid");
		} else if (key === "experimental_r4") {
			raw[key] =
				text === "true" ? true : text === "false" ? false : (text ?? "invalid");
		} else {
			raw[key] = text ?? "invalid";
		}
	}
	const parsed = parseLadderOptions(raw);
	if (!parsed.ok) {
		for (const diagnostic of parsed.diagnostics)
			issues.push({ message: diagnostic.message });
		return undefined;
	}
	return parsed.value;
}

function parseBuild(
	node: YamlBlockNode | undefined,
	issues: ConfigDiagnostic[],
): PartialBuildConfig {
	if (node === undefined) return {};
	if (!isMap(node)) {
		issues.push({ message: "build must be a map" });
		return {};
	}
	addUnknownKeys(node, BUILD_KEYS, "build", issues);
	const recipeValue = parseString(
		node.entries.get("recipe"),
		"build.recipe",
		issues,
		{
			nonEmpty: true,
		},
	);
	let recipe: PartialBuildConfig["recipe"];
	if (recipeValue !== undefined) {
		const baseRecipe = recipeValue.endsWith("+edge")
			? recipeValue.slice(0, -"+edge".length)
			: recipeValue;
		if (RECIPE_NAMES.includes(baseRecipe as RecipeName)) {
			recipe = recipeValue as RecipeName | `${RecipeName}+edge`;
		} else {
			issues.push({
				message: `build.recipe must be one of ${RECIPE_NAMES.join(", ")} (received ${JSON.stringify(recipeValue)})`,
			});
		}
	}
	const roles = parseRoleOverrides(node.entries.get("roles"), issues);
	const ladder = parseLadder(node.entries.get("ladder"), issues);
	const budgetMs = parseInteger(
		node.entries.get("budget_ms"),
		"build.budget_ms",
		issues,
		{ minimum: 1 },
	);
	const wallMinutes = parseInteger(
		node.entries.get("wall_minutes"),
		"build.wall_minutes",
		issues,
		{
			minimum: 1,
		},
	);
	const edgeTestsNode = node.entries.get("edge_tests");
	const edgeTests =
		edgeTestsNode === undefined
			? undefined
			: parseBoolean(edgeTestsNode, "build.edge_tests", issues, false);
	const modelFallbackNode = node.entries.get("model_fallback");
	const modelFallback =
		modelFallbackNode === undefined
			? undefined
			: parseBoolean(modelFallbackNode, "build.model_fallback", issues, true);
	const contextBytes = parseInteger(
		node.entries.get("context_bytes"),
		"build.context_bytes",
		issues,
		{
			minimum: 16_000,
		},
	);
	const planMaxWords = parseInteger(
		node.entries.get("plan_max_words"),
		"build.plan_max_words",
		issues,
		{
			minimum: 300,
			maximum: 2_000,
			description: "an integer from 300 to 2000",
		},
	);
	const toolResultTokens = parseInteger(
		node.entries.get("tool_result_tokens"),
		"build.tool_result_tokens",
		issues,
		{ minimum: 128, maximum: 100_000 },
	);
	const modelGenerationTokens = parseInteger(
		node.entries.get("model_generation_tokens"),
		"build.model_generation_tokens",
		issues,
		{ minimum: 1, maximum: 100_000 },
	);
	const lunaProviderValue = parseString(
		node.entries.get("luna_provider_mode"),
		"build.luna_provider_mode",
		issues,
	);
	let lunaProviderMode: LunaProviderMode | undefined;
	if (lunaProviderValue !== undefined) {
		if (lunaProviderValue === "responses" || lunaProviderValue === "lite") {
			lunaProviderMode = lunaProviderValue;
		} else {
			issues.push({
				message: "build.luna_provider_mode must be responses or lite",
			});
		}
	}
	const landValue = parseString(node.entries.get("land"), "build.land", issues);
	let land: LandPolicy | undefined;
	if (landValue !== undefined) {
		if (landValue === "green" || landValue === "green-or-advisory")
			land = landValue;
		else
			issues.push({ message: "build.land must be green or green-or-advisory" });
	}
	const auditorDemotionNode = node.entries.get("auditor_demotion");
	const auditorDemotion =
		auditorDemotionNode === undefined
			? undefined
			: parseBoolean(
					auditorDemotionNode,
					"build.auditor_demotion",
					issues,
					false,
				);
	if (auditorDemotion === true) {
		issues.push({
			message: "build.auditor_demotion has no admitted calibration",
		});
	}
	return {
		...(recipe === undefined ? {} : { recipe }),
		...(ladder === undefined ? {} : { ladder }),
		...(budgetMs === undefined ? {} : { budgetMs }),
		roles,
		...(wallMinutes === undefined ? {} : { wallMinutes }),
		...(edgeTests === undefined ? {} : { edgeTests }),
		...(modelFallback === undefined ? {} : { modelFallback }),
		...(contextBytes === undefined ? {} : { contextBytes }),
		...(planMaxWords === undefined ? {} : { planMaxWords }),
		...(toolResultTokens === undefined ? {} : { toolResultTokens }),
		...(modelGenerationTokens === undefined ? {} : { modelGenerationTokens }),
		...(lunaProviderMode === undefined ? {} : { lunaProviderMode }),
		...(land === undefined ? {} : { land }),
		auditorDemotion: false,
	};
}

function parseAcceptance(
	node: YamlBlockNode | undefined,
	issues: ConfigDiagnostic[],
): AcceptanceConfig {
	if (node === undefined) return { adapter: "exunit", timeoutMs: 600_000 };
	if (!isMap(node)) {
		issues.push({ message: "acceptance must be a map" });
		return { adapter: "exunit", timeoutMs: 600_000 };
	}
	addUnknownKeys(node, ACCEPTANCE_KEYS, "acceptance", issues);
	const adapterValue =
		parseString(node.entries.get("adapter"), "acceptance.adapter", issues) ??
		"exunit";
	const adapter: AcceptanceAdapter =
		adapterValue === "command" || adapterValue === "rails"
			? adapterValue
			: "exunit";
	if (
		adapterValue !== "exunit" &&
		adapterValue !== "command" &&
		adapterValue !== "rails"
	) {
		issues.push({
			message: "acceptance.adapter must be exunit, command, or rails",
		});
	}
	const timeoutMs =
		parseInteger(
			node.entries.get("timeout_ms"),
			"acceptance.timeout_ms",
			issues,
			{
				minimum: 1,
				defaultValue: 600_000,
				description: "a positive integer",
			},
		) ?? 600_000;
	const extension = parseString(
		node.entries.get("ext"),
		"acceptance.ext",
		issues,
		{
			nonEmpty: true,
		},
	);
	const candidateDirectory = parseString(
		node.entries.get("candidate_dir"),
		"acceptance.candidate_dir",
		issues,
		{ nonEmpty: true },
	);
	const runNode = node.entries.get("run");
	const run =
		runNode === undefined
			? undefined
			: parseStringList(runNode, "acceptance.run", issues, { nonEmpty: true });
	if (adapter === "command") {
		if (extension === undefined)
			issues.push({ message: "missing required key `acceptance.ext`" });
		if (candidateDirectory === undefined)
			issues.push({
				message: "missing required key `acceptance.candidate_dir`",
			});
		if (run === undefined || run.length === 0)
			issues.push({ message: "missing required key `acceptance.run`" });
	}
	return {
		adapter,
		timeoutMs,
		...(extension === undefined ? {} : { extension }),
		...(candidateDirectory === undefined ? {} : { candidateDirectory }),
		...(run === undefined ? {} : { run }),
	};
}

function parseShaping(
	node: YamlBlockNode | undefined,
	issues: ConfigDiagnostic[],
): ShapingConfig {
	if (node === undefined) return { proof: "none", witnessRounds: 2 };
	if (!isMap(node)) {
		issues.push({ message: "shaping must be a map" });
		return { proof: "none", witnessRounds: 2 };
	}
	addUnknownKeys(node, SHAPING_KEYS, "shaping", issues);
	const proofValue =
		parseString(node.entries.get("proof"), "shaping.proof", issues) ?? "none";
	const proof = proofValue === "witness" ? "witness" : "none";
	if (proofValue !== "none" && proofValue !== "witness") {
		issues.push({ message: "shaping.proof must be none or witness" });
	}
	const witnessRounds =
		parseInteger(
			node.entries.get("witness_rounds"),
			"shaping.witness_rounds",
			issues,
			{ minimum: 1, defaultValue: 2, description: "a positive integer" },
		) ?? 2;
	return { proof, witnessRounds };
}

function finishProjectBuild(build: PartialBuildConfig): ProjectBuildConfig {
	const ladder = parseLadderOptions();
	if (!ladder.ok) throw new Error("Default ladder configuration is invalid.");
	return {
		recipe: build.recipe ?? "ladder",
		ladder: build.ladder ?? ladder.value,
		budgetMs: build.budgetMs ?? 3_600_000,
		roles: build.roles ?? new Map(),
		wallMinutes: build.wallMinutes ?? 60,
		edgeTests: build.edgeTests ?? false,
		modelFallback: build.modelFallback ?? true,
		...(build.contextBytes === undefined
			? {}
			: { contextBytes: build.contextBytes }),
		planMaxWords: build.planMaxWords ?? 500,
		toolResultTokens: build.toolResultTokens ?? 2_000,
		...(build.modelGenerationTokens === undefined
			? {}
			: { modelGenerationTokens: build.modelGenerationTokens }),
		lunaProviderMode: build.lunaProviderMode ?? "responses",
		land: build.land ?? "green",
		auditorDemotion: false,
	};
}

/** Parse and validate a closed `.kogen/project.yaml` document. */
export function parseProjectConfig(
	input: Uint8Array,
): ConfigParseResult<ProjectConfig> {
	const root = parseYamlMap(input, "project config must be a YAML map");
	if (!root.ok) return root;
	const issues: ConfigDiagnostic[] = [];
	const map = root.value;
	addUnknownKeys(map, PROJECT_KEYS, "project", issues);

	const name =
		parseString(map.entries.get("name"), "name", issues, {
			required: true,
			nonEmpty: true,
		}) ?? "";
	const checks = parseCheckSpecs(map.entries.get("checks"), "checks", issues, {
		required: true,
	});
	const acceptanceChecks = parseCheckSpecs(
		map.entries.get("acceptance_checks"),
		"acceptance_checks",
		issues,
	);
	const setup = parseCheckSpecs(map.entries.get("setup"), "setup", issues);
	const setupOutputs = parsePathList(
		map.entries.get("setup_outputs"),
		"setup_outputs",
		issues,
	);
	const setupInputs = parsePathList(
		map.entries.get("setup_inputs"),
		"setup_inputs",
		issues,
	);
	validateNoOverlaps(setupOutputs, "setup_outputs", issues);
	const fix = parseCheckSpecs(map.entries.get("fix"), "fix", issues);
	const formatNode = map.entries.get("format");
	const format =
		formatNode === undefined
			? undefined
			: parseStringList(formatNode, "format", issues, { nonEmpty: true });
	const protectedPaths = parseStringList(
		map.entries.get("protected_paths"),
		"protected_paths",
		issues,
	);
	const gatePaths = parseStringList(
		map.entries.get("gate_paths"),
		"gate_paths",
		issues,
	);
	const domains = parseStringListMap(
		map.entries.get("domains"),
		"domains",
		issues,
	);
	const env = parseStringMap(map.entries.get("env"), "env", issues);
	for (const name of env.keys()) {
		if (name.startsWith("KOGEN_")) {
			issues.push({ message: `env cannot set ${name}` });
		}
	}
	const sandbox = parseBoolean(
		map.entries.get("sandbox"),
		"sandbox",
		issues,
		true,
	);
	const base = parseString(map.entries.get("base"), "base", issues, {
		nonEmpty: true,
	});
	const acceptance = parseAcceptance(map.entries.get("acceptance"), issues);
	const shaping = parseShaping(map.entries.get("shaping"), issues);
	const build = finishProjectBuild(
		parseBuild(map.entries.get("build"), issues),
	);
	const account = parseString(map.entries.get("account"), "account", issues, {
		nonEmpty: true,
	});

	if (issues.length > 0) return { ok: false, diagnostics: issues };
	return {
		ok: true,
		value: {
			name,
			checks,
			acceptanceChecks,
			setup,
			setupOutputs,
			setupInputs,
			fix,
			...(format === undefined ? {} : { format }),
			protectedPaths,
			gatePaths,
			domains,
			env,
			sandbox,
			...(base === undefined ? {} : { base }),
			acceptance,
			shaping,
			build,
			...(account === undefined ? {} : { account }),
		},
	};
}

/** Parse `~/.kogen/config.yaml`, which admits only a top-level `build:` key. */
export function parseMachineConfig(
	input: Uint8Array,
): ConfigParseResult<MachineConfig> {
	const root = parseYamlMap(input, "machine config must be a YAML map");
	if (!root.ok) return root;
	const issues: ConfigDiagnostic[] = [];
	addUnknownKeys(root.value, new Set(["build"]), "machine config", issues);
	const build = parseBuild(root.value.entries.get("build"), issues);
	if (issues.length > 0) return { ok: false, diagnostics: issues };
	return { ok: true, value: { build } };
}

/** Convert diagnostics to the exact indented lines used by project errors. */
export function formatConfigDiagnostics(
	diagnostics: readonly ConfigDiagnostic[],
): readonly string[] {
	return diagnostics.map((diagnostic) =>
		diagnostic.line === undefined
			? `  ${diagnostic.message}`
			: `  line ${diagnostic.line}: ${diagnostic.message}`,
	);
}
