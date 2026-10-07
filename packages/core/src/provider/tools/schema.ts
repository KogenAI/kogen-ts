import type { ModelRole } from "../../project/roles";
import type { RecipeName } from "../../project/schema";
import type { CanonicalToolSchema } from "../session/prefix";
import type { RoleToolAuthorization } from "../session/transition";

export type ToolName =
	| "read"
	| "search"
	| "edit"
	| "write"
	| "shell"
	| "finish"
	| "tool_output";

export type FileToolName = "read" | "search" | "edit" | "write";

const schemaValues = [
	{
		type: "function",
		name: "read",
		description: "Read lines from a UTF-8 text file in the worktree.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Worktree-relative file path." },
				offset: {
					type: "integer",
					minimum: 1,
					default: 1,
					description: "One-based first line to return.",
				},
				limit: {
					type: "integer",
					default: 200,
					description: "Number of lines to return (1–400).",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		strict: false,
	},
	{
		type: "function",
		name: "search",
		description: "Search worktree text with ripgrep, falling back to grep.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression to find." },
				path: {
					type: "string",
					default: ".",
					description: "Worktree-relative file or directory.",
				},
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		strict: false,
	},
	{
		type: "function",
		name: "edit",
		description: "Replace one exact, unique piece of worktree file text.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Worktree-relative file path." },
				old_text: {
					type: "string",
					minLength: 1,
					description: "Exact text that must occur once.",
				},
				new_text: { type: "string", description: "Replacement text." },
			},
			required: ["path", "old_text", "new_text"],
			additionalProperties: false,
		},
		strict: false,
	},
	{
		type: "function",
		name: "write",
		description:
			"Create or replace a worktree file without shortening its bytes.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Worktree-relative file path." },
				content: { type: "string", description: "Complete replacement text." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		strict: false,
	},
	{
		type: "function",
		name: "shell",
		description: "Run a bounded shell command in the worktree.",
		parameters: {
			type: "object",
			properties: { cmd: { type: "string" } },
			required: ["cmd"],
			additionalProperties: false,
		},
		strict: false,
	},
	{
		type: "function",
		name: "finish",
		description:
			"Finish the current Build after implementation and verification.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "tool_output",
		description: "Read a byte range from a previously clipped tool result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "64-character result digest." },
				output_offset: {
					type: "integer",
					minimum: 0,
					default: 0,
					description: "Zero-based byte offset.",
				},
				output_limit: {
					type: "integer",
					minimum: 0,
					description:
						"Maximum number of bytes; defaults to the remaining text.",
				},
			},
			required: ["handle"],
			additionalProperties: false,
		},
		strict: false,
	},
] as const satisfies readonly CanonicalToolSchema[];

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** Shared by every provider role and conversation using this tool version. */
export const CANONICAL_TOOL_SCHEMAS = deepFreeze(schemaValues);
export const TOOL_SCHEMA_VERSION = "kogen-tools-v1";

export const TOOL_NAMES = Object.freeze(
	schemaValues.map((schema) => schema.name),
) as readonly ToolName[];

const toolSchemaByName = new Map<string, CanonicalToolSchema>(
	CANONICAL_TOOL_SCHEMAS.map((schema) => [schema.name, schema]),
);

export function getToolSchema(name: string): CanonicalToolSchema | undefined {
	return toolSchemaByName.get(name);
}

const SHAPER_TOOLS = Object.freeze(["read", "search", "write"] as const);
const SHELL_BUILDER_TOOLS = Object.freeze([
	"shell",
	"finish",
	"tool_output",
] as const);
const DIRECT_BUILDER_TOOLS = Object.freeze([
	"read",
	"search",
	"edit",
	"write",
	"shell",
	"finish",
	"tool_output",
] as const);
const NO_TOOLS = Object.freeze([] as string[]);

/**
 * Session construction and dispatch share this role allowlist. The complete
 * schema union remains present in every request; this controls callable tools.
 */
export function roleToolAuthorizationForRecipe(
	recipe: RecipeName | `${RecipeName}+edge`,
): RoleToolAuthorization {
	const baseRecipe = recipe.endsWith("+edge")
		? recipe.slice(0, -"+edge".length)
		: recipe;
	const direct = baseRecipe === "direct" || baseRecipe === "direct-escalate";
	const builderTools = direct ? DIRECT_BUILDER_TOOLS : SHELL_BUILDER_TOOLS;
	const authorization: Record<ModelRole, readonly string[]> = {
		builder: builderTools,
		planner: NO_TOOLS,
		shaper: SHAPER_TOOLS,
		auditor: NO_TOOLS,
		reviewer: NO_TOOLS,
		context: NO_TOOLS,
	};
	return Object.freeze(authorization);
}

export function isFileToolName(name: string): name is FileToolName {
	return (
		name === "read" || name === "search" || name === "edit" || name === "write"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validType(value: unknown, type: unknown): boolean {
	if (type === "string") return typeof value === "string";
	if (type === "integer") return Number.isSafeInteger(value);
	if (type === "number")
		return typeof value === "number" && Number.isFinite(value);
	if (type === "boolean") return typeof value === "boolean";
	if (type === "object") return isRecord(value);
	if (type === "array") return Array.isArray(value);
	return false;
}

/**
 * Validates required arguments and declared value types. Unknown properties
 * are deliberately ignored, matching §4.7's extra-argument rule.
 */
export function hasValidToolArguments(name: string, value: unknown): boolean {
	const schema = getToolSchema(name);
	if (!schema || !isRecord(value)) return false;
	const parameters = schema.parameters;
	if (!isRecord(parameters)) return false;
	const required = parameters.required;
	if (
		Array.isArray(required) &&
		required.some(
			(key) => typeof key !== "string" || !Object.hasOwn(value, key),
		)
	)
		return false;
	const properties = parameters.properties;
	if (!isRecord(properties)) return false;
	for (const [key, propertySchema] of Object.entries(properties)) {
		if (!Object.hasOwn(value, key)) continue;
		if (!isRecord(propertySchema)) return false;
		const actual = value[key];
		if (!validType(actual, propertySchema.type)) return false;
		if (
			typeof actual === "string" &&
			typeof propertySchema.minLength === "number" &&
			actual.length < propertySchema.minLength
		)
			return false;
		if (
			typeof actual === "number" &&
			typeof propertySchema.minimum === "number" &&
			actual < propertySchema.minimum
		)
			return false;
	}
	return true;
}
