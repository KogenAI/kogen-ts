import { expect, test } from "bun:test";
import type { Result } from "../../packages/core/src/contracts/errors";
import {
	acquireQueueLock,
	classifyOwnerLiveness,
	type ProcessIdentityObservation,
	type ProcessIdentityPort,
	type QueueLockStorage,
	type QueueOwnerIdentity,
	queueStopRequested,
	releaseQueueLock,
	requestQueueStop,
} from "../../packages/core/src/queue/lock";

function ok<Value>(value: Value): Result<Value> {
	return { ok: true, value };
}

class MemoryLockStorage implements QueueLockStorage {
	owner: QueueOwnerIdentity | null = null;
	stop = false;
	readonly changes: string[] = [];
	failAcquire = false;
	loseOwnerBeforeStop = false;

	async readOwner(): Promise<Result<QueueOwnerIdentity | null>> {
		return ok(this.owner === null ? null : { ...this.owner });
	}

	async createOwnerAndClearStop(
		owner: QueueOwnerIdentity,
	): Promise<Result<"created" | "exists">> {
		if (this.owner !== null) return ok("exists");
		if (this.failAcquire)
			return {
				ok: false,
				error: {
					code: "io",
					message: "fixture atomic-acquire failure",
					retryable: true,
				},
			};
		this.owner = { ...owner };
		this.stop = false;
		this.changes.push("create");
		this.changes.push("clear-stop");
		return ok("created");
	}

	async compareExchangeOwnerAndClearStop(
		expected: QueueOwnerIdentity,
		replacement: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		if (
			this.owner === null ||
			this.owner.pid !== expected.pid ||
			this.owner.startedMs !== expected.startedMs
		)
			return ok(false);
		this.owner = { ...replacement };
		this.stop = false;
		this.changes.push("takeover");
		this.changes.push("clear-stop");
		return ok(true);
	}

	async removeOwnerIf(owner: QueueOwnerIdentity): Promise<Result<boolean>> {
		if (
			this.owner === null ||
			this.owner.pid !== owner.pid ||
			this.owner.startedMs !== owner.startedMs
		)
			return ok(false);
		this.owner = null;
		this.changes.push("release");
		return ok(true);
	}

	async requestStopIfOwner(
		owner: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		if (this.loseOwnerBeforeStop) this.owner = null;
		if (
			this.owner === null ||
			this.owner.pid !== owner.pid ||
			this.owner.startedMs !== owner.startedMs
		)
			return ok(false);
		this.stop = true;
		this.changes.push("stop");
		return ok(true);
	}

	async readStopRequest(): Promise<Result<boolean>> {
		return ok(this.stop);
	}
}

function identityPort(
	current: QueueOwnerIdentity,
	observed: ReadonlyMap<number, ProcessIdentityObservation>,
): ProcessIdentityPort {
	return {
		current: () => current,
		async inspect(pid) {
			const value = observed.get(pid) ?? { kind: "dead" as const };
			return ok(value);
		},
	};
}

const ownerA = { pid: 101, startedMs: 1_780_000_000_100 } as const;
const ownerB = { pid: 202, startedMs: 1_780_000_000_200 } as const;

test("owner identity distinguishes dead, live, reused, and unknown processes", () => {
	expect(classifyOwnerLiveness(ownerA, { kind: "dead" })).toBe("stale");
	expect(
		classifyOwnerLiveness(ownerA, {
			kind: "alive",
			startedMs: ownerA.startedMs,
		}),
	).toBe("live");
	expect(
		classifyOwnerLiveness(ownerA, {
			kind: "alive",
			startedMs: ownerA.startedMs + 1,
		}),
	).toBe("stale");
	expect(classifyOwnerLiveness(ownerA, { kind: "unknown" })).toBe("unknown");
});

