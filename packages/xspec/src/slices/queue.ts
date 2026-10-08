import type { Result } from "../../../core/src/contracts/errors";
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
} from "../../../core/src/queue/lock";
import {
	initialQueueDrain,
	type QueueBuildOutcome,
	type QueueDrainState,
	type QueueIntent,
	transitionQueue,
} from "../../../core/src/queue/transition";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

type QueueTag =
	| "Init"
	| "Enqueue"
	| "Start"
	| "Die"
	| "Halt"
	| "Outcome"
	| "Release";

interface QueueObservation {
	readonly last: string;
	readonly line: string;
	readonly exit: number;
	readonly held: boolean;
	readonly alive: boolean;
	readonly stop: boolean;
	readonly phase: "idle" | "building";
	readonly current: string;
	readonly queue: readonly string[];
	readonly built: number;
	readonly landed: number;
}

const KNOWN_SLUGS = new Set(["alpha", "bravo", "charlie"]);
const OUTCOMES = new Set<QueueBuildOutcome>([
	"landed",
	"failed",
	"failed_provider",
	"parked",
	"stopped_environment",
	"stopped_provider",
	"stopped_controller",
	"skipped",
]);

function eventValue(
	value: unknown,
	tag: QueueTag,
	fields: readonly string[],
): Record<string, unknown> {
	const decoded = decodeSliceEvent(value);
	if (decoded.tag !== tag)
		throw new XspecProtocolError(
			"invalid_event",
			`queue slice expected a ${tag} event`,
		);
	if (fields.length === 0) {
		if (decoded.value !== undefined)
			throw new XspecProtocolError(
				"invalid_event",
				`${tag} event does not accept a value`,
			);
		return Object.create(null) as Record<string, unknown>;
	}
	if (decoded.value === undefined)
		throw new XspecProtocolError(
			"invalid_event",
			`${tag} event requires a value`,
		);
	if (
		Object.keys(decoded.value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(decoded.value ?? {}, field))
	)
		throw new XspecProtocolError(
			"invalid_event",
			`${tag} event does not match the frozen field schema`,
		);
	return decoded.value;
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string")
		throw new XspecProtocolError(
			"invalid_event",
			`Queue.${key} must be a string`,
		);
	return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (typeof field !== "number" || !Number.isSafeInteger(field))
		throw new XspecProtocolError(
			"invalid_event",
			`Queue.${key} must be a safe integer`,
		);
	return field;
}

function decodeQueueEvent(value: unknown): {
	readonly tag: QueueTag;
	readonly value: Record<string, unknown>;
} {
	const decoded = decodeSliceEvent(value);
	switch (decoded.tag) {
		case "Init":
		case "Start":
		case "Die":
		case "Halt":
		case "Release":
			return {
				tag: decoded.tag,
				value: eventValue(value, decoded.tag, []),
			};
		case "Enqueue":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Enqueue", ["slug", "time", "priority"]),
			};
		case "Outcome":
			return {
				tag: decoded.tag,
				value: eventValue(value, "Outcome", ["kind"]),
			};
		default:
			throw new XspecProtocolError(
				"invalid_event",
				`queue slice does not recognize event ${JSON.stringify(decoded.tag)}`,
			);
	}
}

function sameOwner(
	left: QueueOwnerIdentity | null,
	right: QueueOwnerIdentity,
): boolean {
	return (
		left !== null &&
		left.pid === right.pid &&
		left.startedMs === right.startedMs
	);
}

/** In-memory effect port: owner/process observations still go through core lock policy. */
class QueueLockFixture implements QueueLockStorage, ProcessIdentityPort {
	private owner: QueueOwnerIdentity | null = null;
	private stop = false;
	private incarnation = 1;
	private readonly processes = new Map<number, ProcessIdentityObservation>();

	current(): QueueOwnerIdentity {
		return { pid: 4242 + this.incarnation - 1, startedMs: this.incarnation };
	}

	async inspect(pid: number): Promise<Result<ProcessIdentityObservation>> {
		const observation = this.processes.get(pid);
		return {
			ok: true,
			value: observation ?? { kind: "unknown" },
		};
	}

	async readOwner(): Promise<Result<QueueOwnerIdentity | null>> {
		return { ok: true, value: this.owner };
	}

	async createOwnerAndClearStop(
		owner: QueueOwnerIdentity,
	): Promise<Result<"created" | "exists">> {
		if (this.owner !== null) return { ok: true, value: "exists" };
		this.owner = owner;
		this.stop = false;
		this.processes.set(owner.pid, {
			kind: "alive",
			startedMs: owner.startedMs,
		});
		return { ok: true, value: "created" };
	}

