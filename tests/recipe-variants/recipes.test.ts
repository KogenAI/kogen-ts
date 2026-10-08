import { expect, test } from "bun:test";
import type { BuildCandidate } from "../../packages/core/src/build/controller";
import {
	createDirectRecipePlan,
	type DirectRecipeName,
	runDirectRecipe,
} from "../../packages/core/src/build/recipes/direct";
import {
	createStagedRecipePlan,
	runStagedRecipe,
} from "../../packages/core/src/build/recipes/staged";
import { resolveRoles } from "../../packages/core/src/project/roles";
import {
	parseProjectConfig,
	type RecipeName,
} from "../../packages/core/src/project/schema";
import { roleToolAuthorizationForRecipe } from "../../packages/core/src/provider/tools/schema";

const encoder = new TextEncoder();

const ADMITTED_RECIPES: readonly RecipeName[] = [
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

function projectFor(recipe: RecipeName) {
	const source =
		"name: recipe-test\n" +
		"checks: []\n" +
		"build:\n" +
		"  recipe: " +
		recipe +
		"\n" +
		"  roles:\n" +
		"    builder: {model: gpt-6-luna, effort: max}\n" +
		"    planner: {model: gpt-6.1-sol, effort: high}\n" +
		"    shaper: {model: gpt-6.1-sol, effort: high}\n" +
		"    auditor: {model: gpt-6.1-sol, effort: high}\n" +
		"    reviewer: {model: gpt-6.1-sol, effort: medium}\n" +
		"    context: {model: gpt-6.1-sol, effort: low}\n";
	const parsed = parseProjectConfig(encoder.encode(source));
	if (!parsed.ok)
		throw new Error(
			"Recipe " +
				recipe +
				" failed config load: " +
				parsed.diagnostics.map((item) => item.message).join("; "),
		);
	return parsed.value;
}

function resolveProjectRoles(recipe: RecipeName) {
	const project = projectFor(recipe);
	const resolved = resolveRoles({
		provider: "chatgpt",
		project: project.build.roles,
		modelFallback: project.build.modelFallback,
	});
	if (!resolved.ok) throw new Error(`Roles for ${recipe} should resolve.`);
	return resolved.value;
}

test("all admitted recipes load and centrally resolve every configured role", () => {
	for (const recipe of ADMITTED_RECIPES) {
		const project = projectFor(recipe);
		expect(project.build.recipe).toBe(recipe);
		const roles = resolveProjectRoles(recipe);
		expect(roles.roles.builder.effective.model).toBe("gpt-6-luna");
		expect(roles.roles.context).toMatchObject({
			requested: { model: "gpt-6.1-sol", effort: "low" },
			effective: { provider: "chatgpt", model: "gpt-6.1-sol", effort: "low" },
		});
		expect(roles.roles.reviewer).toMatchObject({
			requested: { model: "gpt-6.1-sol", effort: "medium" },
			effective: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
		});
		for (const role of Object.values(roles.roles))
			expect(role.effective.provider).toBe(roles.provider);
	}

	for (const recipe of [
		"ladder",
		"ladder-diverse",
		"ladder-luna",
		"ladder-sol-low",
		"ladder-sol-medium",
		"ladder-sol-high",
	] as const) {
		const parsed = parseProjectConfig(
			encoder.encode(
				`name: edge-test\nchecks: []\nbuild:\n  recipe: ${recipe}+edge\n`,
			),
		);
		expect(parsed.ok).toBe(true);
	}
});

test("direct plans skip planning, send the Request, and select the recipe toolset", () => {
	const roles = resolveProjectRoles("direct");
	for (const recipe of [
		"direct",
		"direct-escalate",
		"direct-shell",
		"escalate-shell",
	] as const satisfies readonly DirectRecipeName[]) {
		const plan = createDirectRecipePlan({ recipe, roles });
		expect(plan).not.toBeNull();
		if (plan === null) continue;
		expect(plan.planning).toBe("none");
		expect(plan.attempts.every((attempt) => attempt.plan === null)).toBe(true);
		expect(plan.attempts.every((attempt) => attempt.input === "request")).toBe(
			true,
		);
		expect(
			plan.attempts.every((attempt) => attempt.role.name === "builder"),
		).toBe(true);
		const directTools = recipe === "direct" || recipe === "direct-escalate";
		expect(plan.toolMode).toBe(directTools ? "direct" : "shell");
		expect(plan.attempts[0]?.tools).toEqual(
			roleToolAuthorizationForRecipe(recipe).builder,
		);
		expect(plan.attempts[0]?.tools).toEqual(
			directTools
				? ["read", "search", "edit", "write", "shell", "finish", "tool_output"]
				: ["shell", "finish", "tool_output"],
		);
	}
	const directEdge = createDirectRecipePlan({
		recipe: "direct+edge",
		roles,
	});
	expect(directEdge).toBeNull();
});

test("direct escalation uses shared model profiles while keeping every attempt planless", async () => {
	const roles = resolveProjectRoles("direct-escalate");
	const plan = createDirectRecipePlan({ recipe: "direct-escalate", roles });
	if (plan === null) throw new Error("direct-escalate should resolve.");
	expect(plan.attempts.map((attempt) => attempt.role.effective.model)).toEqual([
		"gpt-6-luna",
		"gpt-6.1-sol",
		"gpt-6.1-sol",
	]);
	expect(plan.attempts.map((attempt) => attempt.role.effective.effort)).toEqual(
		["max", "medium", "high"],
	);

	const called: string[] = [];
	const execution = await runDirectRecipe({
		plan,
		async runAttempt(attempt) {
			called.push(attempt.rung);
			expect(attempt.plan).toBeNull();
			expect(attempt.input).toBe("request");
			return {
				ok: true as const,
				value:
					attempt.index === 1
						? {
								verdict: "red" as const,
								candidate: { tree: "red-tree" },
								reason: "gate red",
							}
						: {
								verdict: "green" as const,
								candidate: { tree: "verified-tree" },
								reason: "gate green",
							},
			};
		},
	});
	expect(called).toEqual(["R1", "R2"]);
	expect(execution).toMatchObject({
		kind: "green",
		candidate: { tree: "verified-tree" },
		attempt: { rung: "R2" },
		attemptsRun: 2,
		candidates: [
			{ candidate: { tree: "red-tree" } },
			{ candidate: { tree: "verified-tree" } },
		],
	});
});

test("Grok direct escalation stays on the centrally selected provider", () => {
	const roles = resolveRoles({ provider: "grok" });
	if (!roles.ok) throw new Error("Grok roles should resolve.");
	const plan = createDirectRecipePlan({
		recipe: "direct-escalate",
		roles: roles.value,
	});
	expect(
		plan?.attempts.map((attempt) => attempt.role.effective.provider),
	).toEqual(["grok", "grok", "grok"]);
});

test("staged context and review use configured roles around the shared gate", async () => {
	const roles = resolveProjectRoles("staged");
	const plan = createStagedRecipePlan({ recipe: "staged", roles });
	if (plan === null) throw new Error("staged should resolve.");
	expect(plan.contextRole).toBe(roles.roles.context);
	expect(plan.plannerRole).toBe(roles.roles.planner);
	expect(plan.builderRole).toBe(roles.roles.builder);
	expect(plan.reviewerRole).toBe(roles.roles.reviewer);
	expect(plan.contextTools).toEqual([]);
	expect(plan.plannerTools).toEqual([]);
	expect(plan.reviewerTools).toEqual([]);
	expect(plan.builderTools).toEqual(["shell", "finish", "tool_output"]);

	const candidate: BuildCandidate = {
		rung: "R1",
		workspace: { id: "workspace-1", root: "/private/workspace-1" },
		verifiedTree: "sha256:verified",
		verdict: "green",
	};
	const calls: string[] = [];
	const result = await runStagedRecipe({
		plan,
		intentBytes: encoder.encode("approved Intent bytes"),
		trackedPaths: ["src/a.ts", "src/b.ts"],
		effects: {
			async context(input) {
				calls.push("context");
				expect(input.role).toBe(roles.roles.context);
				expect(input.tools).toEqual([]);
				expect(new TextDecoder().decode(input.intentBytes)).toBe(
					"approved Intent bytes",
				);
				return { ok: true as const, value: "relevant repository context" };
			},
			async runCore(input) {
				calls.push("plan-build-gate");
				expect(input.context).toBe("relevant repository context");
				expect(input.contextRole).toBe(roles.roles.context);
				expect(input.plannerRole).toBe(roles.roles.planner);
				expect(input.builderRole).toBe(roles.roles.builder);
				expect(input.plannerTools).toEqual([]);
				expect(input.tools).toEqual(["shell", "finish", "tool_output"]);
				return {
					ok: true as const,
					value: {
						value: "shared Build result",
						candidate,
						gate: { status: "green" as const },
					},
				};
			},
			async review(input) {
				calls.push("review");
				expect(input.role).toBe(roles.roles.reviewer);
				expect(input.candidate).toBe(candidate);
				expect(input.gate.status).toBe("green");
				expect(input.tools).toEqual([]);
				return { ok: true as const, value: "Review note retained." };
			},
		},
	});

	expect(calls).toEqual(["context", "plan-build-gate", "review"]);
	expect(result).toMatchObject({
		kind: "ready",
		context: "relevant repository context",
		review: "Review note retained.",
		core: { candidate, gate: { status: "green" } },
	});
});

test("staged review never runs for a red gate", async () => {
	const roles = resolveProjectRoles("staged");
	const plan = createStagedRecipePlan({ recipe: "staged", roles });
	if (plan === null) throw new Error("staged should resolve.");
	const candidate: BuildCandidate = {
		rung: "R1",
		workspace: { id: "workspace-red", root: "/private/workspace-red" },
		verifiedTree: "sha256:red",
		verdict: "red",
	};
	let reviewCalls = 0;
	const red = await runStagedRecipe({
		plan,
		intentBytes: encoder.encode("Intent"),
		trackedPaths: [],
		effects: {
			async context() {
				return { ok: true as const, value: "context" };
			},
			async runCore() {
				return {
					ok: true as const,
					value: {
						value: "red Build",
						candidate,
						gate: { status: "red" as const },
					},
				};
			},
			async review() {
				reviewCalls += 1;
				return { ok: true as const, value: "looks good" };
			},
		},
	});
	expect(red.kind).toBe("red");
	expect(reviewCalls).toBe(0);
});
