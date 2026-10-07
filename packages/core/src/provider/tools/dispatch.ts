import type { ToolResultInput } from "../session/history";
import type { ResponseAssembly, ResponseToolCall } from "../sse/assemble";
import type { FileToolContext } from "./files";
import { dispatchFileTool } from "./files";
import { getToolSchema, hasValidToolArguments, isFileToolName } from "./schema";

export type AdditionalToolName = "shell" | "finish" | "tool_output";

export type AdditionalToolHandler = (
	argumentsValue: Record<string, unknown>,
	call: ResponseToolCall,
	batch: readonly ResponseToolCall[],
) => string | Promise<string>;

export interface ToolDispatchOptions {
	/** The resolved session allowlist, not a list inferred from model output. */
	readonly authorizedTools: readonly string[];
	readonly fileTools?: FileToolContext;
	readonly additionalHandlers?: Readonly<
		Partial<Record<AdditionalToolName, AdditionalToolHandler>>
	>;
}

export const TOOL_NOT_ALLOWED_RESULT =
	"ERROR (tool_not_allowed): This stage does not allow the requested tool.";
export const INVALID_TOOL_ARGUMENTS_RESULT =
	"ERROR (invalid_arguments): Tool arguments do not match the schema.";

function record(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function unavailableResult(name: string): string {
	return `ERROR: The ${name} tool is unavailable in this stage.`;
}

async function dispatchOne(
	call: ResponseToolCall,
	batch: readonly ResponseToolCall[],
	options: ToolDispatchOptions,
): Promise<string> {
	const schema = getToolSchema(call.name);
	if (!schema || !options.authorizedTools.includes(call.name))
		return TOOL_NOT_ALLOWED_RESULT;
	if (
		!record(call.arguments) ||
		!hasValidToolArguments(call.name, call.arguments)
	)
		return INVALID_TOOL_ARGUMENTS_RESULT;
	try {
		if (isFileToolName(call.name)) {
			if (!options.fileTools) return unavailableResult(call.name);
			return await dispatchFileTool(
				call.name,
				call.arguments,
				options.fileTools,
			);
		}
		const handler =
			options.additionalHandlers?.[call.name as AdditionalToolName];
		if (!handler) return unavailableResult(call.name);
		return await handler(call.arguments, call, batch);
	} catch {
		return "ERROR: Tool execution failed.";
	}
}

/**
 * Dispatch only calls from a successful completed assembly. Failed or partial
 * stream proposals are retained for continuation by the provider layer but
 * are never handed to any tool effect.
 */
export async function dispatchToolCalls(
	response: ResponseAssembly,
	options: ToolDispatchOptions,
): Promise<readonly ToolResultInput[]> {
	if (!response.ok) return Object.freeze([]);
	const calls = response.tool_calls;
	const results: ToolResultInput[] = [];
	for (const call of calls) {
		results.push({
			callId: call.id,
			output: await dispatchOne(call, calls, options),
		});
	}
	return Object.freeze(results);
}
