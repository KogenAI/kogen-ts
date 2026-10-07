import type { StatusInput } from "./derive";
import { type DerivedStatus, isStatusWatchIdle } from "./derive";
import { renderStatusText } from "./render";

export interface StatusWatchSnapshot {
	readonly status: DerivedStatus;
	readonly input: StatusInput;
}

/** The caller returns a fresh, post-recovery status snapshot on every read. */
export interface StatusWatchSource {
	read(): Promise<StatusWatchSnapshot>;
	wait(milliseconds: number): Promise<void>;
}

export interface WatchStatusRequest {
	readonly source: StatusWatchSource;
	readonly write: (chunk: string) => void | Promise<void>;
	readonly slug?: string;
	readonly timeScale?: number;
}

export interface WatchStatusResult {
	readonly exitCode: 0 | 1 | 2;
	readonly frames: number;
}

export const STATUS_WATCH_POLL_MS = 2_000;
export const STATUS_WATCH_MIN_POLL_MS = 100;

export function statusWatchPollMilliseconds(timeScale = 1): number {
	if (!Number.isFinite(timeScale) || timeScale < 0)
		throw new RangeError(
			"Status watch time scale must be a nonnegative number.",
		);
	return Math.max(
		STATUS_WATCH_MIN_POLL_MS,
		Math.trunc(STATUS_WATCH_POLL_MS * timeScale),
	);
}

/**
 * Stream a full frame immediately and on changes only. Each call to `write`
 * receives one frame; later frames are separated from the prior frame by a
 * blank line. The reader is responsible for running crash recovery first.
 */
export async function watchStatus(
	request: WatchStatusRequest,
): Promise<WatchStatusResult> {
	const pollMilliseconds = statusWatchPollMilliseconds(request.timeScale ?? 1);
	let previousFrame: string | null = null;
	let frameCount = 0;
	for (;;) {
		const snapshot = await request.source.read();
		const frame = renderStatusText(
			snapshot.status,
			snapshot.input,
			request.slug,
		);
		if (frame === null) return { exitCode: 2, frames: frameCount };
		if (frame !== previousFrame) {
			await request.write(`${previousFrame === null ? "" : "\n"}${frame}`);
			previousFrame = frame;
			frameCount += 1;
		}
		if (isStatusWatchIdle(snapshot.status)) {
			if (request.slug === undefined)
				return { exitCode: 0, frames: frameCount };
			const target = snapshot.status.bySlug.get(request.slug);
			if (target === undefined) return { exitCode: 2, frames: frameCount };
			return {
				exitCode: target.status === "landed" ? 0 : 1,
				frames: frameCount,
			};
		}
		await request.source.wait(pollMilliseconds);
	}
}
