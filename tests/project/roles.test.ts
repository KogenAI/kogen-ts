import { expect, test } from "bun:test";
import {
	MODEL_ROLES,
	type ModelRole,
	NAMED_ROLE_TABLE,
	type RoleOverrides,
	type RoleValue,
	resolveRoles,
} from "../../packages/core/src/project/roles";
import { parseProjectConfig } from "../../packages/core/src/project/schema";

function overrides(source: string): RoleOverrides {
	const parsed = parseProjectConfig(
		new TextEncoder().encode(
			`name: kt\nchecks: []\nbuild:\n  roles:\n${source}`,
		),
	);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.value.build.roles;
}

test("named role table contains exactly the six accepted user roles", () => {
	expect(NAMED_ROLE_TABLE.map((role) => role.name)).toEqual([...MODEL_ROLES]);
	expect(MODEL_ROLES).not.toContain("fallback_shaper");
});

test("ChatGPT defaults are resolved for every role and fallback aliases shaper", () => {
	const result = resolveRoles();
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.roles).toMatchObject({
		builder: {
			effective: { provider: "chatgpt", model: "gpt-6-luna", effort: "max" },
			overloadFallback: { model: "gpt-6.1-sol", effort: "medium" },
		},
		planner: {
			effective: { model: "gpt-6.1-sol", effort: "high" },
			overloadFallback: null,
		},
		shaper: {
			effective: { model: "gpt-6.1-sol", effort: "high" },
			overloadFallback: null,
		},
		auditor: { effective: { model: "gpt-6.1-sol", effort: "high" } },
		reviewer: { effective: { model: "gpt-6.1-sol", effort: "high" } },
		context: { effective: { model: "gpt-6.1-sol", effort: "high" } },
	});
	expect(result.value.fallbackShaper).toEqual({
		aliasOf: "shaper",
		effective: result.value.roles.shaper.effective,
	});
});

test("project roles override machine roles field by field", () => {
	const project = overrides(
		"    builder: {effort: high}\n    shaper: {model: gpt-6-luna}\n",
	);
	const machine = overrides(
		"    builder: {model: machine-builder, effort: low}\n    planner: {model: machine-planner, effort: low}\n    shaper: {effort: max}\n",
	);
	const result = resolveRoles({ project, machine });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.roles.builder).toMatchObject({
		requested: { model: "machine-builder", effort: "high" },
		source: { model: "machine", effort: "project" },
	});
	expect(result.value.roles.planner).toMatchObject({
		requested: { model: "machine-planner", effort: "low" },
		source: { model: "machine", effort: "machine" },
	});
	expect(result.value.roles.shaper).toMatchObject({
		requested: { model: "gpt-6-luna", effort: "max" },
		source: { model: "project", effort: "machine" },
	});
});

test("each admitted role accepts a project model and effort override", () => {
	const project: RoleOverrides = new Map<ModelRole, RoleValue>([
		["builder", { model: "gpt-6-luna", effort: "high" }],
		["planner", { model: "gpt-6.1-sol", effort: "medium" }],
		["shaper", { model: "gpt-6.1-sol", effort: "low" }],
		["auditor", { model: "gpt-6.1-sol", effort: "high" }],
		["reviewer", { model: "gpt-6.1-sol", effort: "medium" }],
		["context", { model: "gpt-6.1-sol", effort: "low" }],
	]);
	const result = resolveRoles({ project });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	for (const role of MODEL_ROLES) {
		expect(result.value.roles[role].source).toEqual({
			model: "project",
			effort: "project",
		});
	}
	expect(result.value.roles.builder.effective.effort).toBe("high");
	expect(result.value.roles.planner.effective.effort).toBe("medium");
	expect(result.value.roles.shaper.effective.effort).toBe("low");
	expect(result.value.roles.auditor.effective.effort).toBe("high");
	expect(result.value.roles.reviewer.effective.effort).toBe("medium");
	expect(result.value.roles.context.effective.effort).toBe("low");
});

test("Grok defaults keep all effective roles and the shape fallback on Grok", () => {
	const result = resolveRoles({ provider: "grok" });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	for (const role of MODEL_ROLES) {
		expect(result.value.roles[role].effective).toMatchObject({
			provider: "grok",
			model: "grok-4.6",
			effort: "high",
		});
		expect(result.value.roles[role].overloadFallback).toBeNull();
	}
	expect(result.value.fallbackShaper.effective).toEqual(
		result.value.roles.shaper.effective,
	);
});

test("explicit cross-provider role models are refused", () => {
	const result = resolveRoles({
		provider: "grok",
		project: overrides("    planner: {model: gpt-6.1-sol, effort: high}\n"),
	});
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics).toEqual([
		{
			path: "build.roles.planner.model",
			message:
				'model "gpt-6.1-sol" belongs to chatgpt, but the selected provider is grok',
		},
	]);
});

test("model fallback policy disables overload switches without changing assignments", () => {
	const result = resolveRoles({ modelFallback: false });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.roles.builder.effective.model).toBe("gpt-6-luna");
	for (const role of MODEL_ROLES) {
		expect(result.value.roles[role].overloadFallback).toBeNull();
	}
});
