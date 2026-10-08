import type { ClockPort } from "../contracts/clock";
import type { Result } from "../contracts/errors";
import type { GitPort } from "../contracts/ports";
import type { FileSystemHostRequest } from "../fs/read";
import {
	MODEL_ROLES,
	type ModelProvider,
	type ModelRole,
	type ResolvedRole,
	type RoleResolution,
	resolveRoles,
} from "../project/roles";
import type { MachineConfig, ProjectConfig } from "../project/schema";
import {
	acquireBuildClaim,
	type BuildClaimAcquisition,
	type ClaimOwnerInspector,
	releaseBuildClaim,
} from "../queue/claim";
import type { ProcessIdentityPort, QueueOwnerIdentity } from "../queue/lock";
import type { JournalEvent, JsonValue } from "../run/journal";
import {
	appendRunEventBeforeSnapshot,
	createJournalEvent,
	type RunEventPersistence,
	type RunRecord,
	writeRunSnapshot,
} from "../run/store";
import {
	type BuildApprovalLoadFailure,
	type LoadedBuildApproval,
	loadBuildApproval,
} from "./load";
import {
	type BuildPlan,
	createBuildPlan,
	type PlannerCompletionPort,
} from "./planner";

export interface BuildEffectFailure {
	readonly code: string;
	readonly message: string;
	readonly exitCode: 3 | 4 | 70;
}

export interface BuildBaseSnapshot {
	readonly commit: string;
	readonly tree: string;
	readonly trackedPaths: readonly string[];
}

export interface BuildBasePort {
	resolve(request: {
		readonly origin: string;
		readonly branch: string;
		readonly approval: LoadedBuildApproval;
	}): Promise<Result<BuildBaseSnapshot, BuildEffectFailure>>;
	checkMovedBase(request: {
		readonly base: BuildBaseSnapshot;
		readonly approval: LoadedBuildApproval;
	}): Promise<Result<void, BuildEffectFailure>>;
}

export interface BuildRunDirectoryPort {
	readonly host: FileSystemHostRequest;
	create(runId: string): Promise<Result<string, BuildEffectFailure>>;
}

export interface BuildSandboxPort {
	probe(
		runDirectory: string,
	): Promise<Result<"available" | "unavailable", BuildEffectFailure>>;
}

export interface RungWorkspace {
	readonly id: string;
	readonly root: string;
}

export interface BaseAcceptanceItem {
	readonly id: string;
	readonly kind: "test" | "test keep";
	readonly status: "passed" | "failed";
	readonly output: readonly string[];
}

export interface BaseAcceptanceObservation {
	readonly items: readonly BaseAcceptanceItem[];
}

export interface BuildCandidate {
	readonly rung: string;
	readonly workspace: RungWorkspace;
	readonly verifiedTree: string;
	readonly verdict: "green" | "red";
}

export interface RungOutcome {
	readonly kind: "green" | "red" | "stopped";
	readonly reason: string;
	readonly candidate: BuildCandidate | null;
	readonly failure?: BuildEffectFailure;
}

export interface BuildRungPort {
	createWorkspace(request: {
		readonly runId: string;
		readonly rung: "R1";
		readonly base: BuildBaseSnapshot;
		readonly approval: LoadedBuildApproval;
	}): Promise<Result<RungWorkspace, BuildEffectFailure>>;
	setup(workspace: RungWorkspace): Promise<Result<void, BuildEffectFailure>>;
	baseAcceptance(request: {
		readonly workspace: RungWorkspace;
		readonly approval: LoadedBuildApproval;
	}): Promise<
		Result<
			BaseAcceptanceObservation | { readonly kind: "unavailable" },
			BuildEffectFailure
		>
	>;
	run(request: {
		readonly workspace: RungWorkspace;
		readonly runId: string;
		readonly approval: LoadedBuildApproval;
		readonly base: BuildBaseSnapshot;
		readonly plan: BuildPlan;
		readonly roles: RoleResolution;
		readonly emit: (
			event: string,
			fields?: Readonly<Record<string, JsonValue>>,
		) => Promise<void>;
	}): Promise<Result<RungOutcome, BuildEffectFailure>>;
	parkCandidate(request: {
		readonly runId: string;
		readonly candidate: BuildCandidate;
	}): Promise<Result<void, BuildEffectFailure>>;
	cleanup(request: {
		readonly runId: string;
		readonly workspaces: readonly RungWorkspace[];
	}): Promise<Result<void, BuildEffectFailure>>;
}

