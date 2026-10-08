import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCommandAdapter } from "../../core/src/adapters/command";
import type { AcceptanceAdapter } from "../../core/src/adapters/interface";
import { observeBuildAudit } from "../../core/src/build/audit";
import { BuildBudget } from "../../core/src/build/budget";
import {
	type BuildControllerResult,
	type BuildEffectFailure,
	type BuildRungPort,
	runBuild,
} from "../../core/src/build/controller";
import {
	BUILD_GENERIC_INSTRUCTIONS,
	createBuilderSession,
} from "../../core/src/build/develop";
import {
	createLandingCommit,
	type LandingCommit,
} from "../../core/src/build/landing/commit";
import {
	applyLandingCheckoutSync,
	planLandingCheckoutSync,
} from "../../core/src/build/landing/sync";
import type { LoadedBuildApproval } from "../../core/src/build/load";
import { runRungMachine } from "../../core/src/build/rung";
import type { ClockPort } from "../../core/src/contracts/clock";
import type { Result } from "../../core/src/contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	RandomPort,
} from "../../core/src/contracts/ports";
import {
	type GateTreePort,
	type GateTreeSnapshot,
	runGateCommand,
} from "../../core/src/gate/checks";
import { formatGateFeedback } from "../../core/src/gate/feedback";
import { runAcceptanceLedger } from "../../core/src/gate/ledger";
import {
	buildProtectedManifest,
	type ProtectedManifest,
} from "../../core/src/gate/manifest";
import { restoreProtectedPaths } from "../../core/src/gate/protect";
import { type GateCheckBaseline, verifyGate } from "../../core/src/gate/verify";
import { GIT_MAX_OUTPUT_LIMIT_BYTES } from "../../core/src/git/command";
import {
	createPrivateGitRepository,
	type PrivateGitRepository,
} from "../../core/src/git/repository";
import { parseIntent } from "../../core/src/intent/parse";
import { buildChildEnvironment } from "../../core/src/process/environment";
import type { ResolvedProject } from "../../core/src/project/resolve";
import {
	formatConfigDiagnostics,
	type MachineConfig,
	type ProjectConfig,
	parseMachineConfig,
} from "../../core/src/project/schema";
import { readAccountsFile } from "../../core/src/provider/accounts/format";
import { resolveAccountSelection } from "../../core/src/provider/accounts/select";
import { createInjectedAuthReader } from "../../core/src/provider/auth/injected";
import { HttpTransport } from "../../core/src/provider/http/transport";
import { respondWithRetry } from "../../core/src/provider/retry/respond";
import { ProviderPauseBudget } from "../../core/src/provider/retry/transition";
import { userMessageBytes } from "../../core/src/provider/session/history";
import type { RoleToolAuthorization } from "../../core/src/provider/session/transition";
import { createSession } from "../../core/src/provider/session/transition";
import { createToolOutputHandler } from "../../core/src/provider/tools/output";
import {
	CANONICAL_TOOL_SCHEMAS,
	roleToolAuthorizationForRecipe,
	TOOL_SCHEMA_VERSION,
} from "../../core/src/provider/tools/schema";
import { createShellToolHandler } from "../../core/src/provider/tools/shell";
import {
	forcedSandboxUnavailableReason,
	resolveSandboxPolicy,
	sandboxAlreadyConfined,
} from "../../core/src/sandbox/policy";
import { cloneFreshWorkspace } from "../../core/src/workspace/clone";
import { snapshotWorkspace } from "../../core/src/workspace/snapshot";
import { YAML_MAX_BYTES } from "../../core/src/yaml/preflight";
import { createApprovalProcess } from "./approval-process";
import {
	createInjectedChatGptAttemptSender,
	createOwnedChatGptAttemptSender,
} from "./build-provider";
import { type ControllerRuntime, createControllerRuntime } from "./composition";
import { createI2CredentialPort } from "./i2-auth";

const decoder = new TextDecoder("utf-8", { fatal: true });
const plannerInstructions =
	"You are Kogen's planner. Write a one-shot implementation plan for a cheaper coding agent.";
const buildAuditorInstructions =
	'You are Kogen\'s acceptance test auditor. Explain each failing approved acceptance item. Return only JSON: {"items":[{"id":string,"verdict":"valid|over_strict|contradicts","reason":string}]}. Your advice is observational and cannot remove a gate.';

export function buildToolSchemas(recipe: ProjectConfig["build"]["recipe"]) {
	const allowed = new Set(roleToolAuthorizationForRecipe(recipe).builder);
	return CANONICAL_TOOL_SCHEMAS.filter((schema) => allowed.has(schema.name));
}

export function buildToolAuthorization(
	recipe: ProjectConfig["build"]["recipe"],
): RoleToolAuthorization {
	const source = roleToolAuthorizationForRecipe(recipe);
	const allowed = new Set<string>(
		buildToolSchemas(recipe).map((schema) => schema.name),
	);
	return Object.fromEntries(
		Object.entries(source).map(([role, tools]) => [
			role,
			tools.filter((name) => allowed.has(name)),
		]),
	) as unknown as RoleToolAuthorization;
}

