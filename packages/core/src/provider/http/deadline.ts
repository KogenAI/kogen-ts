import type { ClockPort } from "../../contracts/clock";

export type HttpDeadlineKind =
	| "first_byte_timeout"
	| "idle_stall"
	| "total_timeout"
	| "cancelled";

export class HttpDeadlineError extends Error {
	constructor(
		readonly kind: HttpDeadlineKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HttpDeadlineError";
	}
}

export interface HttpDeadlineLimits {
	readonly firstByteTimeoutMilliseconds: number;
	readonly idleTimeoutMilliseconds: number;
	readonly totalTimeoutMilliseconds: number;
}

type TimerKind = "first_byte" | "idle" | "total";

const deadlinesBySignal = new WeakMap<AbortSignal, HttpDeadline>();

/**
 * A single request's clocks. Construct this before auth/credential work and
 * pass `signal` into HttpPort.request so first-byte and total time include it.
 * Call `complete()` if auth fails before the HTTP request is started.
 */
export class HttpDeadline {
	readonly signal: AbortSignal;
	readonly startedAt: number;
	readonly limits: HttpDeadlineLimits;
	private readonly controller = new AbortController();
	private readonly timers = new Map<TimerKind, AbortController>();
	private parentSignal: AbortSignal | undefined;
	private parentAbort: (() => void) | undefined;
	private firstByteAt: number | null = null;
	private lastBodyByteAt: number | null = null;
	private closed = false;
	private failure: HttpDeadlineError | null = null;

	constructor(
		private readonly clock: ClockPort,
		limits: HttpDeadlineLimits,
		parentSignal?: AbortSignal,
	) {
		validateLimits(limits);
		this.limits = Object.freeze({ ...limits });
		this.startedAt = checkedMonotonicNow(clock);
		this.signal = this.controller.signal;
		this.parentSignal = parentSignal;
		if (parentSignal) {
			const onAbort = () => {
				this.fail(
					"cancelled",
					"HTTP request was cancelled.",
					parentSignal.reason,
				);
			};
			this.parentAbort = onAbort;
			if (parentSignal.aborted) onAbort();
			else parentSignal.addEventListener("abort", onAbort, { once: true });
		}
		deadlinesBySignal.set(this.signal, this);
		if (!this.failure) {
			this.schedule("first_byte");
			this.schedule("total");
		}
	}

	get error(): HttpDeadlineError | null {
		this.checkExpired();
		return this.failure;
	}

	get firstByteReceived(): boolean {
		return this.firstByteAt !== null;
	}

	/** Call for every non-empty chunk, including SSE comments and keepalives. */
	markBodyByte(): void {
		this.throwIfUnavailable();
		const now = checkedMonotonicNow(this.clock);
		if (this.firstByteAt === null) {
			this.firstByteAt = now;
			this.cancelTimer("first_byte");
		}
		this.lastBodyByteAt = now;
		this.schedule("idle");
	}

	throwIfUnavailable(): void {
		this.checkExpired();
		if (this.failure) throw this.failure;
		if (this.closed)
			throw new HttpDeadlineError(
				"cancelled",
				"HTTP request deadline is already closed.",
			);
	}

	/** Stop timers after the response body is consumed or abandoned. */
	complete(): void {
		if (this.closed) return;
		this.closed = true;
		this.cancelTimers();
		this.detachParent();
		deadlinesBySignal.delete(this.signal);
	}