test("first acquisition clears an old stop marker and release requires owner identity", async () => {
	const storage = new MemoryLockStorage();
	storage.stop = true;
	const current = identityPort(
		ownerA,
		new Map([[ownerA.pid, { kind: "alive", startedMs: ownerA.startedMs }]]),
	);
	const acquired = await acquireQueueLock(storage, current);
	expect(acquired).toEqual({
		ok: true,
		value: { kind: "acquired", owner: ownerA, replacedStaleOwner: false },
	});
	expect(await queueStopRequested(storage)).toEqual(ok(false));
	expect(
		await releaseQueueLock(storage, identityPort(ownerB, new Map())),
	).toEqual(ok("not_owner"));
	expect(
		await releaseQueueLock(
			storage,
			identityPort(
				ownerA,
				new Map([[ownerA.pid, { kind: "alive", startedMs: ownerA.startedMs }]]),
			),
		),
	).toEqual(ok("released"));
	expect(storage.owner).toBeNull();
});

test("live owner is idempotently reported and can be asked to stop after its build", async () => {
	const storage = new MemoryLockStorage();
	storage.owner = { ...ownerA };
	const current = identityPort(
		ownerB,
		new Map([[ownerA.pid, { kind: "alive", startedMs: ownerA.startedMs }]]),
	);
	expect(await acquireQueueLock(storage, current)).toEqual({
		ok: true,
		value: { kind: "already_running", owner: ownerA },
	});
	expect(await requestQueueStop(storage, current)).toEqual({
		ok: true,
		value: { kind: "stopping", pid: ownerA.pid },
	});
	expect(await queueStopRequested(storage)).toEqual(ok(true));
});

test("a stop request loses cleanly if the owner releases before the atomic marker write", async () => {
	const storage = new MemoryLockStorage();
	storage.owner = { ...ownerA };
	storage.loseOwnerBeforeStop = true;
	const current = identityPort(
		ownerB,
		new Map([[ownerA.pid, { kind: "alive", startedMs: ownerA.startedMs }]]),
	);
	expect(await requestQueueStop(storage, current)).toEqual({
		ok: true,
		value: { kind: "not_running" },
	});
	expect(storage.stop).toBe(false);
});

test("dead and reused-PID owners are replaced with a bounded compare-and-swap", async () => {
	for (const observation of [
		{ kind: "dead" as const },
		{ kind: "alive" as const, startedMs: ownerA.startedMs + 50 },
	]) {
		const storage = new MemoryLockStorage();
		storage.owner = { ...ownerA };
		storage.stop = true;
		const identity = identityPort(ownerB, new Map([[ownerA.pid, observation]]));
		expect(await acquireQueueLock(storage, identity)).toEqual({
			ok: true,
			value: { kind: "acquired", owner: ownerB, replacedStaleOwner: true },
		});
		expect(storage.owner).toEqual(ownerB);
		expect(storage.stop).toBe(false);
		expect(storage.changes).toContain("takeover");
		expect(
			await releaseQueueLock(
				storage,
				identityPort(
					ownerA,
					new Map([
						[ownerA.pid, { kind: "alive", startedMs: ownerA.startedMs }],
					]),
				),
			),
		).toEqual(ok("not_owner"));
	}
});

test("unavailable process identity refuses unsafe takeover or stop", async () => {
	const storage = new MemoryLockStorage();
	storage.owner = { ...ownerA };
	const identity = identityPort(
		ownerB,
		new Map([[ownerA.pid, { kind: "unknown" }]]),
	);
	expect(await acquireQueueLock(storage, identity)).toEqual({
		ok: true,
		value: { kind: "owner_unknown", owner: ownerA },
	});
	expect(await requestQueueStop(storage, identity)).toEqual({
		ok: true,
		value: { kind: "owner_unknown", owner: ownerA },
	});
	expect(storage.owner).toEqual(ownerA);
	expect(storage.stop).toBe(false);
});

test("failed atomic acquisition leaves no owner", async () => {
	const storage = new MemoryLockStorage();
	storage.failAcquire = true;
	const identity = identityPort(ownerA, new Map());
	const acquired = await acquireQueueLock(storage, identity);
	expect(acquired.ok).toBe(false);
	if (!acquired.ok) expect(acquired.error.code).toBe("io");
	expect(storage.owner).toBeNull();
});
