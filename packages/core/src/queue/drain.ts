import type { Result } from "../contracts/errors";
import {
	acquireQueueLock,
	type ProcessIdentityPort,
	type QueueLockStorage,
	type QueueOwnerIdentity,
	queueStopRequested,
	releaseQueueLock,
} from "./lock";
import {
	initialQueueDrain,
	type QueueBuildOutcome,
	type QueueDrainState,
	type QueueIntent,
	transitionQueue,
} from "./transition";

export type QueueSignal = "SIGINT" | "SIGTERM";

export interface QueueSignalSource {
	subscribe(listener: (signal: QueueSignal) => void): () => void;
}

export interface QueueStatusSnapshot {
	readonly queue: readonly QueueIntent[];
	readonly landedSlugs: ReadonlySet<string>;
}

export interface QueueBuildResult {
	readonly outcome: QueueBuildOutcome;
	/** Null for a B0 refusal or an approval skipped before a run was created. */
	readonly runId: string | null;
	readonly reason?: string;
	/** Required for a landed outcome and validated before it is counted as landed. */
	readonly commit?: string;
	readonly candidate?: {
		readonly verdict: string;
		readonly ref: string;
	};
}

export interface QueueBuildExecution {
	readonly completion: Promise<QueueBuildResult>;
	/**
	 * Must stop every run-owned child group and durably append the interrupted
	 * event with the supplied signal reason before resolving.
	 */
	interrupt(signal: QueueSignal): Promise<void>;
}

export interface QueueDrainPorts {
	readonly storage: QueueLockStorage;
	readonly identity: ProcessIdentityPort;
	recover(): Promise<Result<void>>;
	status(): Promise<Result<QueueStatusSnapshot>>;
	/** Starts the production Build for this approval. */
	startBuild(slug: string): Promise<QueueBuildExecution>;
	readonly signals: QueueSignalSource;
	writeLine(line: string): void | Promise<void>;
	/** Detached children use this to complete the parent's startup handshake. */
	onOwnerAcquired?(owner: QueueOwnerIdentity): Promise<void>;
}

export type QueueDrainResult =
	| {
			readonly kind: "finished";
			readonly state: QueueDrainState;
			readonly exitCode: number;
	  }
	| {
			readonly kind: "signal";
			readonly signal: QueueSignal;
			readonly exitCode: 130 | 143;
	  }
	| {
			readonly kind: "already_running";
			readonly pid: number;
			readonly exitCode: 0;
	  }
	| {
			readonly kind: "error";
			readonly code: string;
			readonly message: string;
			readonly exitCode: 3 | 70;
			readonly state?: QueueDrainState;
	  };

const RUN_ID = /^[a-f0-9]{32}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function isOneLine(value: string): boolean {
	return value.length > 0 && !/[\r\n\0]/u.test(value);
}

function errorResult(
	code: string,
	message: string,
	exitCode: 3 | 70 = 3,
	state?: QueueDrainState,
): QueueDrainResult {
	return {
		kind: "error",
		code,
		message,
		exitCode,
		...(state === undefined ? {} : { state }),
	};
}

function normalizeBuildResult(result: QueueBuildResult): QueueBuildResult {
	if (
		result.outcome === "landed" &&
		(!RUN_ID.test(result.runId ?? "") || !OBJECT_ID.test(result.commit ?? ""))
	)
		return {
			outcome: "stopped_controller",
			runId: null,
			reason: "controller/build_result_invalid",
		};
	if (
		(result.outcome === "failed" ||
			result.outcome === "failed_provider" ||
			result.outcome === "parked") &&
		!RUN_ID.test(result.runId ?? "")
	)
		return {
			outcome: "stopped_controller",
			runId: null,
			reason: "controller/build_result_invalid",
		};
	if (result.runId !== null && !RUN_ID.test(result.runId))
		return {
			outcome: "stopped_controller",
			runId: null,
			reason: "controller/build_result_invalid",
		};
	if (result.reason !== undefined && !isOneLine(result.reason))
		return {
			outcome: "stopped_controller",
			runId: null,
			reason: "controller/build_result_invalid",
		};
	if (
		result.candidate !== undefined &&
		(!isOneLine(result.candidate.verdict) || !isOneLine(result.candidate.ref))
	)
		return {
			outcome: "stopped_controller",
			runId: null,
			reason: "controller/build_result_invalid",
		};
	return result;
}