const clock: ClockPort = {
	monotonicMilliseconds: () => performance.now(),
	unixMilliseconds: () => Date.now(),
	sleep(milliseconds, signal) {
		return new Promise<void>((resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, milliseconds);
			function onAbort() {
				clearTimeout(timer);
				reject(signal?.reason);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	},
};

const random: RandomPort = {
	async bytes(length) {
		return { ok: true, value: randomBytes(length) };
	},
};

function effect(
	code: string,
	message: string,
	exitCode: 3 | 4 | 70 = 3,
): BuildEffectFailure {
	return { code, message, exitCode };
}

function fromPort<T>(
	result: Result<T>,
	code: string,
): Result<T, BuildEffectFailure> {
	return result.ok
		? result
		: { ok: false, error: effect(code, result.error.message) };
}

/** Resolve the account once for this Build, after the public provider-use map. */
export async function resolvePublicBuildAccount(request: {
	readonly filesystem: Pick<FileSystemPort, "readFile">;
	readonly homeDirectory: string;
	readonly checkout: string;
	readonly committedAccount?: string;
	readonly environment?: Readonly<{
		KOGEN_BENCH_PROVIDER?: string;
		KOGEN_BENCH_ACCOUNT?: string;
	}>;
}): Promise<Result<string, BuildEffectFailure>> {
	const read = await readAccountsFile(
		request.filesystem,
		request.homeDirectory,
	);
	if (!read.ok)
		return {
			ok: false,
			error: effect("environment/accounts_invalid", read.error.message),
		};
	const selected = resolveAccountSelection({
		checkout: request.checkout,
		accounts: read.value ?? {},
		...(request.committedAccount === undefined
			? {}
			: { committedAccount: request.committedAccount }),
		...(request.environment === undefined
			? {}
			: { environment: request.environment }),
	});
	if (!selected.ok)
		return {
			ok: false,
			error: effect(
				"environment/account_selection_invalid",
				selected.error.message,
			),
		};
	if (selected.value.provider !== "chatgpt")
		return {
			ok: false,
			error: effect(
				"environment/provider_unavailable",
				"Grok public Build enters at I6.",
			),
		};
	return { ok: true, value: selected.value.account };
}

/** Load the machine role defaults used below the committed project overrides. */
export async function loadPublicBuildMachineConfig(
	filesystem: Pick<FileSystemPort, "readFile">,
	homeDirectory: string,
): Promise<Result<MachineConfig, BuildEffectFailure>> {
	const read = await filesystem.readFile({
		root: join(homeDirectory, ".kogen"),
		path: "config.yaml",
		maxBytes: YAML_MAX_BYTES,
	});
	if (!read.ok)
		return read.error.code === "not_found"
			? { ok: true, value: { build: {} } }
			: {
					ok: false,
					error: effect(
						"environment/machine_config_invalid",
						read.error.message,
					),
				};
	const parsed = parseMachineConfig(read.value);
	return parsed.ok
		? { ok: true, value: parsed.value }
		: {
				ok: false,
				error: effect(
					"environment/machine_config_invalid",
					formatConfigDiagnostics(parsed.diagnostics).join("\n"),
				),
			};
}

export async function readBuildGitText(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
): Promise<string | null> {
	const result = await git.command({
		repository,
		argv,
		timeoutMilliseconds: 30_000,
		outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES,
	});
	if (!result.ok || result.value.exitCode !== 0 || result.value.timedOut)
		return null;
	try {
		return decoder.decode(result.value.stdout).trim();
	} catch {
		return null;
	}
}

function copyWorkspace(from: string, to: string): void {
	mkdirSync(to, { recursive: true, mode: 0o700 });
	for (const name of readdirSync(from)) {
		if (name === ".git") continue;
		cpSync(join(from, name), join(to, name), {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
			preserveTimestamps: true,
		});
	}
}

class BuildGateTree implements GateTreePort {
	private sequence = 0;
	private readonly copies = new Map<string, string>();
	constructor(
		private readonly repository: PrivateGitRepository,
		private readonly origin: string,
		private readonly baseCommit: string,
		private readonly workspace: string,
		private readonly runDirectory: string,
		private readonly runtime: ControllerRuntime,
	) {}

	async snapshot(): Promise<Result<GateTreeSnapshot>> {
		const snapshot = await snapshotWorkspace({
			repository: this.repository,
			sourceRepository: this.origin,
			baseCommit: this.baseCommit,
			filesystem: this.runtime.filesystemHost,
		});
		if (!snapshot.ok) return snapshot;
		const restoreToken = `gate-${++this.sequence}`;
		const copy = join(this.runDirectory, restoreToken);
		copyWorkspace(this.workspace, copy);
		this.copies.set(restoreToken, copy);
		return { ok: true, value: { identity: snapshot.value.tree, restoreToken } };
	}

	async changedPaths(
		before: GateTreeSnapshot,
		after: GateTreeSnapshot,
	): Promise<Result<readonly string[]>> {
		const result = await this.repository.command([
			"diff-tree",
			"-r",
			"--name-only",
			before.identity,
			after.identity,
		]);
		if (!result.ok) return result;
		if (result.value.exitCode !== 0)
			return {
				ok: false,
				error: {
					code: "io",
					message: "Could not compare gate trees.",
					retryable: false,
				},
			};
		return {
			ok: true,
			value: decoder
				.decode(result.value.stdout)
				.trim()
				.split("\n")
				.filter(Boolean),
		};
	}

	async restore(snapshot: GateTreeSnapshot): Promise<Result<void>> {
		const copy = this.copies.get(snapshot.restoreToken);
		if (copy === undefined)
			return {
				ok: false,
				error: {
					code: "not_found",
					message: "Gate snapshot is missing.",
					retryable: false,
				},
			};
		for (const name of readdirSync(this.workspace))
			if (name !== ".git")
				rmSync(join(this.workspace, name), { recursive: true, force: true });
		copyWorkspace(copy, this.workspace);
		return { ok: true, value: undefined };
	}
}

function commandAdapter(config: ProjectConfig): AcceptanceAdapter {
	if (config.acceptance.adapter !== "command")
		throw new Error("The selected acceptance adapter is not available at I2.");
	const result = createCommandAdapter({
		extension: config.acceptance.extension ?? ".t.sh",
		candidateDirectory:
			config.acceptance.candidateDirectory ?? "test/acceptance",
		run: config.acceptance.run ?? ["sh", "run-acceptance.sh", "{path}"],
	});
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function baselines(
	approval: LoadedBuildApproval,
): readonly GateCheckBaseline[] {
	const raw = approval.metadata.check_baseline;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((row): GateCheckBaseline[] => {
		if (row === null || typeof row !== "object" || Array.isArray(row))
			return [];
		const item = row as Record<string, unknown>;
		if (typeof item.name !== "string" || typeof item.status !== "string")
			return [];
		if (
			!["green", "red", "unavailable", "timeout", "mutating"].includes(
				item.status,
			)
		)
			return [];
		return [
			{
				name: item.name,
				status: item.status as GateCheckBaseline["status"],
				exitStatus:
					typeof item.exit_status === "number" ? item.exit_status : null,
				findings: [],
			},
		];
	});
}

export async function executePublicBuild(request: {
	readonly slug: string;
	readonly runId: string;
	readonly stateRoot: string;
	readonly resolution: ResolvedProject;
	readonly config: ProjectConfig;
	readonly runtime: ControllerRuntime;
	readonly owner: { readonly pid: number; readonly startedMs: number };
	readonly signal?: AbortSignal;
}): Promise<BuildControllerResult> {
	const { slug, runId, stateRoot, resolution, config, runtime } = request;
	const runDirectory = join(stateRoot, "runs", runId);
	const workspaceForRung = (rung: string) =>
		join(stateRoot, `${runId}-${rung}`);
	const adapter = commandAdapter(config);
	const http = new HttpTransport(clock);
	const homeDirectory = process.env.HOME ?? homedir();
	const account = await resolvePublicBuildAccount({
		filesystem: runtime.filesystem,
		homeDirectory,
		checkout: resolution.checkout,
		...(config.account === undefined
			? {}
			: { committedAccount: config.account }),
		environment: {
			...(process.env.KOGEN_BENCH_PROVIDER === undefined
				? {}
				: { KOGEN_BENCH_PROVIDER: process.env.KOGEN_BENCH_PROVIDER }),
			...(process.env.KOGEN_BENCH_ACCOUNT === undefined
				? {}
				: { KOGEN_BENCH_ACCOUNT: process.env.KOGEN_BENCH_ACCOUNT }),
		},
	});
	if (!account.ok)
		return {
			outcome: "stopped",
			runId: null,
			exitCode: account.error.exitCode,
			reason: account.error.code,
			record: null,
		};
	const machine = await loadPublicBuildMachineConfig(
		runtime.filesystem,
		homeDirectory,
	);
	if (!machine.ok)
		return {
			outcome: "stopped",
			runId: null,
			exitCode: machine.error.exitCode,
			reason: machine.error.code,
			record: null,
		};
	const authPath = process.env.KOGEN_AUTH_PATH;
	const authMode =
		authPath === undefined ? ("owned" as const) : ("injected" as const);
	const auth =
		authPath === undefined
			? null
			: createInjectedAuthReader(runtime.filesystem, authPath, { clock });
	const sender =
		auth === null
			? createOwnedChatGptAttemptSender({
					http,
					credentials: createI2CredentialPort(runtime, homeDirectory),
					random,
					clock,
					homeDirectory,
					label: account.value,
					version: "0.1",
					...(process.env.KOGEN_PROVIDER_URL === undefined
						? {}
						: { testEndpointOverride: process.env.KOGEN_PROVIDER_URL }),
					...(process.env.KOGEN_AUTH_URL === undefined
						? {}
						: { testAuthUrl: process.env.KOGEN_AUTH_URL }),
					...(process.env.KOGEN_TIME_SCALE === undefined
						? {}
						: { timeScale: Number(process.env.KOGEN_TIME_SCALE) }),
				})
			: createInjectedChatGptAttemptSender({
					http,
					auth,
					clock,
					version: "0.1",
					...(process.env.KOGEN_PROVIDER_URL === undefined
						? {}
						: { testEndpointOverride: process.env.KOGEN_PROVIDER_URL }),
				});
	const buildBudget = new BuildBudget(config.build.budgetMs, clock);
	const budget = () => buildBudget.remainingMilliseconds();
	const pauseBudget = new ProviderPauseBudget();
	// A separate bridge lets a queue signal kill every Build-owned child group
	// while the main bridge remains available to append the interrupt event.
	const childRuntime = await createControllerRuntime();
	let abortChildren: Promise<void> | null = null;
	const interruptChildren = () => {
		abortChildren = childRuntime.bridge
			.abortRunningProcess()
			.catch(() => undefined);
	};
	request.signal?.addEventListener("abort", interruptChildren, { once: true });
	if (request.signal?.aborted) interruptChildren();
	let repository: PrivateGitRepository | null = null;
	let protectedManifest: ProtectedManifest | null = null;
	let baseAcceptance: readonly {
		id: string;
		kind: "test" | "test keep";
		status: "passed" | "failed";
		output: readonly string[];
	}[] = [];
	let sandboxProcess = childRuntime.process;
	let preparedCommit: LandingCommit | null = null;
	let preparedRecord: {
		approval_commit: string;
		run_id: string;
		expected_parent: string;
		final_tree: string;
		candidate_commit: string;
	} | null = null;
	const identity = {
		current: () => request.owner,
		async inspect(pid: number) {
			const { inspectOwnerPid } = await import("./status-runs");
			return { ok: true as const, value: await inspectOwnerPid(pid) };
		},
	};
	try {
		const build = await runBuild({
			...(request.signal === undefined ? {} : { signal: request.signal }),
			git: runtime.git,
			origin: resolution.origin,
			slug,
			targetBranch: resolution.base,
			runId,
			owner: request.owner,
			identity,
			inspectClaimOwner: async (otherRunId) => {
				const path = join(stateRoot, "runs", otherRunId, "run.json");
				if (!existsSync(path)) return { ok: true, value: "stale" as const };
				return { ok: true, value: "unknown" as const };
			},
			provider: "chatgpt",
			project: config,
			machine: machine.value,
			clock,
			remainingBuildBudgetMilliseconds: budget,
			runDirectory: {
				host: runtime.filesystemHost,
				async create() {
					mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
					return { ok: true as const, value: runDirectory };
				},
			},
			sandbox: {
				async probe() {
					const capability = config.sandbox
						? await runtime.probeSandbox()
						: { available: false };
					const forced = forcedSandboxUnavailableReason(process.env);
					const policy = resolveSandboxPolicy({
						enabled: config.sandbox,
						alreadyConfined: sandboxAlreadyConfined(process.env),
						...(forced === null ? {} : { forcedUnavailableReason: forced }),
						capability,
					});
					return {
						ok: true as const,
						value: {
							mode: policy.mode,
							unavailableReason: policy.unavailableReason,
						},
					};
				},
			},
			base: {
				async resolve() {
					const commit = await readBuildGitText(
						runtime.git,
						resolution.origin,
						["rev-parse", `refs/heads/${resolution.base}`],
					);
					const tree =
						commit === null
							? null
							: await readBuildGitText(runtime.git, resolution.origin, [
									"rev-parse",
									`${commit}^{tree}`,
								]);
					const paths =
						commit === null
							? null
							: await readBuildGitText(runtime.git, resolution.origin, [
									"ls-tree",
									"-r",
									"--name-only",
									commit,
								]);
					if (commit === null || tree === null || paths === null)
						return {
							ok: false as const,
							error: effect(
								"environment/base_unavailable",
								"Could not resolve Build base.",
							),
						};
					return {
						ok: true as const,
						value: {
							commit,
							tree,
							trackedPaths: paths.split("\n").filter(Boolean),
						},
					};
				},
				async checkMovedBase() {
					return { ok: true as const, value: undefined };
				},
			},
			planner: {
				async complete(input) {
					const session = createSession({
						runDirectory,
						provider: "chatgpt",
						authMode,
						role: "planner",
						model: input.role.effective.model,
						effort: input.role.effective.effort,
						stage: "plan",
						roleInstructions: plannerInstructions,
						genericInstructions: BUILD_GENERIC_INSTRUCTIONS,
						toolSchemas: buildToolSchemas(config.build.recipe),
						toolSchemaVersion: TOOL_SCHEMA_VERSION,
						promptVersion: "build-prompt-v1",
						adapterVersion: "responses-v1",
						roleToolAuthorization: buildToolAuthorization(config.build.recipe),
						initialItems: [
							{
								bytes: userMessageBytes(
									`${decoder.decode(input.intentBytes)}\n\nTracked files:\n${input.trackedPaths.join("\n")}`,
								),
								kind: "message",
							},
						],
					});
					const result = await respondWithRetry({
						session,
						resolvedRole: input.role,
						mode: "build",
						clock,
						random,
						sendAttempt: sender,
						remainingBuildBudgetMilliseconds: budget,
						providerPauseBudget: pauseBudget,
						buildBudget,
						...(request.signal === undefined ? {} : { signal: request.signal }),
					});
					return result.kind === "completed"
						? { ok: true as const, value: { text: result.response.text } }
						: {
								ok: false as const,
								error: {
									code:
										result.kind === "stopped"
											? result.reason
											: "provider/timeout",
									message: "Planner request stopped.",
									exitCode: 4 as const,
								},
							};
				},
			},
			rung: {
				async createWorkspace(input) {
					const workspaceRoot = workspaceForRung(input.rung);
					const cloned = await cloneFreshWorkspace(childRuntime.process, {
						sourceRepository: resolution.origin,
						destination: workspaceRoot,
						baseCommit: input.base.commit,
					});
					if (!cloned.ok)
						return fromPort(cloned, "environment/workspace_unavailable");
					mkdirSync(dirname(join(workspaceRoot, input.approval.intentPath)), {
						recursive: true,
					});
					mkdirSync(dirname(join(workspaceRoot, adapter.candidatePath(slug))), {
						recursive: true,
					});
					const intent = await runtime.filesystem.writeFileAtomically({
						root: workspaceRoot,
						path: input.approval.intentPath,
						bytes: input.approval.intentBytes,
						mode: 0o644,
					});
					if (!intent.ok)
						return fromPort(intent, "environment/workspace_unavailable");
					const acceptance = await runtime.filesystem.writeFileAtomically({
						root: workspaceRoot,
						path: adapter.candidatePath(slug),
						bytes: input.approval.acceptanceBytes,
						mode: 0o644,
					});
					if (!acceptance.ok)
						return fromPort(acceptance, "environment/workspace_unavailable");
					const metadata = join(runDirectory, `private-git-${input.rung}`);
					mkdirSync(metadata, { recursive: true, mode: 0o700 });
					const created = await createPrivateGitRepository(
						childRuntime.process,
						{
							sourceRepository: resolution.origin,
							gitDirectory: metadata,
							workTree: workspaceRoot,
						},
					);
					if (!created.ok)
						return fromPort(created, "environment/workspace_unavailable");
					repository = created.value;
					const parsed = parseIntent(input.approval.intentBytes);
					if (!parsed.ok)
						return {
							ok: false as const,
							error: effect(
								"controller/approval_invalid",
								"Approved Intent is invalid.",
								70,
							),
						};
					const manifest = await buildProtectedManifest({
						repository: created.value,
						sourceRepository: resolution.origin,
						baseCommit: input.approval.baseSha,
						project: config,
						changesGate: parsed.intent.frontmatter.changesGate,
						intentPath: input.approval.intentPath,
						intentBytes: input.approval.intentBytes,
						testPath: adapter.candidatePath(slug),
						testBytes: input.approval.acceptanceBytes,
					});
					if (!manifest.ok)
						return fromPort(manifest, "environment/protected_manifest_invalid");
					protectedManifest = manifest.value;
					const confinement = createApprovalProcess({
						raw: childRuntime.process,
						platform: process.platform,
						probe: config.sandbox
							? await runtime.probeSandbox()
							: { available: false, reason: "disabled" },
						enabled: config.sandbox,
						hostEnvironment: process.env,
						checkout: resolution.checkout,
						origin: resolution.origin,
						workspace: workspaceRoot,
						runDirectory,
						home: process.env.HOME ?? homedir(),
					});
					sandboxProcess = confinement.process;
					if (confinement.warning !== null)
						process.stderr.write(`${confinement.warning}\n`);
					return {
						ok: true as const,
						value: { id: input.rung, root: workspaceRoot },
					};
				},
				async setup(workspaceValue) {
					const environment = await buildChildEnvironment({
						projectRoot: resolution.checkout,
						workspace: workspaceValue.root,
						runDirectory,
						projectEnvironment: Object.fromEntries(config.env),
						process: childRuntime.process,
						adapter: config.acceptance.adapter,
						...(existsSync(join(resolution.checkout, "mise.toml"))
							? {}
							: { miseBinaryPath: null }),
					});
					for (const [index, check] of config.setup.entries()) {
						const result = await runGateCommand({
							process: sandboxProcess,
							filesystem: runtime.filesystem,
							workdir: workspaceValue.root,
							runDirectory,
							environment: environment.environment,
							step: `build/setup/${check.name}`,
							index: index + 1,
							argv: check.argv,
							timeoutMilliseconds: check.timeoutMs,
						});
						if (!result.ok || result.value.exitStatus !== 0)
							return {
								ok: false as const,
								error: effect(
									"environment/setup_failed",
									`Setup ${check.name} failed.`,
								),
							};
					}
					return { ok: true as const, value: undefined };
				},
				async baseAcceptance(input) {
					if (repository === null)
						return {
							ok: false as const,
							error: effect(
								"controller/workspace_missing",
								"Build repository is missing.",
								70,
							),
						};
					const parsed = parseIntent(input.approval.intentBytes);
					if (!parsed.ok)
						return {
							ok: false as const,
							error: effect(
								"controller/approval_invalid",
								"Approved Intent is invalid.",
								70,
							),
						};
					const tree = new BuildGateTree(
						repository,
						resolution.origin,
						input.approval.baseSha,
						input.workspace.root,
						runDirectory,
						runtime,
					);
					const environment = await buildChildEnvironment({
						projectRoot: resolution.checkout,
						workspace: input.workspace.root,
						runDirectory,
						projectEnvironment: Object.fromEntries(config.env),
						process: childRuntime.process,
						adapter: config.acceptance.adapter,
						...(existsSync(join(resolution.checkout, "mise.toml"))
							? {}
							: { miseBinaryPath: null }),
					});
					const ledger = await runAcceptanceLedger({
						adapter,
						process: sandboxProcess,
						filesystem: runtime.filesystem,
						tree: {
							async snapshot() {
								const result = await tree.snapshot();
								return result.ok
									? { ok: true as const, value: result.value.identity }
									: result;
							},
						},
						workdir: input.workspace.root,
						slug,
						itemIds: parsed.intent.acceptance.map((item) => item.id),
						reportDirectory: runDirectory,
						reportFilename: "base-acceptance.jsonl",
						environment: environment.environment,
						timeoutMilliseconds: config.acceptance.timeoutMs,
					});
					if (!ledger.ok)
						return fromPort(ledger, "environment/acceptance_unavailable");
					if (
						ledger.value.failures.some(
							(failure) => failure.classification === "tool_missing",
						)
					)
						return {
							ok: true as const,
							value: { kind: "unavailable" as const },
						};
					baseAcceptance = parsed.intent.acceptance.map((item) => ({
						id: item.id,
						kind: "test" as const,
						status:
							ledger.value.items.find((row) => row.id === item.id)?.status ===
							"pass"
								? ("passed" as const)
								: ("failed" as const),
						output: [],
					}));
					return { ok: true as const, value: { items: baseAcceptance } };
				},
				async run(input) {
					if (repository === null)
						return {
							ok: false as const,
							error: effect(
								"provider/login",
								"Codex login is missing, invalid, or expired.",
								4,
							),
						};
					const repositoryValue = repository;
					const tree = new BuildGateTree(
						repositoryValue,
						resolution.origin,
						input.base.commit,
						input.workspace.root,
						runDirectory,
						runtime,
					);
					const environment = await buildChildEnvironment({
						projectRoot: resolution.checkout,
						workspace: input.workspace.root,
						runDirectory,
						projectEnvironment: Object.fromEntries(config.env),
						process: childRuntime.process,
						adapter: config.acceptance.adapter,
						...(existsSync(join(resolution.checkout, "mise.toml"))
							? {}
							: { miseBinaryPath: null }),
					});
					const attempt = input.attempt;
					const rungName = attempt?.rung ?? "R1";
					const role = attempt?.role ?? input.roles.roles.builder;
					const session = createBuilderSession({
						runDirectory,
						provider: "chatgpt",
						role,
						authMode,
						recipe: config.build.recipe,
						attempt: attempt?.name ?? "builder",
						rung: rungName,
						promptVersion: "build-prompt-v1",
						adapterVersion: "responses-v1",
						intentBytes: input.approval.intentBytes,
						acceptance: input.baseAcceptance?.items ?? baseAcceptance,
						plan: attempt?.input === "request" ? null : input.plan.text,
						...(input.earlierAttempts === undefined
							? {}
							: { earlierAttempts: input.earlierAttempts }),
						repairsLeft: 6,
						genericInstructions: BUILD_GENERIC_INSTRUCTIONS,
						toolSchemas: buildToolSchemas(config.build.recipe),
						roleToolAuthorization: buildToolAuthorization(config.build.recipe),
					});
					await input.emit("model_stage", {
						stage: "builder",
						provider: "chatgpt",
						model: session.model,
						effort: session.effort,
					});
					const shell = createShellToolHandler({
						workspaceRoot: input.workspace.root,
						runDirectory,
						environment: environment.environment,
						filesystem: runtime.filesystem,
						process: sandboxProcess,
						toolResultTokens: config.build.toolResultTokens,
						timeoutScale: Number(process.env.KOGEN_TIME_SCALE ?? "1"),
					});
					const toolOutput = createToolOutputHandler({
						runDirectory,
						filesystem: runtime.filesystem,
						toolResultTokens: config.build.toolResultTokens,
					});
					const outcome = await runRungMachine({
						runId,
						rung: rungName,
						workspace: input.workspace,
						approval: input.approval,
						baseCommit: input.base.commit,
						plan: input.plan,
						roles: input.roles,
						session,
						developer: {
							async complete(turn) {
								const result = await respondWithRetry({
									session: turn.session,
									resolvedRole: role,
									mode: "build",
									clock,
									random,
									sendAttempt: sender,
									remainingBuildBudgetMilliseconds: budget,
									providerPauseBudget: pauseBudget,
									buildBudget,
									...(request.signal === undefined
										? {}
										: { signal: request.signal }),
									timeScale: Number(process.env.KOGEN_TIME_SCALE ?? "1"),
								});
								for (const event of result.events)
									await input.emit(
										event.event,
										event as unknown as Record<
											string,
											string | number | boolean
										>,
									);
								if (result.kind === "completed")
									return {
										kind: "completed" as const,
										response: result.response,
										session: result.session,
										attempts: result.attempts.length,
									};
								if (result.kind === "stopped")
									return {
										kind: "provider_failure" as const,
										session: result.session,
										attempts: result.attempts.length,
										reason: result.error.class,
									};
								return {
									kind:
										result.kind === "cancelled"
											? ("cancelled" as const)
											: ("budget_exhausted" as const),
									session: result.session,
									attempts: result.attempts.length,
								};
							},
						},
						tools: {
							authorizedTools: session.authorizedTools,
							additionalHandlers: { shell, tool_output: toolOutput },
						},
						tree: {
							async snapshot(baseCommit) {
								const snap = await snapshotWorkspace({
									repository: repositoryValue,
									sourceRepository: resolution.origin,
									baseCommit,
									filesystem: runtime.filesystemHost,
								});
								return snap.ok
									? {
											ok: true as const,
											value: { baseCommit, identity: snap.value.tree },
										}
									: fromPort(snap, "environment/tree_snapshot_failed");
							},
						},
						protection: {
							async restoreAfterToolBatch(previous) {
								if (protectedManifest === null)
									return {
										ok: false as const,
										error: effect(
											"controller/protected_manifest_missing",
											"Protected manifest is missing.",
											70,
										),
									};
								const restored = await restoreProtectedPaths({
									repository: repositoryValue,
									sourceRepository: resolution.origin,
									manifest: protectedManifest,
									filesystem: runtime.filesystemHost,
									rung: rungName,
									previousRestoreCount: previous,
								});
								return restored.ok
									? { ok: true as const, value: restored.value }
									: fromPort(restored, "environment/protected_restore_failed");
							},
						},
						verification: {
							async verify() {
								const parsed = parseIntent(input.approval.intentBytes);
								const checked = await verifyGate({
									process: sandboxProcess,
									filesystem: runtime.filesystem,
									tree,
									workdir: input.workspace.root,
									runDirectory,
									runId,
									slug,
									itemIds: parsed.ok
										? parsed.intent.acceptance.map((item) => item.id)
										: [],
									environment: environment.environment,
									fixes: config.fix,
									checks: config.checks,
									baselines: baselines(input.approval),
									acceptance: {
										adapter,
										reportDirectory: runDirectory,
										reportFilename: "acceptance.jsonl",
										timeoutMilliseconds: config.acceptance.timeoutMs,
									},
								});
								return fromPort(
									checked,
									"environment/verification_unavailable",
								);
							},
						},
						audit: {
							async advise(auditInput) {
								const parsed = parseIntent(auditInput.request);
								if (!parsed.ok)
									return {
										ok: false as const,
										error: effect(
											"controller/approval_invalid",
											"Approved Intent is invalid.",
											70,
										),
									};
								const diff = await repositoryValue.command(
									[
										"diff",
										"--no-ext-diff",
										"--no-textconv",
										auditInput.baseCommit,
										auditInput.candidateTree,
									],
									{ outputLimitBytes: 512 * 1024 },
								);
								if (
									!diff.ok ||
									diff.value.exitCode !== 0 ||
									diff.value.timedOut
								)
									return {
										ok: false as const,
										error: effect(
											"environment/audit_diff_unavailable",
											"Could not read the candidate diff.",
										),
									};
								const failing = auditInput.verification.acceptance.items
									.filter((item) => item.status !== "pass")
									.map((item) => item.id);
								const message = [
									`Failing ids: ${failing.join(", ")}`,
									"Verbatim Request:",
									decoder.decode(
										parsed.intent.requestBytes ?? auditInput.request,
									),
									"Approved Intent:",
									decoder.decode(auditInput.request),
									"Acceptance test source:",
									decoder.decode(auditInput.approval.acceptanceBytes),
									"Failure output:",
									formatGateFeedback(auditInput.verification),
									"Candidate diff:",
									Array.from(decoder.decode(diff.value.stdout))
										.slice(0, 60_000)
										.join(""),
								].join("\n\n");
								const auditSession = createSession({
									runDirectory,
									provider: "chatgpt",
									authMode,
									role: "auditor",
									model: auditInput.role.effective.model,
									effort: auditInput.role.effective.effort,
									stage: "build-audit",
									attempt: `audit-${rungName}`,
									rung: rungName,
									roleInstructions: buildAuditorInstructions,
									genericInstructions: BUILD_GENERIC_INSTRUCTIONS,
									toolSchemas: buildToolSchemas(config.build.recipe),
									toolSchemaVersion: TOOL_SCHEMA_VERSION,
									promptVersion: "build-prompt-v1",
									adapterVersion: "responses-v1",
									roleToolAuthorization: buildToolAuthorization(
										config.build.recipe,
									),
									initialItems: [
										{ bytes: userMessageBytes(message), kind: "message" },
									],
								});
								const result = await respondWithRetry({
									session: auditSession,
									resolvedRole: auditInput.role,
									mode: "build",
									clock,
									random,
									sendAttempt: sender,
									remainingBuildBudgetMilliseconds: budget,
									providerPauseBudget: pauseBudget,
									buildBudget,
									...(request.signal === undefined
										? {}
										: { signal: request.signal }),
								});
								if (result.kind !== "completed")
									return {
										ok: false as const,
										error: effect(
											"provider/audit_unavailable",
											"Build audit request did not complete.",
											4,
										),
									};
								let raw: unknown;
								try {
									raw = JSON.parse(result.response.text);
								} catch {
									raw = null;
								}
								const observation = observeBuildAudit(
									auditInput.verification,
									raw,
								);
								return {
									ok: true as const,
									value: {
										items: observation.items,
										warning: observation.warning,
									},
								};
							},
						},
						clock,
						remainingBuildBudgetMilliseconds:
							input.remainingBuildBudgetMilliseconds ?? budget,
						...(input.wallMilliseconds === undefined
							? {}
							: { wallMilliseconds: input.wallMilliseconds }),
						emit: input.emit,
					});
					return { ok: true as const, value: outcome };
				},
				async parkCandidate() {
					return { ok: true as const, value: undefined };
				},
				async cleanup(input) {
					for (const candidate of input.workspaces)
						rmSync(candidate.root, { recursive: true, force: true });
					return { ok: true as const, value: undefined };
				},
			} satisfies BuildRungPort,
			landing: {
				async prepare(input) {
					if (repository === null)
						return {
							ok: false as const,
							error: effect(
								"controller/workspace_missing",
								"Build repository is missing.",
								70,
							),
						};
					const parsed = parseIntent(input.approval.intentBytes);
					if (!parsed.ok)
						return {
							ok: false as const,
							error: effect(
								"controller/approval_invalid",
								"Approved Intent is invalid.",
								70,
							),
						};
					const committed = await createLandingCommit({
						origin: resolution.origin,
						runId,
						slug,
						title: parsed.intent.frontmatter.title,
						expectedParent: input.base.commit,
						verifiedTree: input.candidate.verifiedTree,
						source: repository,
						git: runtime.publicGit,
					});
					if (!committed.ok)
						return fromPort(committed, "environment/landing_commit_failed");
					preparedCommit = committed.value;
					preparedRecord = {
						approval_commit: input.approval.approvalCommit,
						run_id: runId,
						expected_parent: input.base.commit,
						final_tree: committed.value.tree,
						candidate_commit: committed.value.commit,
					};
					return {
						ok: true as const,
						value: {
							candidateCommit: committed.value.commit,
							record: preparedRecord,
						},
					};
				},
				async publish() {
					if (preparedCommit === null || preparedRecord === null)
						return {
							ok: false as const,
							error: effect(
								"controller/landing_missing",
								"Prepared landing is missing.",
								70,
							),
						};
					const commit = preparedCommit;
					const record = preparedRecord;
					const plan = await planLandingCheckoutSync(runtime.publicGit, {
						origin: resolution.origin,
						branch: resolution.base,
						expectedParent: record.expected_parent,
						candidateCommit: commit.commit,
					});
					if (!plan.ok)
						return fromPort(plan, "environment/landing_unavailable");
					const current = await readBuildGitText(
						runtime.git,
						resolution.origin,
						["rev-parse", `refs/heads/${resolution.base}`],
					);
					if (current !== record.expected_parent)
						return { ok: true as const, value: "parked" as const };
					const incoming = `refs/kogen/incoming/${runId}`;
					const zero = "0".repeat(commit.commit.length);
					const created = await runtime.publicGit.command({
						repository: resolution.origin,
						argv: ["update-ref", incoming, commit.commit, zero],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 1024,
					});
					if (!created.ok || created.value.exitCode !== 0)
						return {
							ok: false as const,
							error: effect(
								"environment/incoming_ref_failed",
								"Could not publish incoming ref.",
							),
						};
					const landed = await runtime.publicGit.command({
						repository: resolution.origin,
						argv: [
							"update-ref",
							`refs/heads/${resolution.base}`,
							commit.commit,
							record.expected_parent,
						],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 1024,
					});
					if (!landed.ok || landed.value.exitCode !== 0)
						return { ok: true as const, value: "parked" as const };
					for (const warning of await applyLandingCheckoutSync(
						runtime.publicGit,
						plan.value,
					))
						process.stderr.write(`${warning}\n`);
					await runtime.publicGit.command({
						repository: resolution.origin,
						argv: ["update-ref", "-d", incoming, commit.commit],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 1024,
					});
					return { ok: true as const, value: "landed" as const };
				},
			},
		});
		return build;
	} finally {
		request.signal?.removeEventListener("abort", interruptChildren);
		if (abortChildren !== null) await abortChildren;
		await childRuntime.close();
	}
}
