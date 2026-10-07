import { expect, test } from "bun:test";
import {
	initialQueueDrain,
	type QueueIntent,
	selectQueue,
	transitionQueue,
} from "../../packages/core/src/queue/transition";

function intent(
	slug: string,
	options: Partial<Omit<QueueIntent, "slug">> = {},
): QueueIntent {
	return {
		slug,
		approved: true,
		landed: false,
		priority: 0,
		approvedAt: 1,
		blocksOn: [],
		...options,
	};
}

test("queue order is priority descending, approval time ascending, then slug", () => {
	const selected = selectQueue([
		intent("charlie", { approvedAt: 1, priority: 0 }),
		intent("bravo", { approvedAt: 1, priority: 0 }),
		intent("delta", { approvedAt: 2, priority: 0 }),
		intent("alpha", { approvedAt: 5, priority: 8 }),
	]);
	expect(selected.queued.map((entry) => entry.slug)).toEqual([
		"alpha",
		"bravo",
		"charlie",
		"delta",
	]);
});

test("blocked dependencies include unknown, undelivered, invalid, and cycle cases", () => {
	const selected = selectQueue([
		intent("alpha", { blocksOn: ["bravo"] }),
		intent("bravo", { blocksOn: ["alpha"] }),
		intent("charlie", { blocksOn: ["alpha"] }),
		intent("delta", { blocksOn: ["missing"] }),
		intent("echo", { blocksOn: ["foxtrot"] }),
		intent("foxtrot", { approved: false }),
		intent("golf", { blocksOn: ["hotel", "hotel"] }),
	]);
	expect(selected.queued).toEqual([]);
	expect(selected.blocked).toEqual([
		{ slug: "alpha", reason: "dependency_cycle", dependencies: ["bravo"] },
		{ slug: "bravo", reason: "dependency_cycle", dependencies: ["alpha"] },
		{
			slug: "charlie",
			reason: "dependency_not_landed",
			dependencies: ["alpha"],
		},
		{ slug: "delta", reason: "unknown_dependency", dependencies: ["missing"] },
		{
			slug: "echo",
			reason: "dependency_not_landed",
			dependencies: ["foxtrot"],
		},
		{
			slug: "golf",
			reason: "invalid_dependencies",
			dependencies: ["hotel", "hotel"],
		},
	]);
});

test("delivered dependencies unblock and self-dependencies form a cycle", () => {
	const records = [
		intent("alpha", { blocksOn: ["bravo"] }),
		intent("bravo", { landed: true }),
		intent("charlie", { blocksOn: ["charlie"] }),
	];
	expect(selectQueue(records).queued.map((entry) => entry.slug)).toEqual([
		"alpha",
	]);
	expect(
		selectQueue(records).blocked.find((entry) => entry.slug === "charlie")
			?.reason,
	).toBe("dependency_cycle");
	expect(
		selectQueue(
			[intent("alpha", { blocksOn: ["bravo"] })],
			new Set(["bravo"]),
		).queued.map((entry) => entry.slug),
	).toEqual(["alpha"]);
	expect(
		initialQueueDrain(
			[intent("alpha", { blocksOn: ["bravo"] })],
			new Set(["bravo"]),
		).pending.map((entry) => entry.slug),
	).toEqual(["alpha"]);
});

test("a stop request waits for the current build and preserves the rest", () => {
	const alpha = intent("alpha", { approvedAt: 1 });
	const bravo = intent("bravo", { approvedAt: 2 });
	let state = initialQueueDrain([alpha, bravo]);
	state = transitionQueue(state, { type: "start" });
	expect(state.current?.slug).toBe("alpha");
	state = transitionQueue(state, { type: "stop" });
	expect(state.current?.slug).toBe("alpha");
	expect(state.stopRequested).toBe(true);
	state = transitionQueue(state, { type: "outcome", outcome: "landed" });
	expect(state).toMatchObject({
		line: "stopped_on_request",
		running: false,
		current: null,
		pending: [bravo],
		builds: 1,
		landed: 1,
		exitCode: 0,
	});
});

test("each queue item is attempted once per drain and ordinary failures continue", () => {
	const alpha = intent("alpha", { approvedAt: 1 });
	const bravo = intent("bravo", { approvedAt: 2 });
	let state = transitionQueue(initialQueueDrain([alpha, bravo]), {
		type: "start",
	});
	expect(state.attempted).toEqual(["alpha"]);
	state = transitionQueue(state, { type: "refresh", queue: [alpha, bravo] });
	state = transitionQueue(state, {
		type: "outcome",
		outcome: "failed_provider",
	});
	expect(state.current?.slug).toBe("bravo");
	expect(state.attempted).toEqual(["alpha", "bravo"]);
	state = transitionQueue(state, { type: "outcome", outcome: "landed" });
	expect(state).toMatchObject({
		line: "done",
		builds: 2,
		landed: 1,
		exitCode: 1,
		pending: [],
	});
	state = transitionQueue(state, { type: "start" });
	expect(state).toMatchObject({
		line: "nothing_to_build",
		builds: 0,
		exitCode: 0,
	});
});

test("skipped intents are removed without counting as builds", () => {
	let state = transitionQueue(initialQueueDrain([intent("alpha")]), {
		type: "start",
	});
	state = transitionQueue(state, { type: "outcome", outcome: "skipped" });
	expect(state).toMatchObject({
		line: "nothing_to_build",
		builds: 0,
		landed: 0,
		exitCode: 0,
		pending: [],
	});
});

test("a drain-stopping outcome leaves the current approval queued for retry", () => {
	const alpha = intent("alpha");
	const bravo = intent("bravo", { approvedAt: 2 });
	let state = transitionQueue(initialQueueDrain([alpha, bravo]), {
		type: "start",
	});
	state = transitionQueue(state, {
		type: "outcome",
		outcome: "stopped_provider",
	});
	expect(state).toMatchObject({
		line: "stopped_because",
		stoppedSlug: "alpha",
		stoppedClass: "provider",
		exitCode: 4,
		builds: 1,
		pending: [alpha, bravo],
	});
	state = transitionQueue(state, { type: "start" });
	expect(state.current?.slug).toBe("alpha");
});

test("stopped environment and controller outcomes use their own exit codes", () => {
	for (const [outcome, exitCode, stoppedClass] of [
		["stopped_environment", 3, "environment"],
		["stopped_controller", 70, "controller"],
	] as const) {
		let state = transitionQueue(initialQueueDrain([intent("alpha")]), {
			type: "start",
		});
		state = transitionQueue(state, { type: "outcome", outcome });
		expect(state).toMatchObject({
			line: "stopped_because",
			exitCode,
			stoppedClass,
		});
	}
});

test("a second start while the current drain is live is harmless", () => {
	let state = transitionQueue(initialQueueDrain([intent("alpha")]), {
		type: "start",
	});
	const current = state.current;
	state = transitionQueue(state, { type: "start" });
	expect(state).toMatchObject({ line: "already_running", running: true });
	expect(state.current).toBe(current);
});