function buildSuffix(runId: string | null): string {
	return runId === null ? "" : ` (Build ${runId.slice(0, 8)})`;
}

function stoppedReason(
	result: QueueBuildResult,
	errorClass: "environment" | "provider" | "controller",
): string {
	const reason = result.reason ?? "unknown";
	const prefix = `${errorClass}/`;
	return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

/** Render the per-Intent line from a completed production Build result. */
export function formatQueueBuildLine(
	slug: string,
	result: QueueBuildResult,
): string {
	const normalized = normalizeBuildResult(result);
	const suffix = buildSuffix(normalized.runId);
	const reason = normalized.reason ?? "unknown";
	switch (normalized.outcome) {
		case "landed":
			return `landed ${slug} ${(normalized.commit ?? "").slice(0, 8)}${suffix}`;
		case "failed":
		case "failed_provider":
		case "parked": {
			const candidate =
				normalized.candidate ??
				({
					verdict: "unavailable",
					ref:
						normalized.runId === null
							? "unavailable"
							: `refs/kogen/parked/${normalized.runId}`,
				} as const);
			return `${normalized.outcome === "failed_provider" ? "failed" : normalized.outcome} ${slug}: ${reason}; best candidate ${candidate.verdict} at ${candidate.ref}${suffix}`;
		}
		case "stopped_environment":
			return `stopped ${slug}: environment/${stoppedReason(normalized, "environment")}; it stays queued${suffix}`;
		case "stopped_provider":
			return `stopped ${slug}: provider/${stoppedReason(normalized, "provider")}; it stays queued${suffix}`;
		case "stopped_controller":
			return `stopped ${slug}: controller/${stoppedReason(normalized, "controller")}; it stays queued${suffix}`;
		case "skipped":
			return `skipped ${slug}: ${reason}`;
	}
}

function countSummary(state: QueueDrainState): string {
	const notLanded = state.builds - state.landed;
	return `${state.builds} Build(s), ${state.landed} landed, ${notLanded} not`;
}

function finalQueueLine(state: QueueDrainState): string {
	switch (state.line) {
		case "nothing_to_build":
			return "queue: nothing to build";
		case "stopped_on_request":
			return `queue: stopped on request; ${countSummary(state)}`;
		case "stopped_because": {
			const slug = state.stoppedSlug ?? "unknown";
			const errorClass = state.stoppedClass ?? "controller";
			const article = errorClass === "environment" ? "an" : "a";
			return `queue: stopped because ${slug} hit ${article} ${errorClass} error; ${countSummary(state)}`;
		}
		default:
			return `queue: done; ${countSummary(state)}`;
	}
}

function stopAfterCurrent(state: QueueDrainState): QueueDrainState {
	const requested = state.running
		? transitionQueue(state, { type: "stop" })
		: state;
	return {
		...requested,
		current: null,
		running: false,
		stopRequested: false,
		line: "stopped_on_request",
		exitCode: 0,
		stoppedSlug: null,
		stoppedClass: null,
	};
}

function signalResult(signal: QueueSignal): QueueDrainResult {
	return {
		kind: "signal",
		signal,
		exitCode: signal === "SIGINT" ? 130 : 143,
	};
}

function portFailure(code: string, message: string): QueueDrainResult {
	return errorResult(code, message, 3);
}

/**
 * Execute the real queue side effects around the shared queue policy. The
 * status and recovery ports run again after every Build, before the next
 * approval is selected. A handler that only calls the reducer cannot complete
 * this function or report a landed Build.
 */
interface DrainExecutionState {
	observedSignal: QueueSignal | null;
	active: QueueBuildExecution | null;
	interruptPromise: Promise<void> | null;
	owner: QueueOwnerIdentity | null;
	readonly signalArrived: Promise<QueueSignal>;
	readonly resolveSignal: (signal: QueueSignal) => void;
}

async function finishWithSignal(
	state: DrainExecutionState,
	signal: QueueSignal,
): Promise<QueueDrainResult> {
	if (state.active !== null && state.interruptPromise === null)
		state.interruptPromise = Promise.resolve()
			.then(() => state.active?.interrupt(signal))
			.then(
				() => undefined,
				() => undefined,
			);
	if (state.interruptPromise !== null) await state.interruptPromise;
	return signalResult(signal);
}

/** Install signal custody, run the drain, and surface release failures. */
export async function drainQueue(
	ports: QueueDrainPorts,
): Promise<QueueDrainResult> {
	let resolveSignal: (signal: QueueSignal) => void = () => {};
	const signalArrived = new Promise<QueueSignal>((resolve) => {
		resolveSignal = resolve;
	});
	const state: DrainExecutionState = {
		observedSignal: null,
		active: null,
		interruptPromise: null,
		owner: null,
		signalArrived,
		resolveSignal,
	};
	const unsubscribe = ports.signals.subscribe((signal) => {
		if (state.observedSignal !== null) return;
		state.observedSignal = signal;
		state.resolveSignal(signal);
		if (state.active !== null)
			state.interruptPromise = Promise.resolve()
				.then(() => state.active?.interrupt(signal))
				.then(
					() => undefined,
					() => undefined,
				);
	});

	let result: QueueDrainResult;
	try {
		result = await runDrainBody(ports, state);
	} catch (cause) {
		result =
			state.observedSignal === null
				? errorResult(
						"controller/queue_drain_failed",
						cause instanceof Error ? cause.message : "Queue drain failed.",
						70,
					)
				: await finishWithSignal(state, state.observedSignal);
	}

	try {
		if (state.owner !== null) {
			let releaseError: string | null = null;
			try {
				const release = await releaseQueueLock(ports.storage, ports.identity);
				if (!release.ok) releaseError = release.error.message;
				else if (release.value !== "released")
					releaseError = "Queue lock is no longer owned by this process.";
			} catch (cause) {
				releaseError =
					cause instanceof Error ? cause.message : "Queue lock release failed.";
			}
			if (releaseError !== null && state.observedSignal === null)
				return errorResult(
					"environment/queue_lock_release_failed",
					releaseError,
					3,
					result.kind === "finished" ? result.state : undefined,
				);
		}
		if (state.observedSignal !== null)
			return await finishWithSignal(state, state.observedSignal);
		return result;
	} finally {
		unsubscribe();
	}
}

async function runDrainBody(
	ports: QueueDrainPorts,
	runtime: DrainExecutionState,
): Promise<QueueDrainResult> {
	try {
		if (runtime.observedSignal !== null)
			return await finishWithSignal(runtime, runtime.observedSignal);
		const acquired = await acquireQueueLock(ports.storage, ports.identity);
		if (!acquired.ok)
			return portFailure(
				"environment/queue_lock_unavailable",
				acquired.error.message,
			);
		if (acquired.value.kind === "already_running") {
			await ports.writeLine(
				`queue: already running (pid ${acquired.value.owner.pid})`,
			);
			return {
				kind: "already_running",
				pid: acquired.value.owner.pid,
				exitCode: 0,
			};
		}
		if (acquired.value.kind === "owner_unknown")
			return portFailure(
				"environment/queue_owner_unknown",
				`Queue owner ${acquired.value.owner.pid} could not be verified.`,
			);
		const owner = acquired.value.owner;
		runtime.owner = owner;
		if (ports.onOwnerAcquired !== undefined) await ports.onOwnerAcquired(owner);
		if (runtime.observedSignal !== null)
			return await finishWithSignal(runtime, runtime.observedSignal);

		const recovery = await ports.recover();
		if (!recovery.ok)
			return portFailure(
				"environment/queue_recovery_failed",
				recovery.error.message,
			);
		const firstSnapshot = await ports.status();
		if (!firstSnapshot.ok)
			return portFailure(
				"environment/queue_status_unavailable",
				firstSnapshot.error.message,
			);
		let state = initialQueueDrain(
			firstSnapshot.value.queue,
			firstSnapshot.value.landedSlugs,
		);
		const stoppedBeforeFirst = await queueStopRequested(ports.storage);
		if (!stoppedBeforeFirst.ok)
			return portFailure(
				"environment/queue_stop_unavailable",
				stoppedBeforeFirst.error.message,
			);
		if (stoppedBeforeFirst.value) {
			state = { ...state, line: "stopped_on_request" };
			await ports.writeLine(finalQueueLine(state));
			return { kind: "finished", state, exitCode: state.exitCode };
		}
		state = transitionQueue(state, { type: "start" });

		while (state.running && state.current !== null) {
			if (runtime.observedSignal !== null)
				return await finishWithSignal(runtime, runtime.observedSignal);
			const stopRequested = await queueStopRequested(ports.storage);
			if (!stopRequested.ok)
				return portFailure(
					"environment/queue_stop_unavailable",
					stopRequested.error.message,
				);
			if (stopRequested.value) state = stopAfterCurrent(state);
			if (state.line === "stopped_on_request") {
				await ports.writeLine(finalQueueLine(state));
				return { kind: "finished", state, exitCode: state.exitCode };
			}

			const current = state.current;
			if (current === null) break;
			const slug = current.slug;
			await ports.writeLine(`building ${slug}`);
			let build: QueueBuildResult = {
				outcome: "stopped_controller",
				runId: null,
				reason: "controller/build_result_missing",
			};
			try {
				runtime.active = await ports.startBuild(slug);
			} catch (cause) {
				build = {
					outcome: "stopped_controller",
					runId: null,
					reason:
						cause instanceof Error
							? `controller/build_start_failed: ${cause.message}`
							: "controller/build_start_failed",
				};
				runtime.active = null;
			}
			if (runtime.active !== null) {
				if (runtime.observedSignal !== null) {
					const signal = runtime.observedSignal;
					runtime.interruptPromise = Promise.resolve()
						.then(() => runtime.active?.interrupt(signal))
						.then(
							() => undefined,
							() => undefined,
						);
					return await finishWithSignal(runtime, signal);
				}
				const completion = runtime.active.completion.then((value) => ({
					kind: "build" as const,
					value,
				}));
				const signaled = runtime.signalArrived.then((signal) => ({
					kind: "signal" as const,
					signal,
				}));
				const settled = await Promise.race([completion, signaled]);
				if (settled.kind === "signal")
					return await finishWithSignal(runtime, settled.signal);
				build = settled.value;
				runtime.active = null;
				runtime.interruptPromise = null;
			}
			build = normalizeBuildResult(build);
			await ports.writeLine(formatQueueBuildLine(slug, build));

			// Refresh while the just-finished Intent is still `current`. The policy
			// then removes it and selects from this new snapshot after the outcome.
			const recovered = await ports.recover();
			if (!recovered.ok) {
				state = transitionQueue(state, {
					type: "outcome",
					outcome: build.outcome,
				});
				return errorResult(
					"environment/queue_recovery_failed",
					recovered.error.message,
					3,
					state,
				);
			}
			const snapshot = await ports.status();
			if (!snapshot.ok) {
				state = transitionQueue(state, {
					type: "outcome",
					outcome: build.outcome,
				});
				return errorResult(
					"environment/queue_status_unavailable",
					snapshot.error.message,
					3,
					state,
				);
			}
			state = transitionQueue(state, {
				type: "refresh",
				queue: snapshot.value.queue,
				landedSlugs: snapshot.value.landedSlugs,
			});
			state = transitionQueue(state, {
				type: "outcome",
				outcome: build.outcome,
			});
			if (runtime.observedSignal !== null)
				return await finishWithSignal(runtime, runtime.observedSignal);
			const stopAfterBuild = await queueStopRequested(ports.storage);
			if (!stopAfterBuild.ok)
				return errorResult(
					"environment/queue_stop_unavailable",
					stopAfterBuild.error.message,
					3,
					state,
				);
			if (state.line === "stopped_because") {
				await ports.writeLine(finalQueueLine(state));
				return { kind: "finished", state, exitCode: state.exitCode };
			}
			if (stopAfterBuild.value) state = stopAfterCurrent(state);
			if (!state.running && state.line === "stopped_on_request") {
				await ports.writeLine(finalQueueLine(state));
				return { kind: "finished", state, exitCode: state.exitCode };
			}
		}
		await ports.writeLine(finalQueueLine(state));
		return { kind: "finished", state, exitCode: state.exitCode };
	} catch (cause) {
		if (runtime.observedSignal !== null)
			return await finishWithSignal(runtime, runtime.observedSignal);
		return errorResult(
			"controller/queue_drain_failed",
			cause instanceof Error ? cause.message : "Queue drain failed.",
			70,
		);
	}
}
