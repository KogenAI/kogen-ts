import { expect, test } from "bun:test";
import { XspecProtocolError } from "../../packages/xspec/src/protocol";
import { createQueueSlice } from "../../packages/xspec/src/slices/queue";
import { createStatusSlice } from "../../packages/xspec/src/slices/status";

const STATUS_OBSERVATION_KEYS = [
	"last",
	"alpha",
	"bravo",
	"charlie",
	"queue",
	"whyA",
	"whyB",
	"whyC",
	"sections",
	"earlier",
	"elapsed",
	"queueLine",
	"next",
	"nextPriority",
	"nextDependencies",
	"landedShown",
	"watchSlug",
	"watchStatus",
	"watchPosition",
	"watchQueueSize",
	"exit",
	"jsonDetail",
];

async function queueEvent(
	slice: Awaited<ReturnType<typeof createQueueSlice>>,
	tag: string,
	value?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const event = value === undefined ? { tag } : { tag, value };
	return (await slice.apply(event)) as Record<string, unknown>;
}

async function statusEvent(
	slice: Awaited<ReturnType<typeof createStatusSlice>>,
	tag: string,
	value?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const event = value === undefined ? { tag } : { tag, value };
	return (await slice.apply(event)) as Record<string, unknown>;
}

function row(
	slug: string,
	status: string,
	priority: number,
	at: number,
	blocks = "",
	sched = "",
	started = 0,
	index = 0,
): Record<string, unknown> {
	return { slug, status, priority, at, blocks, sched, started, index };
}

function raw(
	slug: string,
	values: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		slug,
		trailer: false,
		claimed: false,
		runStatus: "stopped",
		event: "finished",
		alive: false,
		approved: true,
		reason: "provider",
		same: true,
		blocks: "",
		priority: 0,
		at: 0,
		...values,
	};
}

test("queue uses the shared scheduler for priority, serial outcomes, and complete observations", async () => {
	const slice = await createQueueSlice();
	const initial = (await slice.reset()) as Record<string, unknown>;
	expect(initial).toEqual({
		last: "ok",
		line: "",
		exit: 0,
		held: false,
		alive: false,
		stop: false,
		phase: "idle",
		current: "",
		queue: [],
		built: 0,
		landed: 0,
	});
	await queueEvent(slice, "Enqueue", {
		slug: "alpha",
		time: 1,
		priority: 0,
	});
	await queueEvent(slice, "Enqueue", {
		slug: "bravo",
		time: 2,
		priority: 5,
	});
	let observation = await queueEvent(slice, "Start");
	expect(observation).toMatchObject({
		line: "building",
		held: true,
		alive: true,
		current: "bravo",
		phase: "building",
		queue: ["alpha"],
	});
	observation = await queueEvent(slice, "Outcome", { kind: "landed" });
	expect(observation).toMatchObject({
		current: "alpha",
		built: 1,
		landed: 1,
		held: true,
		queue: [],
	});
	observation = await queueEvent(slice, "Outcome", { kind: "failed" });
	expect(observation).toMatchObject({
		line: "done",
		exit: 1,
		held: false,
		built: 2,
		landed: 1,
		queue: [],
	});
});

test("queue owner effects distinguish live second starts, dead owners, and provider retries", async () => {
	const slice = await createQueueSlice();
	await queueEvent(slice, "Enqueue", {
		slug: "alpha",
		time: 1,
		priority: 0,
	});
	await queueEvent(slice, "Enqueue", {
		slug: "bravo",
		time: 2,
		priority: 0,
	});
	let observation = await queueEvent(slice, "Start");
	expect(observation.current).toBe("alpha");
	observation = await queueEvent(slice, "Start");
	expect(observation).toMatchObject({
		line: "already_running",
		current: "alpha",
		phase: "building",
	});
	observation = await queueEvent(slice, "Die");
	expect(observation).toMatchObject({
		line: "owner_dead",
		held: true,
		alive: false,
		phase: "building",
	});
	observation = await queueEvent(slice, "Outcome", { kind: "landed" });
	expect(observation).toMatchObject({
		last: "not_building",
		phase: "building",
		current: "alpha",
	});
	observation = await queueEvent(slice, "Start");
	expect(observation).toMatchObject({
		line: "building",
		held: true,
		alive: true,
		current: "alpha",
	});
	observation = await queueEvent(slice, "Outcome", {
		kind: "stopped_provider",
	});
	expect(observation).toMatchObject({
		line: "stopped_because",
		exit: 4,
		held: false,
		queue: ["alpha", "bravo"],
		built: 1,
	});
	observation = await queueEvent(slice, "Start");
	expect(observation).toMatchObject({
		line: "building",
		current: "alpha",
		held: true,
	});
});

