/** Milliseconds measured from a process-local monotonic clock. */
export type MonotonicMilliseconds = number;

/** Milliseconds since the Unix epoch, used only for persisted timestamps. */
export type UnixMilliseconds = number;

export interface ClockPort {
	monotonicMilliseconds(): MonotonicMilliseconds;
	unixMilliseconds(): UnixMilliseconds;
	sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
