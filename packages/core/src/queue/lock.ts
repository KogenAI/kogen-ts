import type { PortError, Result } from "../contracts/errors";

export interface QueueOwnerIdentity {
	readonly pid: number;
	/** Stable process start identity, recorded in epoch milliseconds. */
	readonly startedMs: number;
}

export type ProcessIdentityObservation =
	| { readonly kind: "alive"; readonly startedMs: number }
	| { readonly kind: "dead" }
	| { readonly kind: "unknown" };

export type OwnerLiveness = "live" | "stale" | "unknown";

export interface ProcessIdentityPort {
	current(): QueueOwnerIdentity;
	inspect(pid: number): Promise<Result<ProcessIdentityObservation>>;
}

/**
 * Atomic operations for the project state root's queue.pid and queue.stop.
 * Implementations keep queue.pid as `<pid>\n` and persist startedMs beside
 * that public PID projection so PID reuse cannot make a stale owner look live.
 */
export interface QueueLockStorage {
	readOwner(): Promise<Result<QueueOwnerIdentity | null>>;
	/** These methods atomically coordinate queue.pid, its start identity, and queue.stop. */
	createOwnerAndClearStop(
		owner: QueueOwnerIdentity,
	): Promise<Result<"created" | "exists">>;
	compareExchangeOwnerAndClearStop(
		expected: QueueOwnerIdentity,
		replacement: QueueOwnerIdentity,
	): Promise<Result<boolean>>;
	removeOwnerIf(owner: QueueOwnerIdentity): Promise<Result<boolean>>;
	/** Write stop only if the exact owner is still present, in the same transaction. */
	requestStopIfOwner(owner: QueueOwnerIdentity): Promise<Result<boolean>>;
	readStopRequest(): Promise<Result<boolean>>;
}

export type QueueLockAcquire =
	| {
			readonly kind: "acquired";
			readonly owner: QueueOwnerIdentity;
			readonly replacedStaleOwner: boolean;
	  }
	| { readonly kind: "already_running"; readonly owner: QueueOwnerIdentity }
	| { readonly kind: "owner_unknown"; readonly owner: QueueOwnerIdentity };

export type QueueStopRequest =
	| { readonly kind: "stopping"; readonly pid: number }
	| { readonly kind: "not_running" }
	| { readonly kind: "owner_unknown"; readonly owner: QueueOwnerIdentity };

export type QueueLockRelease = "released" | "not_owner";

function failure(
	message: string,
	code: PortError["code"] = "conflict",
): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

export function isValidQueueOwnerIdentity(owner: QueueOwnerIdentity): boolean {
	return (
		Number.isSafeInteger(owner.pid) &&
		owner.pid > 0 &&
		Number.isSafeInteger(owner.startedMs) &&
		owner.startedMs >= 0
	);
}

/** A live PID with a different start identity is a reused PID, hence stale. */
export function classifyOwnerLiveness(
	owner: QueueOwnerIdentity,
	observation: ProcessIdentityObservation,
): OwnerLiveness {
	if (observation.kind === "dead") return "stale";
	if (observation.kind === "unknown") return "unknown";
	return observation.startedMs === owner.startedMs ? "live" : "stale";
}

async function inspectOwner(
	identity: ProcessIdentityPort,
	owner: QueueOwnerIdentity,
): Promise<Result<OwnerLiveness>> {
	let observation: Result<ProcessIdentityObservation>;
	try {
		observation = await identity.inspect(owner.pid);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message: "Process identity inspection failed.",
				retryable: true,
				cause,
			},
		};
	}
	if (!observation.ok) return observation;
	return {
		ok: true,
		value: classifyOwnerLiveness(owner, observation.value),
	};
}

/**
 * Acquire the per-checkout drain lock. Stale takeover is compare-and-swap and
 * deliberately bounded to the two attempts specified for queue.pid.
 */
export async function acquireQueueLock(
	storage: QueueLockStorage,
	identity: ProcessIdentityPort,
): Promise<Result<QueueLockAcquire>> {
	const owner = identity.current();
	if (!isValidQueueOwnerIdentity(owner))
		return {
			ok: false,
			error: failure("Current process identity is invalid.", "invalid_input"),
		};
	let replacedStaleOwner = false;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const read = await storage.readOwner();
		if (!read.ok) return read;
		if (read.value === null) {
			const created = await storage.createOwnerAndClearStop(owner);
			if (!created.ok) return created;
			if (created.value === "exists") continue;
			return {
				ok: true,
				value: { kind: "acquired", owner, replacedStaleOwner },
			};
		}
		const current = read.value;
		if (!isValidQueueOwnerIdentity(current))
			return {
				ok: false,
				error: failure("Queue lock owner record is invalid.", "invalid_input"),
			};
		const liveness = await inspectOwner(identity, current);
		if (!liveness.ok) return liveness;
		if (liveness.value === "live")
			return { ok: true, value: { kind: "already_running", owner: current } };
		if (liveness.value === "unknown")
			return { ok: true, value: { kind: "owner_unknown", owner: current } };
		const exchanged = await storage.compareExchangeOwnerAndClearStop(
			current,
			owner,
		);
		if (!exchanged.ok) return exchanged;
		if (!exchanged.value) continue;
		replacedStaleOwner = true;
		return {
			ok: true,
			value: { kind: "acquired", owner, replacedStaleOwner },
		};
	}
	return {
		ok: false,
		error: failure("Queue lock changed during both acquisition attempts."),
	};
}

/** The stop marker is written only while the stored process identity is live. */
export async function requestQueueStop(
	storage: QueueLockStorage,
	identity: ProcessIdentityPort,
): Promise<Result<QueueStopRequest>> {
	const read = await storage.readOwner();
	if (!read.ok) return read;
	if (read.value === null) return { ok: true, value: { kind: "not_running" } };
	const owner = read.value;
	if (!isValidQueueOwnerIdentity(owner))
		return {
			ok: false,
			error: failure("Queue lock owner record is invalid.", "invalid_input"),
		};
	const liveness = await inspectOwner(identity, owner);
	if (!liveness.ok) return liveness;
	if (liveness.value === "stale")
		return { ok: true, value: { kind: "not_running" } };
	if (liveness.value === "unknown")
		return { ok: true, value: { kind: "owner_unknown", owner } };
	const requested = await storage.requestStopIfOwner(owner);
	if (!requested.ok) return requested;
	if (!requested.value) return { ok: true, value: { kind: "not_running" } };
	return { ok: true, value: { kind: "stopping", pid: owner.pid } };
}

export async function queueStopRequested(
	storage: QueueLockStorage,
): Promise<Result<boolean>> {
	return storage.readStopRequest();
}

/** Only the process that still matches the stored PID/start identity can release. */
export async function releaseQueueLock(
	storage: QueueLockStorage,
	identity: ProcessIdentityPort,
): Promise<Result<QueueLockRelease>> {
	const owner = identity.current();
	if (!isValidQueueOwnerIdentity(owner))
		return {
			ok: false,
			error: failure("Queue lock owner identity is invalid.", "invalid_input"),
		};
	const removed = await storage.removeOwnerIf(owner);
	if (!removed.ok) return removed;
	return { ok: true, value: removed.value ? "released" : "not_owner" };
}