	async compareExchangeOwnerAndClearStop(
		expected: QueueOwnerIdentity,
		replacement: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		if (!sameOwner(this.owner, expected)) return { ok: true, value: false };
		this.owner = replacement;
		this.stop = false;
		this.processes.set(replacement.pid, {
			kind: "alive",
			startedMs: replacement.startedMs,
		});
		return { ok: true, value: true };
	}

	async removeOwnerIf(owner: QueueOwnerIdentity): Promise<Result<boolean>> {
		if (!sameOwner(this.owner, owner)) return { ok: true, value: false };
		this.owner = null;
		this.stop = false;
		return { ok: true, value: true };
	}

	async requestStopIfOwner(
		owner: QueueOwnerIdentity,
	): Promise<Result<boolean>> {
		if (!sameOwner(this.owner, owner)) return { ok: true, value: false };
		this.stop = true;
		return { ok: true, value: true };
	}

	async readStopRequest(): Promise<Result<boolean>> {
		return { ok: true, value: this.stop };
	}

	markOwnerDead(): boolean {
		if (this.owner === null) return false;
		this.processes.set(this.owner.pid, { kind: "dead" });
		this.incarnation += 1;
		return true;
	}

	reset(): void {
		this.owner = null;
		this.stop = false;
		this.incarnation = 1;
		this.processes.clear();
	}
}

interface QueueSliceState {
	readonly lock: QueueLockFixture;
	items: Map<string, QueueIntent>;
	drain: QueueDrainState;
	last: string;
	line: string;
}

function emptyState(): QueueSliceState {
	return {
		lock: new QueueLockFixture(),
		items: new Map(),
		drain: initialQueueDrain([]),
		last: "ok",
		line: "",
	};
}

function unwrap<T>(result: Result<T>, operation: string): T {
	if (!result.ok)
		throw new Error(`Queue ${operation} failed: ${result.error.message}`);
	return result.value;
}

async function observation(state: QueueSliceState): Promise<QueueObservation> {
	const owner = unwrap(await state.lock.readOwner(), "owner read");
	let alive = false;
	if (owner !== null) {
		const process = unwrap(
			await state.lock.inspect(owner.pid),
			"owner inspection",
		);
		alive = classifyOwnerLiveness(owner, process) === "live";
	}
	const stop = unwrap(await queueStopRequested(state.lock), "stop read");
	// The production drain retains its attempted set after releasing ownership.
	// The model clears it at finish; while idle, all pending approvals remain
	// observable so a stopped provider Build can be retried.
	const attempted = state.drain.running
		? new Set(state.drain.attempted)
		: new Set<string>();
	return {
		last: state.last,
		line: state.line,
		exit: state.drain.exitCode,
		held: owner !== null,
		alive,
		stop,
		phase: state.drain.current === null ? "idle" : "building",
		current: state.drain.current?.slug ?? "",
		queue: state.drain.pending
			.filter((intent) => !attempted.has(intent.slug))
			.map((intent) => intent.slug),
		built: state.drain.builds,
		landed: state.drain.landed,
	};
}

function queueItem(value: Record<string, unknown>): QueueIntent {
	const slug = stringField(value, "slug");
	const time = integerField(value, "time");
	const priority = integerField(value, "priority");
	if (time < 0)
		throw new XspecProtocolError(
			"invalid_event",
			"Queue.time must be a nonnegative safe integer",
		);
	return {
		slug,
		approved: true,
		landed: false,
		priority,
		approvedAt: time,
		blocksOn: [],
	};
}

function refreshQueueItems(state: QueueSliceState): void {
	const selected = initialQueueDrain([...state.items.values()]).pending;
	if (!state.drain.running) {
		state.drain = {
			...state.drain,
			pending: selected,
			attempted: [],
			current: null,
			running: false,
			stopRequested: false,
		};
		return;
	}
	state.drain = transitionQueue(state.drain, {
		type: "refresh",
		queue: [...state.items.values()],
	});
}

function reconcileFinishedDrain(state: QueueSliceState): void {
	if (state.drain.running) return;
	state.drain = {
		...state.drain,
		pending: initialQueueDrain([...state.items.values()]).pending,
		attempted: [],
		current: null,
		stopRequested: false,
	};
}