	private schedule(kind: TimerKind): void {
		if (this.closed || this.failure) return;
		this.cancelTimer(kind);
		const timer = new AbortController();
		this.timers.set(kind, timer);
		const elapsed = this.elapsedFor(kind);
		const limit = this.limitFor(kind);
		// The exact boundary is within the deadline; the first expired integer
		// millisecond is limit + 1.
		const remaining = Math.max(1, limit - elapsed + 1);
		let sleeping: Promise<void>;
		try {
			sleeping = this.clock.sleep(remaining, timer.signal);
		} catch (cause) {
			this.timers.delete(kind);
			this.fail(timerFailureKind(kind), "HTTP deadline clock failed.", cause);
			return;
		}
		void sleeping.then(
			() => {
				if (this.timers.get(kind) !== timer) return;
				this.timers.delete(kind);
				try {
					this.checkExpired();
					if (!this.closed && !this.failure) this.schedule(kind);
				} catch (cause) {
					this.fail(
						timerFailureKind(kind),
						"HTTP deadline clock failed.",
						cause,
					);
				}
			},
			(cause: unknown) => {
				if (this.timers.get(kind) !== timer || timer.signal.aborted) return;
				this.timers.delete(kind);
				this.fail(timerFailureKind(kind), "HTTP deadline clock failed.", cause);
			},
		);
	}

	private checkExpired(): void {
		if (this.closed || this.failure) return;
		const now = checkedMonotonicNow(this.clock);
		if (now - this.startedAt > this.limits.totalTimeoutMilliseconds) {
			this.fail("total_timeout", "HTTP request exceeded its total deadline.");
			return;
		}
		if (
			this.firstByteAt === null &&
			now - this.startedAt > this.limits.firstByteTimeoutMilliseconds
		) {
			this.fail(
				"first_byte_timeout",
				"HTTP request timed out before its first body byte.",
			);
			return;
		}
		if (
			this.lastBodyByteAt !== null &&
			now - this.lastBodyByteAt > this.limits.idleTimeoutMilliseconds
		)
			this.fail("idle_stall", "HTTP response stream became idle.");
	}

	private fail(kind: HttpDeadlineKind, message: string, cause?: unknown): void {
		if (this.closed || this.failure) return;
		this.failure = new HttpDeadlineError(
			kind,
			message,
			cause === undefined ? undefined : { cause },
		);
		this.cancelTimers();
		this.detachParent();
		this.controller.abort(this.failure);
	}

	private elapsedFor(kind: TimerKind): number {
		const now = checkedMonotonicNow(this.clock);
		const since =
			kind === "idle" ? (this.lastBodyByteAt ?? now) : this.startedAt;
		return now - since;
	}

	private limitFor(kind: TimerKind): number {
		if (kind === "first_byte") return this.limits.firstByteTimeoutMilliseconds;
		if (kind === "idle") return this.limits.idleTimeoutMilliseconds;
		return this.limits.totalTimeoutMilliseconds;
	}

	private cancelTimer(kind: TimerKind): void {
		const timer = this.timers.get(kind);
		if (!timer) return;
		this.timers.delete(kind);
		timer.abort();
	}

	private cancelTimers(): void {
		for (const kind of this.timers.keys()) this.cancelTimer(kind);
	}

	private detachParent(): void {
		if (this.parentSignal && this.parentAbort)
			this.parentSignal.removeEventListener("abort", this.parentAbort);
	}
}

export function createHttpDeadline(
	clock: ClockPort,
	limits: HttpDeadlineLimits,
	parentSignal?: AbortSignal,
): HttpDeadline {
	return new HttpDeadline(clock, limits, parentSignal);
}

export function httpDeadlineForSignal(
	signal: AbortSignal | undefined,
): HttpDeadline | undefined {
	return signal ? deadlinesBySignal.get(signal) : undefined;
}

function validateLimits(limits: HttpDeadlineLimits): void {
	for (const [name, value] of [
		["firstByteTimeoutMilliseconds", limits.firstByteTimeoutMilliseconds],
		["idleTimeoutMilliseconds", limits.idleTimeoutMilliseconds],
		["totalTimeoutMilliseconds", limits.totalTimeoutMilliseconds],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new RangeError(`${name} must be a positive safe integer.`);
	}
}

function checkedMonotonicNow(clock: ClockPort): number {
	const value = clock.monotonicMilliseconds();
	if (!Number.isFinite(value) || value < 0)
		throw new RangeError("Monotonic clock returned an invalid value.");
	return value;
}

function timerFailureKind(kind: TimerKind): HttpDeadlineKind {
	if (kind === "first_byte") return "first_byte_timeout";
	if (kind === "idle") return "idle_stall";
	return "total_timeout";
}
