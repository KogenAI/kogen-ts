import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	fchmodSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PortError, Result } from "../../../core/src/contracts/errors";
import {
	drainQueue,
	type QueueDrainPorts,
	type QueueSignalSource,
} from "../../../core/src/queue/drain";
import {
	type QueueLockStorage,
	type QueueOwnerIdentity,
	requestQueueStop,
} from "../../../core/src/queue/lock";
import type { ParsedCommand } from "../argv";
import { type CliOutput, renderErrorLine } from "../output";
import {
	hasQueueStartupHandshake,
	installProcessSignalCustody,
	type SignalEventTarget,
	sendQueueStartupHandshake,
} from "./signals";

const DETACH_UNAVAILABLE =
	"environment/detach_unavailable: --detach needs an installed kogen; run kogen queue start in the background instead";
const DETACH_HANDSHAKE_TIMEOUT_MS = 10_000;
const DETACHED_LOG = "queue.log";

export interface QueueDetachedInvocation {
	/** Installed executable or pinned runtime used to run the public CLI. */
	readonly executable: string;
	/** Runtime/script prefix, empty for a compiled standalone executable. */
	readonly prefixArgs: readonly string[];
	readonly cwd: string;
	readonly environment?: Readonly<Record<string, string>>;
}

export interface DetachedQueueSpawnRequest {
	readonly invocation: QueueDetachedInvocation;
	readonly args: readonly string[];
	readonly logPath: string;
}

export interface DetachedQueueChild {
	readonly pid: number;
	/** Resolves only after the child owns queue.pid and writes `ready:<pid>`. */
	readonly ready: Promise<string>;
	closeHandshake(): void;
	terminate(): Promise<void>;
}

export type DetachedQueueSpawn = (
	request: DetachedQueueSpawnRequest,
) => DetachedQueueChild | Promise<DetachedQueueChild>;

export interface DetachedQueueStarted {
	readonly pid: number;
	readonly logPath: string;
}

export interface QueueCommandPorts
	extends Omit<QueueDrainPorts, "signals" | "writeLine" | "onOwnerAcquired"> {
	readonly stateRoot: string;
	readonly signals?: QueueSignalSource;
	readonly signalTarget?: SignalEventTarget;
	readonly writeLine?: (line: string) => void | Promise<void>;
	readonly onOwnerAcquired?: (owner: QueueOwnerIdentity) => Promise<void>;
	readonly detachInvocation?: QueueDetachedInvocation;
	readonly detachedSpawn?: DetachedQueueSpawn;
}

function cliLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

function queueStartArgs(
	command: Extract<ParsedCommand, { name: "queue start" }>,
) {
	const args = ["queue", "start"];
	args.push("--project", command.project);
	if (command.origin !== undefined) args.push("--origin", command.origin);
	if (command.base !== undefined) args.push("--base", command.base);
	return args;
}

function queueLogPath(stateRoot: string): string {
	return join(stateRoot, DETACHED_LOG);
}

function portError(message: string): Result<DetachedQueueStarted> {
	const error: PortError = { code: "unavailable", message, retryable: false };
	return { ok: false, error };
}

function ensurePrivateLog(stateRoot: string): {
	readonly fd: number;
	readonly logPath: string;
} {
	if (!isAbsolute(stateRoot))
		throw new TypeError(
			"Queue state root must be an absolute private directory.",
		);
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const rootInfo = lstatSync(stateRoot);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
		throw new TypeError("Queue state root is not a real directory.");
	const canonicalRoot = realpathSync(stateRoot);
	chmodSync(canonicalRoot, 0o700);
	if (fsConstants.O_NOFOLLOW === undefined)
		throw new Error("No-follow log creation is unavailable on this host.");
	const logPath = queueLogPath(canonicalRoot);
	const fd = openSync(
		logPath,
		fsConstants.O_CREAT |
			fsConstants.O_APPEND |
			fsConstants.O_WRONLY |
			fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!lstatSync(logPath).isFile())
			throw new TypeError("Queue log is not a regular file.");
		fchmodSync(fd, 0o600);
		return { fd, logPath };
	} catch (cause) {
		closeSync(fd);
		throw cause;
	}
}

function signalDetachedGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// The group may already have exited during startup failure.
	}
}

async function stopDetachedGroup(pid: number): Promise<void> {
	signalDetachedGroup(pid, "SIGTERM");
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
	signalDetachedGroup(pid, "SIGKILL");
}

function makeReadyPromise(
	child: ChildProcess,
	expectedPid: number,
): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		let bytes = new Uint8Array();
		const pipe = child.stdio[3];
		const finish = (failure?: Error, value?: string) => {
			if (settled) return;
			settled = true;
			pipe?.removeListener("data", onData);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			if (failure !== undefined) rejectPromise(failure);
			else resolvePromise(value ?? "");
		};
		const onData = (chunk: Buffer | string) => {
			const incoming =
				typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
			if (bytes.byteLength + incoming.byteLength > 128) {
				finish(new Error("Detached queue handshake exceeded its bound."));
				return;
			}
			const joined = new Uint8Array(bytes.byteLength + incoming.byteLength);
			joined.set(bytes);
			joined.set(incoming, bytes.byteLength);
			bytes = joined;
			const newline = bytes.indexOf(0x0a);
			if (newline < 0) return;
			if (newline !== bytes.byteLength - 1) {
				finish(new Error("Detached queue handshake had trailing bytes."));
				return;
			}
			let message: string;
			try {
				message = new TextDecoder("utf-8", { fatal: true }).decode(
					bytes.subarray(0, newline),
				);
			} catch {
				finish(new Error("Detached queue handshake was not UTF-8."));
				return;
			}
			if (message !== `ready:${expectedPid}`) {
				finish(
					new Error("Detached queue handshake did not identify its owner."),
				);
				return;
			}
			finish(undefined, message);
		};
		const onError = (cause: Error) => finish(cause);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(
				new Error(
					`Detached queue exited before ownership handshake (${String(code ?? signal)}).`,
				),
			);
		pipe?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

/** Spawn a new-session queue owner and reject success until it owns the lock. */
export function spawnDetachedQueue(stateRoot: string): DetachedQueueSpawn {
	return (request) => {
		const log = ensurePrivateLog(stateRoot);
		let child: ChildProcess;
		try {
			child = spawn(
				request.invocation.executable,
				[...request.invocation.prefixArgs, ...request.args],
				{
					cwd: request.invocation.cwd,
					env: {
						...process.env,
						...request.invocation.environment,
						KOGEN_QUEUE_HANDSHAKE_FD: "3",
					},
					detached: true,
					stdio: ["ignore", log.fd, log.fd, "pipe"],
				},
			);
		} finally {
			closeSync(log.fd);
		}
		const pid = child.pid;
		if (pid === undefined)
			throw new Error("Detached queue process did not receive a PID.");
		const ready = makeReadyPromise(child, pid);
		child.unref();
		return {
			pid,
			ready,
			closeHandshake() {
				child.stdio[3]?.destroy();
			},
			async terminate() {
				child.stdio[3]?.destroy();
				await stopDetachedGroup(pid);
			},
		};
	};
}