async function finishOwner(state: QueueSliceState): Promise<void> {
	const released = unwrap(
		await releaseQueueLock(state.lock, state.lock),
		"owner release",
	);
	if (released === "not_owner") {
		state.last = "not_owner";
		state.line = "not_owner";
	}
}

async function applyEvent(
	state: QueueSliceState,
	value: unknown,
): Promise<QueueObservation> {
	const { tag, value: event } = decodeQueueEvent(value);
	switch (tag) {
		case "Init":
			state.items.clear();
			state.drain = initialQueueDrain([]);
			state.last = "ok";
			state.line = "";
			state.lock.reset();
			break;
		case "Enqueue": {
			const item = queueItem(event);
			if (!KNOWN_SLUGS.has(item.slug)) {
				state.last = "unknown_slug";
				state.line = "unknown_slug";
				break;
			}
			state.items.set(item.slug, item);
			refreshQueueItems(state);
			state.last = "ok";
			state.line = "enqueued";
			break;
		}
		case "Start": {
			const acquired = unwrap(
				await acquireQueueLock(state.lock, state.lock),
				"owner acquisition",
			);
			if (acquired.kind === "already_running") {
				state.last = "ok";
				state.line = "already_running";
				break;
			}
			if (acquired.kind === "owner_unknown") {
				state.last = "owner_unknown";
				state.line = "owner_unknown";
				break;
			}
			state.drain = transitionQueue(
				initialQueueDrain([...state.items.values()]),
				{ type: "start" },
			);
			state.last = "ok";
			state.line = state.drain.line;
			if (!state.drain.running) await finishOwner(state);
			break;
		}
		case "Die":
			if (!state.lock.markOwnerDead()) {
				state.last = "no_process";
				state.line = "no_process";
			} else {
				state.last = "ok";
				state.line = "owner_dead";
			}
			break;
		case "Halt": {
			const request = unwrap(
				await requestQueueStop(state.lock, state.lock),
				"stop request",
			);
			if (request.kind === "not_running") {
				state.drain = transitionQueue(state.drain, { type: "stop" });
				state.last = "ok";
				state.line = "not_running";
			} else if (request.kind === "owner_unknown") {
				state.last = "owner_unknown";
				state.line = "owner_unknown";
			} else {
				state.drain = transitionQueue(state.drain, { type: "stop" });
				state.last = "ok";
				state.line = state.drain.line;
			}
			break;
		}
		case "Outcome": {
			const kind = stringField(event, "kind");
			const owner = unwrap(await state.lock.readOwner(), "owner read");
			const alive =
				owner !== null &&
				classifyOwnerLiveness(
					owner,
					unwrap(await state.lock.inspect(owner.pid), "owner inspection"),
				) === "live";
			if (!alive || state.drain.current === null) {
				state.last = "not_building";
				state.line = "not_building";
				break;
			}
			if (!OUTCOMES.has(kind as QueueBuildOutcome)) {
				state.last = "unknown_outcome";
				state.line = "unknown_outcome";
				break;
			}
			const current = state.drain.current.slug;
			state.drain = transitionQueue(state.drain, {
				type: "outcome",
				outcome: kind as QueueBuildOutcome,
			});
			if (
				kind !== "stopped_environment" &&
				kind !== "stopped_provider" &&
				kind !== "stopped_controller"
			)
				state.items.delete(current);
			reconcileFinishedDrain(state);
			state.last = "ok";
			state.line = state.drain.line;
			if (!state.drain.running) await finishOwner(state);
			break;
		}
		case "Release": {
			const owner = unwrap(await state.lock.readOwner(), "owner read");
			if (owner === null) {
				state.last = "not_owner";
				state.line = "not_owner";
				break;
			}
			const alive =
				classifyOwnerLiveness(
					owner,
					unwrap(await state.lock.inspect(owner.pid), "owner inspection"),
				) === "live";
			if (!alive) {
				state.last = "not_owner";
				state.line = "not_owner";
				break;
			}
			if (state.drain.current !== null) {
				state.last = "build_in_flight";
				state.line = "build_in_flight";
				break;
			}
			await finishOwner(state);
			state.drain = {
				...state.drain,
				running: false,
				stopRequested: false,
				current: null,
			};
			if (state.last === "ok") state.line = "released";
			break;
		}
	}
	return observation(state);
}

export async function createQueueSlice(): Promise<XspecSlice> {
	let state = emptyState();
	return {
		reset: async () => {
			state = emptyState();
			return observation(state);
		},
		apply: async (event) => applyEvent(state, event),
	};
}