export interface PreparedLanding {
	readonly candidateCommit: string;
	readonly record: RunRecord["landing"] & {};
}

export interface BuildLandingPort {
	prepare(request: {
		readonly runId: string;
		readonly approval: LoadedBuildApproval;
		readonly base: BuildBaseSnapshot;
		readonly candidate: BuildCandidate;
	}): Promise<Result<PreparedLanding, BuildEffectFailure>>;
	publish(
		prepared: PreparedLanding,
	): Promise<Result<"landed" | "parked", BuildEffectFailure>>;
}

export interface BuildControllerRequest {
	readonly git: Pick<GitPort, "command">;
	readonly origin: string;
	readonly slug: string;
	readonly targetBranch: string;
	readonly runId: string;
	readonly owner: QueueOwnerIdentity;
	readonly identity: ProcessIdentityPort;
	readonly inspectClaimOwner: ClaimOwnerInspector;
	readonly provider: ModelProvider;
	readonly project: ProjectConfig;
	readonly machine: MachineConfig;
	readonly runDirectory: BuildRunDirectoryPort;
	readonly sandbox: BuildSandboxPort;
	readonly base: BuildBasePort;
	readonly planner: PlannerCompletionPort;
	readonly rung: BuildRungPort;
	readonly landing: BuildLandingPort;
	readonly clock: Pick<ClockPort, "unixMilliseconds">;
}

export type BuildOutcome =
	| "landed"
	| "failed"
	| "parked"
	| "stopped"
	| "skipped";

export interface BuildControllerResult {
	readonly outcome: BuildOutcome;
	readonly runId: string | null;
	readonly exitCode: 0 | 1 | 3 | 4 | 70;
	readonly reason: string | null;
	readonly record: RunRecord | null;
}

export type RunEventAppender = (
	current: RunRecord,
	event: JournalEvent,
) => Promise<RunEventPersistence>;