async function withTimeout<Value>(
	promise: Promise<Value>,
	milliseconds: number,
): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolvePromise, rejectPromise) => {
				timer = setTimeout(
					() =>
						rejectPromise(new Error("Detached startup handshake timed out.")),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function launchDetachedQueue(request: {
	readonly command: Extract<ParsedCommand, { name: "queue start" }>;
	readonly stateRoot: string;
	readonly invocation: QueueDetachedInvocation;
	readonly spawn?: DetachedQueueSpawn;
}): Promise<Result<DetachedQueueStarted>> {
	let logPath = queueLogPath(request.stateRoot);
	let child: DetachedQueueChild | null = null;
	try {
		const rootInfo = lstatSync(request.stateRoot);
		if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
			throw new TypeError("Queue state root is not a real directory.");
		logPath = queueLogPath(realpathSync(request.stateRoot));
		child = await (request.spawn ?? spawnDetachedQueue(request.stateRoot))({
			invocation: request.invocation,
			args: queueStartArgs(request.command),
			logPath,
		});
		const message = await withTimeout(child.ready, DETACH_HANDSHAKE_TIMEOUT_MS);
		if (message !== `ready:${child.pid}`)
			throw new Error("Detached queue startup handshake is invalid.");
		child.closeHandshake();
		return { ok: true, value: { pid: child.pid, logPath } };
	} catch (cause) {
		if (child !== null) await child.terminate().catch(() => undefined);
		return portError(
			cause instanceof Error ? cause.message : "Detached queue launch failed.",
		);
	}
}

function detachUnavailable(): CliOutput {
	return renderErrorLine(DETACH_UNAVAILABLE, 3);
}

async function runStart(
	command: Extract<ParsedCommand, { name: "queue start" }>,
	ports: QueueCommandPorts,
): Promise<CliOutput> {
	if (command.detach) {
		if (ports.detachInvocation === undefined) return detachUnavailable();
		const launched = await launchDetachedQueue({
			command,
			stateRoot: ports.stateRoot,
			invocation: ports.detachInvocation,
			...(ports.detachedSpawn === undefined
				? {}
				: { spawn: ports.detachedSpawn }),
		});
		if (!launched.ok) return detachUnavailable();
		return {
			stdout: `queue: started in the background (pid ${launched.value.pid})\nlog: ${launched.value.logPath}\n`,
			stderr: "",
			exitCode: 0,
		};
	}

	const custody =
		ports.signals === undefined
			? installProcessSignalCustody(ports.signalTarget)
			: null;
	const onOwnerAcquired =
		ports.onOwnerAcquired ??
		(hasQueueStartupHandshake()
			? async () => {
					sendQueueStartupHandshake();
				}
			: undefined);
	try {
		const result = await drainQueue({
			...ports,
			signals: ports.signals ?? (custody as NonNullable<typeof custody>).source,
			writeLine: ports.writeLine ?? cliLine,
			...(onOwnerAcquired === undefined ? {} : { onOwnerAcquired }),
		});
		if (result.kind === "error")
			return renderErrorLine(
				`${result.code}: ${result.message}`,
				result.exitCode,
			);
		return { stdout: "", stderr: "", exitCode: result.exitCode };
	} catch (cause) {
		return renderErrorLine(
			`controller/queue_drain_failed: ${cause instanceof Error ? cause.message : "Queue drain failed."}`,
			70,
		);
	} finally {
		custody?.dispose();
	}
}

async function runStop(
	_command: Extract<ParsedCommand, { name: "queue stop" }>,
	ports: Pick<QueueCommandPorts, "storage" | "identity">,
): Promise<CliOutput> {
	let result: Awaited<ReturnType<typeof requestQueueStop>>;
	try {
		result = await requestQueueStop(ports.storage, ports.identity);
	} catch (cause) {
		return renderErrorLine(
			`environment/queue_stop_unavailable: ${cause instanceof Error ? cause.message : "Could not request queue stop."}`,
			3,
		);
	}
	if (!result.ok)
		return renderErrorLine(
			`environment/queue_stop_unavailable: ${result.error.message}`,
			3,
		);
	switch (result.value.kind) {
		case "stopping":
			return renderErrorLine(
				`queue: stopping after the current Build (pid ${result.value.pid})`,
				0,
			);
		case "not_running":
			return renderErrorLine("queue: not running", 0);
		case "owner_unknown":
			return renderErrorLine(
				`environment/queue_owner_unknown: Queue owner ${result.value.owner.pid} could not be verified.`,
				3,
			);
		default: {
			const exhaustive: never = result.value;
			return exhaustive;
		}
	}
}

/** Public handler entry used by the I2 composition. */
export async function handleQueueCommand(
	command: Extract<ParsedCommand, { name: "queue start" | "queue stop" }>,
	ports: QueueCommandPorts,
): Promise<CliOutput> {
	return command.name === "queue start"
		? runStart(command, ports)
		: runStop(command, ports);
}

/** Descriptive aliases for coordinator compositions that prefer command names. */
export const handleQueueStart = runStart;
export const handleQueueStop = runStop;

/** Keep QueueLockStorage in this module's public type surface for composition. */
export type { QueueLockStorage };
