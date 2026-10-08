import type { ClockPort } from "../contracts/clock";

export interface BuildBudgetSnapshot {
	readonly budgetMilliseconds: number;
	readonly elapsedMilliseconds: number;
	readonly usedMilliseconds: number;
	readonly pausedMilliseconds: number;
	readonly remainingMilliseconds: number;
	readonly pauseDepth: number;
}

export type BuildBudgetWaitResult = "expired" | "cancelled";

/**
 * A monotonic Build clock. Overlapping provider pauses are counted once, and
 * the budget can be shared by concurrent rungs without multiplying pause time.
 */
export class BuildBudget {
	readonly budgetMilliseconds: number;
	private readonly startedAt: number;
	private lastRead = 0;
	private pauseStartedAt: number | null = null;
	private completedPauseMilliseconds = 0;
	private pauseCount = 0;
	private readonly listeners = new Set<() => void>();

	constructor(
		budgetMilliseconds: number,
		private readonly clock: Pick<ClockPort, "monotonicMilliseconds" | "sleep">,
	) {
		if (!Number.isSafeInteger(budgetMilliseconds) || budgetMilliseconds < 0)
			throw new RangeError("Build budget must be a non-negative safe integer.");
		this.budgetMilliseconds = budgetMilliseconds;
		const startedAt = clock.monotonicMilliseconds();
		if (!Number.isFinite(startedAt) || startedAt < 0)
			throw new RangeError("Build clock returned an invalid monotonic time.");
		this.startedAt = startedAt;
		this.lastRead = startedAt;
	}

	/** Active monotonic time suitable for rung wall calculations. */
	activeMonotonicMilliseconds(): number {
		const now = this.readClock();
		const paused = this.totalPausedAt(now);
		return Math.max(0, Math.floor(now - this.startedAt - paused));
	}

	snapshot(): BuildBudgetSnapshot {
		const now = this.readClock();
		const elapsedMilliseconds = Math.max(0, Math.floor(now - this.startedAt));
		const pausedMilliseconds = Math.max(0, Math.floor(this.totalPausedAt(now)));
		const usedMilliseconds = Math.max(
			0,
			elapsedMilliseconds - pausedMilliseconds,
		);
		return Object.freeze({
			budgetMilliseconds: this.budgetMilliseconds,
			elapsedMilliseconds,
			usedMilliseconds,
			pausedMilliseconds,
			remainingMilliseconds: Math.max(
				0,
				this.budgetMilliseconds - usedMilliseconds,
			),
			pauseDepth: this.pauseCount,
		});
	}

	remainingMilliseconds(): number {
		return this.snapshot().remainingMilliseconds;
	}

	/** Begin a provider pause. The idempotent release closes the pause interval. */
	pause(): () => void {
		const now = this.readClock();
		if (this.pauseCount === 0) this.pauseStartedAt = now;
		this.pauseCount += 1;
		this.notifyChange();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.readClock();
			this.pauseCount -= 1;
			if (this.pauseCount < 0)
				throw new Error("Build budget pause depth became negative.");
			if (this.pauseCount === 0 && this.pauseStartedAt !== null) {
				const resumedAt = this.lastRead;
				this.completedPauseMilliseconds += resumedAt - this.pauseStartedAt;
				this.pauseStartedAt = null;
			}
			this.notifyChange();
		};
	}

	/** Resolve when active time is exhausted; pause changes re-arm the timer. */
	async waitUntilExhausted(
		signal?: AbortSignal,
	): Promise<BuildBudgetWaitResult> {
		while (true) {
			if (signal?.aborted) return "cancelled";
			const current = this.snapshot();
			if (current.remainingMilliseconds === 0) return "expired";

			let resolveChanged!: () => void;
			const changed = new Promise<void>((resolve) => {
				resolveChanged = resolve;
			});
			this.listeners.add(resolveChanged);

			const sleepAbort = new AbortController();
			const sleepResult: Promise<"timer" | "changed"> =
				current.pauseDepth > 0
					? new Promise(() => {})
					: this.clock
							.sleep(current.remainingMilliseconds, sleepAbort.signal)
							.then(
								() => "timer" as const,
								() =>
									sleepAbort.signal.aborted
										? ("changed" as const)
										: Promise.reject(
												new Error("Build budget clock sleep failed."),
											),
							);

			let removeAbortListener = (): void => {};
			const aborted = new Promise<"aborted">((resolve) => {
				if (signal === undefined) return;
				const onAbort = (): void => resolve("aborted");
				if (signal.aborted) onAbort();
				else {
					signal.addEventListener("abort", onAbort, { once: true });
					removeAbortListener = () =>
						signal.removeEventListener("abort", onAbort);
				}
			});

			try {
				const result = await Promise.race([
					changed.then(() => "changed" as const),
					sleepResult,
					aborted,
				]);
				if (result === "aborted") return "cancelled";
			} finally {
				this.listeners.delete(resolveChanged);
				removeAbortListener();
				sleepAbort.abort();
			}
		}
	}

	private totalPausedAt(now: number): number {
		return (
			this.completedPauseMilliseconds +
			(this.pauseStartedAt === null ? 0 : now - this.pauseStartedAt)
		);
	}

	private readClock(): number {
		const value = this.clock.monotonicMilliseconds();
		if (!Number.isFinite(value) || value < 0 || value < this.lastRead)
			throw new RangeError("Build clock returned an invalid monotonic time.");
		this.lastRead = value;
		return value;
	}

	private notifyChange(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