/** Serialize every append+snapshot pair for one run and keep its latest record. */
export function createSerializedRunStateWriter(
	initial: RunRecord,
	append: RunEventAppender,
) {
	let current = initial;
	let tail: Promise<void> = Promise.resolve();
	let failure: RunEventPersistence | null = null;
	return {
		current(): RunRecord {
			return current;
		},
		append(event: JournalEvent): Promise<RunEventPersistence> {
			const operation = tail.then(async () => {
				if (failure !== null) return failure;
				const result = await append(current, event);
				if (result.ok) current = result.value.record;
				else failure = result;
				return result;
			});
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
		async idle(): Promise<void> {
			await tail;
		},
	};
}

export function createBuildRunStateWriter(
	host: FileSystemHostRequest,
	runDirectory: string,
	initial: RunRecord,
) {
	return createSerializedRunStateWriter(initial, (current, event) =>
		appendRunEventBeforeSnapshot(host, runDirectory, current, event),
	);
}

function roleSummary(roles: RoleResolution): JsonValue {
	return Object.fromEntries(
		MODEL_ROLES.map((name) => [
			name,
			{
				model: roles.roles[name].requested.model,
				effort: roles.roles[name].requested.effort,
			},
		]),
	) as JsonValue;
}

function effectiveRoleSummary(roles: RoleResolution): JsonValue {
	return Object.fromEntries(
		MODEL_ROLES.map((name) => [
			name,
			{
				provider: roles.roles[name].effective.provider,
				model: roles.roles[name].effective.model,
				effort: roles.roles[name].effective.effort,
			},
		]),
	) as JsonValue;
}

function event(
	clock: Pick<ClockPort, "unixMilliseconds">,
	name: string,
	fields: Readonly<Record<string, JsonValue>> = {},
): JournalEvent {
	return createJournalEvent(name, fields, () => clock.unixMilliseconds());
}

function portFailure(
	code: string,
	message: string,
	exitCode: 3 | 4 | 70 = 3,
): BuildEffectFailure {
	return { code, message, exitCode };
}

function buildResult(
	outcome: BuildOutcome,
	runId: string | null,
	exitCode: BuildControllerResult["exitCode"],
	reason: string | null,
	record: RunRecord | null,
): BuildControllerResult {
	return { outcome, runId, exitCode, reason, record };
}

async function persistEvent(
	writer: ReturnType<typeof createBuildRunStateWriter>,
	clock: Pick<ClockPort, "unixMilliseconds">,
	name: string,
	fields: Readonly<Record<string, JsonValue>> = {},
): Promise<void> {
	const result = await writer.append(event(clock, name, fields));
	if (!result.ok)
		throw new Error(`Could not persist ${name}: ${result.error.error.message}`);
}

function roleFor(resolution: RoleResolution, name: ModelRole): ResolvedRole {
	return resolution.roles[name];
}

function mapLoadFailure(
	failure: BuildApprovalLoadFailure,
): BuildControllerResult {
	return buildResult(
		"stopped",
		null,
		failure.code === "controller/approval_invalid" ? 70 : 3,
		failure.code,
		null,
	);
}

class BuildStopped extends Error {
	constructor(readonly failure: BuildEffectFailure) {
		super(failure.message);
		this.name = "BuildStopped";
	}
}

function claimReason(result: BuildClaimAcquisition): string {
	return result.kind === "held" ? "environment/build_already_claimed" : "";
}

/** Execute B0–B10 with production approval/claim/run persistence and injected rungs/landing. */
export async function runBuild(
	request: BuildControllerRequest,
): Promise<BuildControllerResult> {
	const loaded = await loadBuildApproval({
		git: request.git,
		origin: request.origin,
		slug: request.slug,
	});
	if (!loaded.ok) return mapLoadFailure(loaded.error);
	const approval = loaded.value;
	if (approval.targetBranch !== request.targetBranch)
		return buildResult(
			"skipped",
			null,
			0,
			"environment/approval_branch_mismatch",
			null,
		);
	if (!/^[a-f0-9]{32}$/u.test(request.runId))
		return buildResult("stopped", null, 3, "environment/run_id_invalid", null);
	const rolesResult = resolveRoles({
		provider: request.provider,
		project: request.project.build.roles,
		...(request.machine.build.roles === undefined
			? {}
			: { machine: request.machine.build.roles }),
		modelFallback: request.project.build.modelFallback,
	});
	if (!rolesResult.ok)
		return buildResult("stopped", null, 3, "project/roles_invalid", null);
	const roles = rolesResult.value;
	const acquired = await acquireBuildClaim(
		request.git,
		request.origin,
		request.runId,
		request.owner,
		request.inspectClaimOwner,
	);
	if (!acquired.ok)
		return buildResult(
			"stopped",
			null,
			3,
			"environment/build_claim_failed",
			null,
		);
	if (acquired.value.kind === "held")
		return buildResult("stopped", null, 3, claimReason(acquired.value), null);
	const claim = acquired.value.claim;
	let runDirectory = "";
	let writer: ReturnType<typeof createBuildRunStateWriter> | null = null;
	let runRecord: RunRecord | null = null;
	let terminal: BuildOutcome = "stopped";
	let reason: string | null = "environment/build_failed";
	let exitCode: BuildControllerResult["exitCode"] = 3;
	const workspaces: RungWorkspace[] = [];
	let bestCandidate: BuildCandidate | null = null;
	let landedRung: string | null = null;
	try {
		const runPath = await request.runDirectory.create(request.runId);
		if (!runPath.ok) throw new Error(runPath.error.message);
		runDirectory = runPath.value;
		const startedMs = request.clock.unixMilliseconds();
		if (!Number.isSafeInteger(startedMs) || startedMs < 0)
			throw new Error("Build clock returned an invalid timestamp.");
		runRecord = {
			schema: 2,
			run_id: request.runId,
			slug: request.slug,
			approval_sha256: approval.approvalSha256,
			approval_commit: approval.approvalCommit,
			target_branch: approval.targetBranch,
			status: "running",
			landing: null,
			owner_pid: request.owner.pid,
			owner_started_ms: request.owner.startedMs,
			started_ms: startedMs,
			recovery: [],
			cleanup_pending: false,
		};
		const written = await writeRunSnapshot(
			request.runDirectory.host,
			runDirectory,
			runRecord,
		);
		if (!written.ok)
			throw new Error(
				`Could not create run.json: ${written.error.error.message}`,
			);
		writer = createBuildRunStateWriter(
			request.runDirectory.host,
			runDirectory,
			runRecord,
		);
		await persistEvent(writer, request.clock, "started", {
			run_id: request.runId,
			slug: request.slug,
			approval_sha256: approval.approvalSha256,
			approval_commit: approval.approvalCommit,
			target_branch: approval.targetBranch,
			roles: roleSummary(roles),
			effective_roles: effectiveRoleSummary(roles),
		});
		const sandbox = await request.sandbox.probe(runDirectory);
		if (!sandbox.ok) throw new Error(sandbox.error.message);
		if (sandbox.value === "unavailable")
			await persistEvent(writer, request.clock, "sandbox_unavailable", {});

		const baseResult = await request.base.resolve({
			origin: request.origin,
			branch: request.targetBranch,
			approval,
		});
		if (!baseResult.ok) throw new BuildStopped(baseResult.error);
		const base = baseResult.value;
		if (base.commit !== approval.baseSha) {
			await persistEvent(writer, request.clock, "base_moved_at_start", {
				approved: approval.baseSha,
				tip: base.commit,
			});
			const checked = await request.base.checkMovedBase({ base, approval });
			if (!checked.ok) throw new BuildStopped(checked.error);
		}

		const plannerRole = roleFor(roles, "planner");
		await persistEvent(writer, request.clock, "model_stage", {
			stage: "plan",
			provider: plannerRole.effective.provider,
			model: plannerRole.effective.model,
			effort: plannerRole.effective.effort,
		});
		const planResult = await createBuildPlan({
			intentBytes: approval.intentBytes,
			trackedPaths: base.trackedPaths,
			role: plannerRole,
			maxWords: request.project.build.planMaxWords,
			completion: request.planner,
		});
		if (!planResult.ok) {
			if (planResult.error.exitCode === 4 || planResult.error.exitCode === 3)
				throw new BuildStopped({
					code: planResult.error.code,
					message: planResult.error.message,
					exitCode: planResult.error.exitCode,
				});
			terminal = "failed";
			reason = planResult.error.code;
			exitCode = 1;
		} else {
			const plan = planResult.value;
			await persistEvent(writer, request.clock, "plan", {
				difficulty: plan.difficulty,
				words: plan.wordCount,
				provider: plannerRole.effective.provider,
				model: plannerRole.effective.model,
				effort: plannerRole.effective.effort,
			});
			await persistEvent(writer, request.clock, "rung_started", {
				rung: "R1",
				name: "builder",
			});
			const workspaceResult = await request.rung.createWorkspace({
				runId: request.runId,
				rung: "R1",
				base,
				approval,
			});
			if (!workspaceResult.ok) throw new BuildStopped(workspaceResult.error);
			const workspace = workspaceResult.value;
			workspaces.push(workspace);
			let setup = await request.rung.setup(workspace);
			if (!setup.ok) setup = await request.rung.setup(workspace);
			if (!setup.ok)
				throw new BuildStopped({
					code: "environment/setup_failed",
					message: setup.error.message,
					exitCode: 3,
				});
			const baseAcceptance = await request.rung.baseAcceptance({
				workspace,
				approval,
			});
			if (!baseAcceptance.ok) throw new BuildStopped(baseAcceptance.error);
			if (
				"kind" in baseAcceptance.value &&
				baseAcceptance.value.kind === "unavailable"
			)
				throw new BuildStopped({
					code: "environment/tool_missing",
					message: "The acceptance runner is unavailable on the build base.",
					exitCode: 3,
				});
			const acceptance = baseAcceptance.value as BaseAcceptanceObservation;
			await persistEvent(writer, request.clock, "base_acceptance", {
				items: acceptance.items.map((item) => ({
					id: item.id,
					kind: item.kind,
					base_status: item.status,
					output: [...item.output],
				})),
			});
			const rungResult = await request.rung.run({
				workspace,
				runId: request.runId,
				approval,
				base,
				plan,
				roles,
				emit: async (name, fields = {}) =>
					persistEvent(
						writer as NonNullable<typeof writer>,
						request.clock,
						name,
						fields,
					),
			});
			if (!rungResult.ok) throw new BuildStopped(rungResult.error);
			const rung = rungResult.value;
			bestCandidate = rung.candidate;
			if (rung.kind !== "stopped")
				await persistEvent(writer, request.clock, "verification", {
					rung: "R1",
					result: rung.kind,
					...(rung.candidate === null
						? {}
						: { tree: rung.candidate.verifiedTree }),
				});
			await persistEvent(writer, request.clock, "rung_finished", {
				rung: "R1",
				reason: rung.reason,
				verdict: rung.kind === "stopped" ? "stopped" : rung.kind,
			});
			if (rung.kind === "stopped")
				throw new BuildStopped(
					rung.failure ?? portFailure(rung.reason, rung.reason, 4),
				);
			if (rung.kind === "red") {
				await persistEvent(writer, request.clock, "selection", {
					selected: bestCandidate?.rung ?? null,
					verdict: "red",
				});
				terminal = "failed";
				reason = rung.reason;
				exitCode = 1;
			} else if (bestCandidate === null) {
				throw new BuildStopped(
					portFailure(
						"controller/rung_candidate_missing",
						"Green rung did not return a candidate.",
					),
				);
			} else {
				landedRung = bestCandidate.rung;
				const prepared = await request.landing.prepare({
					runId: request.runId,
					approval,
					base,
					candidate: bestCandidate,
				});
				if (!prepared.ok) {
					terminal = "parked";
					reason = prepared.error.code;
					exitCode = 1;
				} else {
					const landing = prepared.value;
					await persistEvent(writer, request.clock, "commit_result", {
						rung: bestCandidate.rung,
						candidate_commit: landing.candidateCommit,
						tree: landing.record.final_tree,
					});
					await persistEvent(writer, request.clock, "landing_prepared", {
						landing: landing.record as unknown as JsonValue,
					});
					const published = await request.landing.publish(landing);
					if (!published.ok) {
						terminal = "parked";
						reason = published.error.code;
						exitCode = 1;
					} else {
						terminal = published.value;
						reason = null;
						exitCode = terminal === "landed" ? 0 : 1;
					}
				}
			}
		}
	} catch (cause) {
		if (cause instanceof BuildStopped) {
			terminal = "stopped";
			reason = cause.failure.code;
			exitCode = cause.failure.exitCode;
		} else {
			terminal = "stopped";
			reason = "environment/build_failed";
			exitCode = 3;
		}
	}

	if (writer !== null && runRecord !== null) {
		try {
			if (terminal === "parked" && bestCandidate !== null) {
				const parked = await request.rung.parkCandidate({
					runId: request.runId,
					candidate: bestCandidate,
				});
				if (!parked.ok) {
					await persistEvent(writer, request.clock, "cleanup_failure", {
						message: parked.error.message,
					});
				}
			}
			const cleaned = await request.rung.cleanup({
				runId: request.runId,
				workspaces,
			});
			if (!cleaned.ok)
				await persistEvent(writer, request.clock, "cleanup_failure", {
					message: cleaned.error.message,
				});
			await persistEvent(writer, request.clock, "finished", {
				status: terminal,
				...(reason === null ? {} : { reason }),
				...(landedRung === null ? {} : { rung: landedRung }),
				verdict: terminal === "landed" ? "green" : terminal,
			});
		} catch {
			reason = reason ?? "environment/run_persist_failed";
			exitCode = 3;
		}
		runRecord = writer.current();
	}
	const released = await releaseBuildClaim(
		request.git,
		request.origin,
		claim,
		request.identity,
	);
	if (!released.ok) {
		reason = "environment/build_claim_release_failed";
		exitCode = 3;
	}
	return buildResult(
		terminal,
		runRecord === null ? null : request.runId,
		exitCode,
		reason,
		runRecord,
	);
}
