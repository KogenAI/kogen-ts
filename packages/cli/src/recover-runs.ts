import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../../core/src/contracts/errors";
import { createPrivateGitRepository } from "../../core/src/git/repository";
import type { ResolvedProject } from "../../core/src/project/resolve";
import type { ProcessIdentityPort } from "../../core/src/queue/lock";
import {
	type RecoveryWorkspaceTarget,
	recoverDeadRun,
} from "../../core/src/recovery/recover";
import type { JournalEvent } from "../../core/src/run/journal";
import type { RunRecord, RunStatus } from "../../core/src/run/store";
import type { ControllerRuntime } from "./composition";
import { inspectOwnerPid, readStatusRuns } from "./status-runs";

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const workspaceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function failed(message: string): Result<void> {
	return { ok: false, error: { code: "io", message, retryable: true } };
}

function directory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function latestTerminal(events: readonly JournalEvent[]): {
	status: RunStatus;
	reason: string;
} | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.event !== "finished" && event?.event !== "reconciled") continue;
		if (
			(event.status === "landed" ||
				event.status === "failed" ||
				event.status === "parked" ||
				event.status === "stopped") &&
			typeof event.reason === "string"
		)
			return { status: event.status, reason: event.reason };
	}
	return null;
}

async function savedBase(
	record: RunRecord,
	events: readonly JournalEvent[],
	runtime: ControllerRuntime,
	origin: string,
): Promise<string | null> {
	const moved = events.findLast(
		(event) => event.event === "base_moved_at_start",
	);
	if (typeof moved?.tip === "string" && oid.test(moved.tip)) return moved.tip;
	const read = await runtime.git.command({
		repository: origin,
		argv: [
			"show",
			`${record.approval_commit}:.kogen/intents/${record.slug}/approval.json`,
		],
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 64 * 1024,
	});
	if (!read.ok || read.value.timedOut || read.value.exitCode !== 0) return null;
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(read.value.stdout),
		);
		if (
			value !== null &&
			typeof value === "object" &&
			"base_sha" in value &&
			typeof value.base_sha === "string" &&
			oid.test(value.base_sha)
		)
			return value.base_sha;
	} catch {}
	return null;
}

/** Reconcile dead Build records before status reads and before a new drain. */
export async function recoverPublicRuns(
	stateRoot: string,
	resolution: ResolvedProject,
	runtime: ControllerRuntime,
): Promise<Result<void>> {
	const runs = await readStatusRuns(stateRoot);
	const identity: ProcessIdentityPort = {
		current: () => ({ pid: process.pid, startedMs: 0 }),
		async inspect(pid) {
			return { ok: true, value: await inspectOwnerPid(pid) };
		},
	};
	for (const run of runs) {
		if (run.record.status !== "running" && !run.record.cleanup_pending)
			continue;
		if (run.ownerLiveness === "live") continue;
		if (run.ownerLiveness === "unknown" && run.record.status === "running")
			continue;
		const runDirectory = run.journalPath;
		const prefix = `${run.record.run_id}-`;
		const targets: RecoveryWorkspaceTarget[] = [];
		for (const name of readdirSync(stateRoot)) {
			if (!name.startsWith(prefix)) continue;
			const id = name.slice(prefix.length);
			if (!workspaceId.test(id))
				return failed(
					`Could not recover Build ${run.record.run_id}: workspace name is invalid.`,
				);
			const path = join(stateRoot, name);
			if (!directory(path))
				return failed(
					`Could not recover Build ${run.record.run_id}: workspace is not a directory.`,
				);
			const base = await savedBase(
				run.record,
				run.events,
				runtime,
				resolution.origin,
			);
			if (base === null)
				return failed(
					`Could not recover Build ${run.record.run_id}: saved base is unavailable.`,
				);
			const metadata = join(runDirectory, `recovery-private-${id}`);
			if (!existsSync(metadata)) mkdirSync(metadata, { mode: 0o700 });
			if (!directory(metadata))
				return failed(
					`Could not recover Build ${run.record.run_id}: private metadata is invalid.`,
				);
			const privateGit = await createPrivateGitRepository(runtime.process, {
				sourceRepository: resolution.origin,
				gitDirectory: metadata,
				workTree: path,
			});
			if (!privateGit.ok) return privateGit;
			targets.push({
				id,
				baseCommit: base,
				sourceRepository: resolution.origin,
				repository: privateGit.value,
				async present() {
					return { ok: true, value: directory(path) };
				},
				async remove() {
					if (!directory(path))
						return failed(`Workspace ${id} changed before cleanup.`);
					try {
						rmSync(path, { recursive: true });
						return { ok: true, value: undefined };
					} catch (cause) {
						return failed(String(cause));
					}
				},
			});
		}
		const result = await recoverDeadRun({
			record: run.record,
			runDirectory,
			origin: resolution.origin,
			latestEvent: run.events.at(-1) ?? null,
			recordedOutcome: latestTerminal(run.events),
			workspaces: targets,
			filesystem: runtime.filesystemHost,
			git: runtime.git,
			identity,
			async stopWriters() {
				return { ok: true, value: undefined };
			},
		});
		if (!result.ok) return result;
		if (
			result.value.kind === "deferred" ||
			result.value.kind === "cleanup_pending"
		)
			return failed(
				`Could not finish recovery of Build ${run.record.run_id}: ${result.value.kind}.`,
			);
	}
	return { ok: true, value: undefined };
}
