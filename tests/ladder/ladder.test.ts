import { expect, test } from "bun:test";
import {
	advanceLadderCursor,
	createLadderPlan,
	initialLadderCursor,
	type LadderPlan,
	nextLadderAttempt,
	parseLadderOptions,
} from "../../packages/core/src/build/ladder";
import { resolveRoles } from "../../packages/core/src/project/roles";

const roles = (() => {
	const result = resolveRoles({ provider: "chatgpt" });
	if (!result.ok) throw new Error("ChatGPT roles should resolve.");
	return result.value;
})();

function options(value?: unknown) {
	const parsed = parseLadderOptions(value);
	if (!parsed.ok) throw new Error("Test ladder options should be valid.");
	return parsed.value;
}

function plan(overrides?: unknown): LadderPlan {
	const input = overrides === undefined ? undefined : options(overrides);
	const value = createLadderPlan({
		recipe: "ladder",
		roles,
		...(input === undefined ? {} : { options: input }),
	});
	if (value === null) throw new Error("Default ladder should be admitted.");
	return value;
}

test("ladder options freeze default R4 admission and validate bounds", () => {
	expect(parseLadderOptions().ok).toBe(true);
	const defaults = options();
	expect(defaults).toEqual({
		maxRungs: 3,
		experimentalR4: false,
		repeatFrom: 2,
	});

	expect(options({ experimental_r4: true })).toEqual({
		maxRungs: 4,
		experimentalR4: true,
		repeatFrom: 2,
	});
	expect(options({ max_rungs: 1, experimental_r4: true }).maxRungs).toBe(1);
	expect(options({ repeat_from: null }).repeatFrom).toBeNull();

	for (const invalid of [
		{ max_rungs: 0 },
		{ max_rungs: 5 },
		{ max_rungs: 2.5 },
		{ experimental_r4: "true" },
		{ repeat_from: 4 },
		{ repeat_from: 1.5 },
		{ unexpected: true },
	])
		expect(parseLadderOptions(invalid).ok).toBe(false);
});

test("default ladder is R1 through R3; explicit R4 gets the raw Request", () => {
	const normal = plan();
	expect(normal.rungs.map((rung) => rung.name)).toEqual([
		"builder",
		"sol-medium",
		"sol-high",
	]);
	expect(normal.rungs.map((rung) => rung.role.effective.model)).toEqual([
		"gpt-6-luna",
		"gpt-6.1-sol",
		"gpt-6.1-sol",
	]);
	expect(normal.rungs.map((rung) => rung.role.effective.effort)).toEqual([
		"max",
		"medium",
		"high",
	]);
	expect(normal.repeatsEnabled).toBe(false);

	const experimental = plan({ experimental_r4: true });
	expect(experimental.rungs.map((rung) => rung.name)).toEqual([
		"builder",
		"sol-medium",
		"sol-high",
		"raw-request",
	]);
	expect(experimental.rungs[3]?.input).toBe("request");
	expect(experimental.repeatsEnabled).toBe(true);
});

test("recipe variants retain their model and input differences", () => {
	const diverse = createLadderPlan({
		recipe: "ladder-diverse",
		roles,
		options: options(),
	});
	expect(diverse?.rungs[1]?.name).toBe("sol-medium-raw");
	expect(diverse?.rungs[1]?.input).toBe("request");

	const luna = createLadderPlan({
		recipe: "ladder-luna",
		roles,
		options: options({ experimental_r4: true }),
	});
	expect(luna?.rungs.map((rung) => rung.name)).toEqual([
		"builder",
		"fresh-2",
		"fresh-3",
		"raw-request",
	]);
	expect(
		luna?.rungs.every((rung) => rung.role.effective.model === "gpt-6-luna"),
	).toBe(true);

	for (const [recipe, effort] of [
		["ladder-sol-low", "low"],
		["ladder-sol-medium", "medium"],
		["ladder-sol-high", "high"],
	] as const) {
		const variant = createLadderPlan({
			recipe,
			roles,
			options: options(),
		});
		expect(
			variant?.rungs.every((rung) => rung.role.effective.effort === effort),
		).toBe(true);
	}

	const edged = createLadderPlan({
		recipe: "ladder+edge",
		roles,
		options: options(),
	});
	expect(edged?.edgeTests).toBe(true);
});

test("max_rungs: 1 admits only R1 in the serial schedule", () => {
	const limited = plan({ max_rungs: 1, experimental_r4: true });
	expect(limited.rungs.map((rung) => rung.rung)).toEqual(["R1"]);
	expect(limited.repeatsEnabled).toBe(false);

	let cursor = initialLadderCursor();
	expect(nextLadderAttempt(limited, cursor)?.rung).toBe("R1");
	cursor = advanceLadderCursor(limited, cursor, "red");
	expect(nextLadderAttempt(limited, cursor)).toBeNull();
});

test("experimental repeats cycle from rung index two and null disables them", () => {
	const repeating = plan({ experimental_r4: true });
	let cursor = initialLadderCursor();
	const names: string[] = [];
	for (let i = 0; i < 7; i += 1) {
		const attempt = nextLadderAttempt(repeating, cursor);
		if (attempt === null)
			throw new Error("Repeat schedule ended unexpectedly.");
		names.push(attempt.name);
		cursor = advanceLadderCursor(repeating, cursor, "red");
	}
	expect(names).toEqual([
		"builder",
		"sol-medium",
		"sol-high",
		"raw-request",
		"sol-high-2",
		"raw-request-2",
		"sol-high-3",
	]);

	const once = plan({ experimental_r4: true, repeat_from: null });
	cursor = initialLadderCursor();
	for (let i = 0; i < 4; i += 1)
		cursor = advanceLadderCursor(once, cursor, "red");
	expect(nextLadderAttempt(once, cursor)).toBeNull();
});

test("green, stopped, and budget outcomes terminate the schedule", () => {
	const ladder = plan({ experimental_r4: true });
	for (const result of ["green", "stopped", "budget"] as const) {
		const cursor = advanceLadderCursor(ladder, initialLadderCursor(), result);
		expect(cursor.finished).toBe(true);
		expect(nextLadderAttempt(ladder, cursor)).toBeNull();
	}
});

test("Grok ladders keep every built-in rung on the resolved provider", () => {
	const grokRoles = resolveRoles({ provider: "grok" });
	if (!grokRoles.ok) throw new Error("Grok roles should resolve.");
	const grok = createLadderPlan({
		recipe: "ladder",
		roles: grokRoles.value,
		options: options({ experimental_r4: true }),
	});
	expect(
		grok?.rungs.every((rung) => rung.role.effective.provider === "grok"),
	).toBe(true);
});