test("queue stop is observed through the shared owner and drain policies", async () => {
	const slice = await createQueueSlice();
	await queueEvent(slice, "Enqueue", {
		slug: "alpha",
		time: 1,
		priority: 0,
	});
	await queueEvent(slice, "Enqueue", {
		slug: "bravo",
		time: 2,
		priority: 0,
	});
	await queueEvent(slice, "Start");
	let observation = await queueEvent(slice, "Halt");
	expect(observation).toMatchObject({
		line: "stopping",
		phase: "building",
		current: "alpha",
		stop: true,
	});
	observation = await queueEvent(slice, "Outcome", { kind: "landed" });
	expect(observation).toMatchObject({
		line: "stopped_on_request",
		exit: 0,
		held: false,
		stop: false,
		queue: ["bravo"],
		built: 1,
		landed: 1,
	});
	observation = await queueEvent(slice, "Halt");
	expect(observation.line).toBe("not_running");
});

test("queue rejects unknown tags and malformed event schemas", async () => {
	const slice = await createQueueSlice();
	await expect(slice.apply({ tag: "Mystery" })).rejects.toBeInstanceOf(
		XspecProtocolError,
	);
	await expect(
		slice.apply({ tag: "Start", value: { extra: true } }),
	).rejects.toBeInstanceOf(XspecProtocolError);
	await expect(
		slice.apply({
			tag: "Enqueue",
			value: { slug: "alpha", time: "1", priority: 0 },
		}),
	).rejects.toBeInstanceOf(XspecProtocolError);
});

test("status returns the complete ordered observation from the shared deriver", async () => {
	const slice = await createStatusSlice();
	const initial = (await slice.reset()) as Record<string, unknown>;
	expect(Object.keys(initial).sort()).toEqual(
		[...STATUS_OBSERVATION_KEYS].sort(),
	);
	expect(initial).toMatchObject({
		last: "ok",
		alpha: "",
		bravo: "",
		charlie: "",
		queue: [],
		sections: [],
		queueLine: "stopped",
		next: "",
		nextPriority: 0,
		nextDependencies: "",
		watchPosition: -1,
		watchQueueSize: 0,
		jsonDetail: false,
	});
	await statusEvent(slice, "Row", row("alpha", "approved", 5, 2));
	await statusEvent(slice, "Row", row("bravo", "approved", 5, 1));
	let observation = await statusEvent(
		slice,
		"Row",
		row("charlie", "approved", 10, 3),
	);
	expect(observation).toMatchObject({
		alpha: "approved",
		bravo: "approved",
		charlie: "approved",
		queue: ["charlie", "bravo", "alpha"],
		queueLine: "waiting",
		next: "charlie",
		nextPriority: 10,
		nextDependencies: "no_dependencies",
		sections: ["Queued"],
	});
	await statusEvent(slice, "Queue", { running: true });
	observation = await statusEvent(slice, "Watch", { slug: "alpha" });
	expect(observation).toMatchObject({
		exit: 1,
		watchSlug: "alpha",
		watchStatus: "queued",
		watchPosition: 2,
		watchQueueSize: 3,
		queueLine: "running",
	});
});

