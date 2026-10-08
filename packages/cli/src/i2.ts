import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { Result } from "../../core/src/contracts/errors";
import { projectStateRootPath } from "../../core/src/project/resolve";
import type { ProcessIdentityPort } from "../../core/src/queue/lock";
import { deriveStatus } from "../../core/src/status/derive";
import type { ParsedCommand } from "./argv";
import { executePublicBuild } from "./build-composition";
import type { ControllerRuntime } from "./composition";
import { handleQueueCommand } from "./handlers/queue";
import { projectContext, statusInput } from "./i1";
import { type CliOutput, renderErrorLine } from "./output";
import { FileQueueLockStorage } from "./queue-storage";
import { inspectOwnerPid } from "./status-runs";

type QueueCommand = Extract<
	ParsedCommand,
	{ name: "queue start" | "queue stop" }
>;

export async function runI2QueueCommand(
	command: QueueCommand,
	runtime: ControllerRuntime,
): Promise<CliOutput> {
	const context = await projectContext(command, runtime);
	if ("exitCode" in context) return context;
	const observation = await inspectOwnerPid(process.pid);
	if (observation.kind !== "alive")
		return renderErrorLine(
			"environment/queue_owner_unknown: Could not verify this process start identity.",
			3,
		);
	const owner = { pid: process.pid, startedMs: observation.startedMs };
	const identity: ProcessIdentityPort = {
		current: () => owner,
		async inspect(pid) {
			return { ok: true, value: await inspectOwnerPid(pid) };
		},
	};
	const stateRoot = projectStateRootPath(
		process.env.HOME ?? homedir(),
		context.resolution.checkout,
	);
	const storage = new FileQueueLockStorage(stateRoot);
	return handleQueueCommand(command, {
		storage,
		identity,
		stateRoot,
		detachInvocation: {
			executable: process.execPath,
			prefixArgs: [],
			cwd: process.cwd(),
		},
		async recover(): Promise<Result<void>> {
			// Preservation and dead-owner replay enter at I3 after package 59.
			return { ok: true, value: undefined };
		},
		async status() {
			const input = await statusInput(runtime, context.resolution);
			const derived = deriveStatus(input);
			const landedSlugs = new Set(
				input.reachableLandings.map((landing) => landing.slug),
			);
			return {
				ok: true as const,
				value: {
					queue: derived.intents.map((intent) => ({
						slug: intent.slug,
						approved: intent.approval !== null,
						landed: intent.status === "landed",
						priority: intent.priority,
						approvedAt: intent.approval?.approvedAt ?? 0,
						blocksOn: intent.blocksOn,
					})),
					landedSlugs,
				},
			};
		},
		async startBuild(slug) {
			const runId = randomBytes(16).toString("hex");
			const controller = new AbortController();
			const completion = executePublicBuild({
				slug,
				runId,
				stateRoot,
				resolution: context.resolution,
				config: context.config,
				runtime,
				owner,
				signal: controller.signal,
			}).then((result) => {
				const landing = result.record?.landing;
				const outcome =
					result.outcome === "stopped"
						? result.exitCode === 4
							? ("stopped_provider" as const)
							: result.exitCode === 70
								? ("stopped_controller" as const)
								: ("stopped_environment" as const)
						: result.outcome;
				return {
					outcome,
					runId: result.runId,
					...(result.reason === null ? {} : { reason: result.reason }),
					...(landing === null || landing === undefined
						? {}
						: { commit: landing.candidate_commit }),
				};
			});
			return {
				completion,
				async interrupt(signal) {
					controller.abort(signal);
					await completion;
				},
			};
		},
	});
}
