import { writeSync } from "node:fs";
import type {
	QueueSignal,
	QueueSignalSource,
} from "../../../core/src/queue/drain";

export interface SignalEventTarget {
	on(signal: QueueSignal, listener: () => void): unknown;
	removeListener(signal: QueueSignal, listener: () => void): unknown;
}

export interface ProcessSignalCustody {
	readonly source: QueueSignalSource;
	dispose(): void;
}

/**
 * Keep SIGINT/SIGTERM in the command controller long enough for the active
 * Build handle to stop its child groups and record interruption before exit.
 */
export function installProcessSignalCustody(
	target: SignalEventTarget = process,
): ProcessSignalCustody {
	const listeners = new Set<(signal: QueueSignal) => void>();
	let current: QueueSignal | null = null;
	const dispatch = (signal: QueueSignal) => {
		if (current !== null) return;
		current = signal;
		for (const listener of [...listeners]) listener(signal);
	};
	const onInterrupt = () => dispatch("SIGINT");
	const onTerminate = () => dispatch("SIGTERM");
	target.on("SIGINT", onInterrupt);
	target.on("SIGTERM", onTerminate);
	return {
		source: {
			subscribe(listener) {
				listeners.add(listener);
				if (current !== null) listener(current);
				return () => listeners.delete(listener);
			},
		},
		dispose() {
			target.removeListener("SIGINT", onInterrupt);
			target.removeListener("SIGTERM", onTerminate);
			listeners.clear();
		},
	};
}

const HANDSHAKE_ENV = "KOGEN_QUEUE_HANDSHAKE_FD";

/** The detached child signals readiness only after it owns queue.pid. */
export function sendQueueStartupHandshake(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	write: (fd: number, bytes: Uint8Array) => number = writeSync,
): boolean {
	const raw = environment[HANDSHAKE_ENV];
	if (raw === undefined) return false;
	if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(raw))
		throw new TypeError("Detached queue handshake descriptor is invalid.");
	const fd = Number(raw);
	if (!Number.isSafeInteger(fd) || fd < 0 || fd > 65_535)
		throw new TypeError("Detached queue handshake descriptor is invalid.");
	const message = new TextEncoder().encode(`ready:${process.pid}\n`);
	const written = write(fd, message);
	if (written !== message.byteLength)
		throw new Error("Detached queue startup handshake was incomplete.");
	return true;
}

export function hasQueueStartupHandshake(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return environment[HANDSHAKE_ENV] !== undefined;
}