test("status injects reachable refs and owner/build journals before shared derivation", async () => {
	const slice = await createStatusSlice();
	await statusEvent(
		slice,
		"Raw",
		raw("alpha", {
			trailer: true,
			claimed: true,
			runStatus: "running",
			event: "interrupted",
			approved: true,
			reason: "",
		}),
	);
	await statusEvent(
		slice,
		"Raw",
		raw("bravo", {
			claimed: true,
			runStatus: "running",
			event: "interrupted",
			approved: true,
			reason: "",
		}),
	);
	const observation = await statusEvent(
		slice,
		"Raw",
		raw("charlie", {
			claimed: false,
			runStatus: "failed",
			event: "finished",
			approved: true,
			reason: "interrupted",
		}),
	);
	expect(observation).toMatchObject({
		alpha: "landed",
		bravo: "interrupted",
		charlie: "interrupted",
		sections: ["Interrupted", "Landed"],
	});
});

test("status keeps dependency, schedule-error, history, elapsed, and watch observations ordered", async () => {
	const slice = await createStatusSlice();
	await statusEvent(slice, "Row", row("alpha", "approved", 99, 1, "bravo"));
	await statusEvent(slice, "Row", row("bravo", "approved", 99, 2, "alpha"));
	let observation = await statusEvent(
		slice,
		"Row",
		row("charlie", "approved", 100, 3, "ghost"),
	);
	expect(observation).toMatchObject({
		alpha: "blocked",
		bravo: "blocked",
		charlie: "blocked",
		whyA: "dependency cycle: alpha -> bravo -> alpha",
		whyB: "dependency cycle: bravo -> alpha -> bravo",
		whyC: "unknown dependencies: ghost",
		queue: [],
		sections: ["Blocked"],
	});
	await statusEvent(slice, "Init");
	observation = await statusEvent(
		slice,
		"Row",
		row(
			"alpha",
			"approved",
			0,
			1,
			"BAD",
			"invalid scheduling metadata: frontmatter `priority` must be an integer",
		),
	);
	expect(observation).toMatchObject({
		alpha: "blocked",
		whyA: "invalid scheduling metadata: frontmatter `priority` must be an integer",
		sections: ["Blocked"],
	});
	await statusEvent(slice, "Init");
	await statusEvent(slice, "Row", row("alpha", "landed", 0, 0, "", "", 0, 0));
	await statusEvent(slice, "Row", row("bravo", "landed", 0, 0, "", "", 0, 1));
	await statusEvent(slice, "Row", row("charlie", "landed", 0, 0, "", "", 0, 2));
	observation = await statusEvent(slice, "Older", { n: 4 });
	expect(observation).toMatchObject({
		sections: ["Landed"],
		earlier: 2,
		landedShown: 5,
	});
	observation = await statusEvent(slice, "Watch", { slug: "charlie" });
	expect(observation).toMatchObject({ watchStatus: "landed", exit: 0 });
	await statusEvent(slice, "Init");
	await statusEvent(slice, "Row", row("alpha", "building", 0, 0, "", "", 1));
	await statusEvent(slice, "Now", { t: 59 });
	expect(
		((await slice.apply({ tag: "Derive" })) as Record<string, unknown>).elapsed,
	).toBe("s");
	await statusEvent(slice, "Now", { t: 61 });
	expect(
		((await slice.apply({ tag: "Derive" })) as Record<string, unknown>).elapsed,
	).toBe("m");
	await statusEvent(slice, "Now", { t: 3601 });
	expect(
		((await slice.apply({ tag: "Derive" })) as Record<string, unknown>).elapsed,
	).toBe("h");
});

test("status reports modeled refusals and rejects malformed or unknown protocol events", async () => {
	const slice = await createStatusSlice();
	let observation = await statusEvent(
		slice,
		"Row",
		row("unknown", "draft", 0, 0),
	);
	expect(observation.last).toBe("bad_slug");
	observation = await statusEvent(slice, "Watch", { slug: "ghost" });
	expect(observation).toMatchObject({
		exit: 2,
		watchStatus: "not_found",
		watchPosition: -1,
	});
	await expect(slice.apply({ tag: "NoSuchEvent" })).rejects.toBeInstanceOf(
		XspecProtocolError,
	);
	await expect(
		slice.apply({ tag: "Watch", value: { slug: "alpha", extra: true } }),
	).rejects.toBeInstanceOf(XspecProtocolError);
	await expect(
		slice.apply({ tag: "Agents", value: { busy: "1" } }),
	).rejects.toBeInstanceOf(XspecProtocolError);
});
