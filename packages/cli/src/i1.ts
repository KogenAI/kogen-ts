import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandAdapter } from "../../core/src/adapters/command";
import { commitApprovalPackage } from "../../core/src/approval/commit";
import { preflightApproval } from "../../core/src/approval/preflight";
import { removeIntent } from "../../core/src/approval/remove";
import type { GitPort } from "../../core/src/contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../../core/src/fs/read";
import { buildProtectedManifest } from "../../core/src/gate/manifest";
import {
	captureProtectedWorkspace,
	listProtectedWorkspacePaths,
	staleCheckoutPaths,
} from "../../core/src/gate/protect";
import { createPrivateGitRepository } from "../../core/src/git/repository";
import { parseIntent } from "../../core/src/intent/parse";
import { buildChildEnvironment } from "../../core/src/process/environment";
import {
	nodeProjectPathPort,
	projectStateRootPath,
	type ResolvedProject,
	resolveProject,
} from "../../core/src/project/resolve";
import {
	formatConfigDiagnostics,
	type ProjectConfig,
	parseProjectConfig,
} from "../../core/src/project/schema";
import {
	deriveStatus,
	landingsFromReachableCommits,
	type StatusInput,
	type StatusIntent,
} from "../../core/src/status/derive";
import {
	renderStatusJsonLines,
	renderStatusText,
} from "../../core/src/status/render";
import { watchStatus } from "../../core/src/status/watch";
import { createApprovalProcess } from "./approval-process";
import { createApprovalWorkspace } from "./approval-workspace";
import type { ParsedCommand, ProjectOptions } from "./argv";
import { type ControllerRuntime, validateProjectCommand } from "./composition";
import { type CliOutput, renderErrorLine } from "./output";
import { recoverPublicRuns } from "./recover-runs";
import { inspectOwnerPid, readStatusRuns } from "./status-runs";

type ProjectCommand = Extract<
	ParsedCommand,
	{ name: "intent approve" | "intent remove" | "status" }
>;
const decoder = new TextDecoder("utf-8", { fatal: true });
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface ProjectContext {
	readonly resolution: ResolvedProject;
	readonly config: ProjectConfig;
}

function readableFailure(
	code: string,
	message: string,
	exit: number,
	details: readonly string[] = [],
): CliOutput {
	const first = message.startsWith(`${code}:`)
		? message
		: `${code}: ${message}`;
	return renderErrorLine(
		[first, ...details.slice(0, 20).map((detail) => `  ${detail}`)].join("\n"),
		exit,
	);
}

async function gitBytes(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	limit = 512 * 1024,
): Promise<Uint8Array | null> {
	const result = await git.command({
		repository,
		argv,
		timeoutMilliseconds: 30_000,
		outputLimitBytes: limit,
	});
	if (!result.ok || result.value.timedOut || result.value.exitCode !== 0)
		return null;
	return result.value.stdout;
}

async function gitText(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	limit?: number,
): Promise<string | null> {
	const bytes = await gitBytes(git, repository, argv, limit);
	if (bytes === null) return null;
	try {
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

export async function projectContext(
	command: ParsedCommand & ProjectOptions,
	runtime: ControllerRuntime,
): Promise<ProjectContext | CliOutput> {
	const initial = await resolveProject(
		{ ...command, cwd: process.cwd() },
		{ git: runtime.git, paths: nodeProjectPathPort },
	);
	if (!initial.ok)
		return readableFailure(
			`environment/${initial.error.code}`,
			initial.error.detail,
			3,
		);
	const bytes = await runtime.filesystem.readFile({
		root: initial.value.checkout,
		path: ".kogen/project.yaml",
		maxBytes: 1024 * 1024 + 1,
	});
	if (!bytes.ok) {
		const configOutput = await validateProjectCommand(command, runtime);
		if (configOutput !== undefined) return configOutput;
		return readableFailure(
			"environment/project_config_invalid",
			bytes.error.message,
			3,
		);
	}
	const config = parseProjectConfig(bytes.value);
	if (!config.ok)
		return readableFailure(
			"environment/project_config_invalid",
			`${initial.value.checkout}/.kogen/project.yaml\n${formatConfigDiagnostics(config.diagnostics).join("\n")}`,
			3,
		);
	const resolution =
		config.value.base === undefined
			? initial
			: await resolveProject(
					{
						...command,
						cwd: process.cwd(),
						configuredBase: config.value.base,
					},
					{ git: runtime.git, paths: nodeProjectPathPort },
				);
	if (!resolution.ok)
		return readableFailure(
			`environment/${resolution.error.code}`,
			resolution.error.detail,
			3,
		);
	mkdirSync(
		projectStateRootPath(
			process.env.HOME ?? homedir(),
			resolution.value.checkout,
		),
		{ recursive: true, mode: 0o700 },
	);
	return { resolution: resolution.value, config: config.value };
}

function isOutput(value: ProjectContext | CliOutput): value is CliOutput {
	return "exitCode" in value;
}

function commandAdapter(
	config: ProjectConfig,
): ReturnType<typeof createCommandAdapter> | CliOutput {
	if (config.acceptance.adapter !== "command")
		return readableFailure(
			"environment/acceptance_adapter_unavailable",
			`${config.acceptance.adapter} integration is pending`,
			3,
		);
	return createCommandAdapter({
		extension: config.acceptance.extension ?? ".t.sh",
		candidateDirectory:
			config.acceptance.candidateDirectory ?? "test/acceptance",
		run: config.acceptance.run ?? [],
	});
}

function adapterIsOutput(
	value: ReturnType<typeof createCommandAdapter> | CliOutput,
): value is CliOutput {
	return "exitCode" in value;
}

async function approverIdentity(
	runtime: ControllerRuntime,
	checkout: string,
	by: string | undefined,
): Promise<string | null> {
	if (by !== undefined) return by;
	const name = (
		await gitText(runtime.publicGit, checkout, ["config", "user.name"])
	)?.trim();
	const email = (
		await gitText(runtime.publicGit, checkout, ["config", "user.email"])
	)?.trim();
	return name && email ? `${name} <${email}>` : null;
}

async function approveCore(
	command: Extract<ProjectCommand, { name: "intent approve" }>,
	runtime: ControllerRuntime,
	context: ProjectContext,
	onSandboxWarning: (warning: string | null) => void,
): Promise<CliOutput> {
	const { resolution, config } = context;
	const adapted = commandAdapter(config);
	if (adapterIsOutput(adapted)) return adapted;
	if (!adapted.ok)
		return readableFailure(
			"environment/acceptance_adapter_invalid",
			adapted.error.message,
			3,
		);
	const adapter = adapted.value;
	const baseTree = (
		await gitText(runtime.git, resolution.origin, [
			"rev-parse",
			`${resolution.baseSha}^{tree}`,
		])
	)?.trim();
	if (!baseTree || !oid.test(baseTree))
		return readableFailure(
			"environment/base_unavailable",
			"Could not resolve the checked base tree",
			3,
		);
	const approver = await approverIdentity(
		runtime,
		resolution.checkout,
		command.by,
	);
	if (approver === null)
		return renderErrorLine(
			"intent/approval_identity_unavailable: configure git user.name and user.email",
			2,
		);
	const scratchRoot = mkdtempSync(join(tmpdir(), "kogen-approval-"));
	const runDirectory = join(scratchRoot, "run");
	mkdirSync(runDirectory, { mode: 0o700 });
	mkdirSync(join(runDirectory, "tmp"), { mode: 0o700 });
	let keepScratch = false;
	try {
		const environment = await buildChildEnvironment({
			projectRoot: resolution.checkout,
			workspace: resolution.checkout,
			runDirectory,
			projectEnvironment: Object.fromEntries(config.env),
			process: runtime.process,
			adapter: config.acceptance.adapter,
			...(existsSync(join(resolution.checkout, "mise.toml"))
				? {}
				: { miseBinaryPath: null }),
		});
		const sandbox = createApprovalProcess({
			raw: runtime.process,
			platform: process.platform,
			probe: config.sandbox
				? await runtime.probeSandbox()
				: { available: false, reason: "disabled" },
			enabled: config.sandbox,
			hostEnvironment: process.env,
			checkout: resolution.checkout,
			origin: resolution.origin,
			workspace: join(scratchRoot, `base-${command.slug}`),
			runDirectory,
			home: process.env.HOME ?? homedir(),
		});
		onSandboxWarning(sandbox.warning);
		const preflight = await preflightApproval({
			slug: command.slug,
			intentPath: `.kogen/intents/${command.slug}/intent.md`,
			checkoutPath: resolution.checkout,
			base: resolution.base,
			baseCommit: resolution.baseSha,
			baseTree,
			approver,
			...(command.hash === undefined ? {} : { expectedHash: command.hash }),
			scratchRoot,
			runDirectory,
			environment: environment.environment,
			project: {
				setup: config.setup,
				checks: config.checks,
				acceptanceChecks: config.acceptanceChecks,
			},
			setupKey: null,
			baselineIdentity: {
				childEnv: environment.environment,
				toolchain: null,
				os: process.platform,
				arch: process.arch,
				adapterVersion: "command-v1",
			},
			adapter,
			process: sandbox.process,
			filesystem: runtime.filesystem,
			workspace: createApprovalWorkspace(
				resolution.checkout,
				resolution.origin,
				runtime.process,
				runtime.filesystemHost,
				config.acceptance.candidateDirectory ?? "test/acceptance",
			),
		});
		if (!preflight.ok) {
			keepScratch =
				preflight.error.code.endsWith("cleanup_pending") ||
				preflight.error.code.endsWith("restore_failed");
			if (preflight.error.code === "intent/not_found")
				return readableFailure("intent/not_found", "Intent does not exist", 2);
			if (preflight.error.code === "intent/test_not_found")
				return readableFailure(
					"intent/acceptance_missing",
					`${adapter.sourcePath(command.slug)} does not exist`,
					2,
				);
			if (preflight.error.code === "environment/acceptance_check_unavailable") {
				const name = /Acceptance checker (.+) is unavailable/u.exec(
					preflight.error.message,
				)?.[1];
				const program = config.acceptanceChecks.find(
					(check) => check.name === name,
				)?.argv[0];
				if (program !== undefined)
					return readableFailure(
						"environment/tool_missing",
						`${program} is not available`,
						3,
					);
			}
			if (
				preflight.error.code === "intent/lint_failed" ||
				preflight.error.code === "intent/parse_failed"
			) {
				const lintOutput = await validateProjectCommand(command, runtime);
				if (lintOutput !== undefined) return lintOutput;
			}
			return readableFailure(
				preflight.error.code,
				preflight.error.message,
				preflight.error.exitCode,
				preflight.error.details,
			);
		}
		const intentPath = `.kogen/intents/${command.slug}/intent.md`;
		const intentSource = await runtime.filesystem.readFile({
			root: resolution.checkout,
			path: intentPath,
			maxBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 1,
		});
		const acceptancePath = adapter.sourcePath(command.slug);
		const testSource = await runtime.filesystem.readFile({
			root: resolution.checkout,
			path: acceptancePath,
			maxBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 1,
		});
		if (!intentSource.ok || !testSource.ok)
			return readableFailure(
				"intent/hash_mismatch",
				"Approval source changed after preflight",
				1,
			);
		const parsed = parseIntent(intentSource.value);
		if (!parsed.ok)
			return readableFailure(
				"intent/parse",
				"Intent changed after preflight",
				1,
			);
		const metadata = mkdtempSync(join(scratchRoot, "metadata-"));
		const repository = await createPrivateGitRepository(runtime.process, {
			sourceRepository: resolution.origin,
			gitDirectory: metadata,
			workTree: resolution.checkout,
		});
		if (!repository.ok)
			return readableFailure(
				"environment/approval_manifest_invalid",
				repository.error.message,
				3,
			);
		const checkoutEntries = await listProtectedWorkspacePaths(
			runtime.filesystemHost,
			resolution.checkout,
		);
		if (!checkoutEntries.ok)
			return readableFailure(
				"environment/approval_manifest_invalid",
				checkoutEntries.error.message,
				3,
			);
		const manifest = await buildProtectedManifest({
			repository: repository.value,
			sourceRepository: resolution.origin,
			baseCommit: resolution.baseSha,
			project: config,
			changesGate: parsed.intent.frontmatter.changesGate,
			intentPath,
			intentBytes: intentSource.value,
			testPath: adapter.candidatePath(command.slug),
			testBytes: testSource.value,
			checkoutPaths: checkoutEntries.value
				.filter((entry) => entry.kind !== "directory")
				.map((entry) => entry.path),
		});
		if (!manifest.ok)
			return readableFailure(
				"environment/approval_manifest_invalid",
				manifest.error.message,
				3,
			);
		const checkoutState = await captureProtectedWorkspace({
			repository: repository.value,
			sourceRepository: resolution.origin,
			baseCommit: resolution.baseSha,
			filesystem: runtime.filesystemHost,
			manifest: manifest.value,
		});
		if (!checkoutState.ok)
			return readableFailure(
				"environment/checkout_snapshot_failed",
				checkoutState.error.message,
				3,
			);
		const stalePaths = staleCheckoutPaths(manifest.value, checkoutState.value);
		if (stalePaths.length > 0)
			return readableFailure(
				"environment/checkout_behind_base",
				`checkout is behind ${resolution.base}: ${stalePaths.join(", ")} differ; update your checkout first`,
				3,
			);
		if (preflight.value.kind === "card")
			return {
				stdout: `${preflight.value.card ?? ""}\n`,
				stderr: "",
				exitCode: 5,
			};
		const committed = await commitApprovalPackage({
			origin: resolution.origin,
			checkout: resolution.checkout,
			slug: command.slug,
			intentPath,
			acceptancePath,
			protectedAcceptancePath: adapter.candidatePath(command.slug),
			targetBranch: resolution.base,
			baseSha: resolution.baseSha,
			givenHash: command.hash ?? "",
			...(command.by === undefined ? {} : { by: command.by }),
			preflight: preflight.value,
			protectedManifest: manifest.value.hashes,
			filesystem: runtime.filesystem,
			git: runtime.publicGit,
			clock: { unixMilliseconds: Date.now },
		});
		if (!committed.ok)
			return readableFailure(
				committed.error.code,
				committed.error.message,
				committed.error.exitCode,
			);
		return {
			stdout:
				(preflight.value.warningText.length === 0
					? ""
					: `${preflight.value.warningText}\n\n`) +
				`approved ${command.slug} ${committed.value.approvalSha256.slice(0, 8)} (approval ${committed.value.approvalCommit.slice(0, 8)}); it is queued\n` +
				"Next: kogen queue start (does nothing if the queue is already running)\n",
			stderr: "",
			exitCode: 0,
		};
	} finally {
		if (!keepScratch) rmSync(scratchRoot, { recursive: true, force: true });
	}
}

async function approve(
	command: Extract<ProjectCommand, { name: "intent approve" }>,
	runtime: ControllerRuntime,
	context: ProjectContext,
): Promise<CliOutput> {
	let warning: string | null = null;
	const output = await approveCore(command, runtime, context, (value) => {
		warning = value;
	});
	return warning === null
		? output
		: { ...output, stderr: `${warning}\n${output.stderr}` };
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function string(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export async function statusInput(
	runtime: ControllerRuntime,
	resolution: ResolvedProject,
): Promise<StatusInput> {
	const intentRoot = join(resolution.checkout, ".kogen", "intents");
	const slugs = existsSync(intentRoot) ? readdirSync(intentRoot) : [];
	const refs = await gitText(runtime.git, resolution.origin, [
		"for-each-ref",
		"--format=%(refname):%(objectname)",
		"refs/kogen/intents",
	]);
	const approvals = new Map<string, string>();
	for (const line of (refs ?? "").split("\n")) {
		const match =
			/^refs\/kogen\/intents\/([a-z0-9-]+):([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(
				line,
			);
		if (match?.[1] && match[2]) approvals.set(match[1], match[2]);
	}
	const intents: StatusIntent[] = [];
	for (const slug of slugs) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) continue;
		const ref = approvals.get(slug);
		let source: Uint8Array | null = null;
		if (ref !== undefined)
			source = await gitBytes(runtime.git, resolution.origin, [
				"show",
				`${ref}:.kogen/intents/${slug}/intent.md`,
			]);
		if (source === null) {
			const read = await runtime.filesystem.readFile({
				root: resolution.checkout,
				path: `.kogen/intents/${slug}/intent.md`,
				maxBytes: 1024 * 1024,
			});
			if (!read.ok) continue;
			source = read.value;
		}
		const parsed = parseIntent(source);
		if (!parsed.ok) continue;
		let approval: StatusIntent["approval"] = null;
		if (ref !== undefined) {
			const data = await gitBytes(runtime.git, resolution.origin, [
				"show",
				`${ref}:.kogen/intents/${slug}/approval.json`,
			]);
			if (data !== null) {
				let row: Record<string, unknown> | null = null;
				try {
					row = object(JSON.parse(decoder.decode(data)));
				} catch {}
				const sha256 = string(row?.approval_sha256);
				const by = string(row?.by);
				const baseSha = string(row?.base_sha);
				const at = string(row?.at);
				const approvedAt = at === null ? NaN : Date.parse(at);
				if (sha256 && by && baseSha && Number.isSafeInteger(approvedAt))
					approval = {
						commit: ref,
						sha256,
						approvedAt,
						approvedBy: by,
						baseSha,
					};
			}
		}
		intents.push({
			slug,
			priority: parsed.intent.frontmatter.priority,
			blocksOn: parsed.intent.frontmatter.blocksOn,
			approval,
			acceptanceIds: parsed.intent.acceptance.map((item) => item.id),
		});
	}
	const history = await gitText(
		runtime.git,
		resolution.origin,
		["log", "-z", "--format=%H%x00%ct%x00%B%x00", resolution.baseSha],
		900 * 1024,
	);
	const commits = [];
	if (history !== null) {
		const parts = history.split("\0");
		const sameSecondSeen = new Map<number, number>();
		for (let index = 0; index + 2 < parts.length; index += 4) {
			const sha = parts[index]?.replace(/^\n+/u, "") ?? "";
			const seconds = Number(parts[index + 1]);
			const message = parts[index + 2] ?? "";
			if (!oid.test(sha) || !Number.isSafeInteger(seconds)) continue;
			const rank = sameSecondSeen.get(seconds) ?? 0;
			sameSecondSeen.set(seconds, rank + 1);
			commits.push({
				sha,
				// Git records seconds; topo order resolves commits in that second.
				committedAt: seconds * 1000 + Math.max(0, 999 - rank),
				intentTrailers: [
					...message.matchAll(/^Kogen-Intent: ([a-z0-9-]+)$/gmu),
				].map((match) => match[1] ?? ""),
			});
		}
	}
	const stateRoot = projectStateRootPath(
		process.env.HOME ?? homedir(),
		resolution.checkout,
	);
	const claimText = await gitText(runtime.git, resolution.origin, [
		"show",
		"refs/kogen/claim:.kogen/claim",
	]);
	const claimRunId = /^[a-f0-9]{32}$/u.test(claimText?.trim() ?? "")
		? (claimText?.trim() ?? null)
		: null;
	let queuePid: number | null = null;
	try {
		const owner: unknown = JSON.parse(
			readFileSync(join(stateRoot, "queue.owner.json"), "utf8"),
		);
		if (
			owner !== null &&
			typeof owner === "object" &&
			"pid" in owner &&
			"startedMs" in owner &&
			Number.isSafeInteger(owner.pid) &&
			Number.isSafeInteger(owner.startedMs) &&
			(owner.pid as number) > 0
		) {
			const observed = await inspectOwnerPid(owner.pid as number);
			if (
				observed.kind === "alive" &&
				Math.abs(observed.startedMs - (owner.startedMs as number)) < 1000
			)
				queuePid = owner.pid as number;
		}
	} catch {}
	return {
		intents,
		reachableLandings: landingsFromReachableCommits(commits),
		runs: await readStatusRuns(stateRoot),
		claimRunId,
		queuePid,
		agents: [],
		nowMs: Date.now(),
	};
}

async function status(
	command: Extract<ProjectCommand, { name: "status" }>,
	runtime: ControllerRuntime,
	context: ProjectContext,
): Promise<CliOutput> {
	const recovered = await recoverPublicRuns(
		projectStateRootPath(
			process.env.HOME ?? homedir(),
			context.resolution.checkout,
		),
		context.resolution,
		runtime,
	);
	if (!recovered.ok)
		return renderErrorLine(
			`environment/recovery_failed: ${recovered.error.message}`,
			3,
		);
	let firstRead = true;
	const read = async () => {
		if (!firstRead) {
			const replayed = await recoverPublicRuns(
				projectStateRootPath(
					process.env.HOME ?? homedir(),
					context.resolution.checkout,
				),
				context.resolution,
				runtime,
			);
			if (!replayed.ok)
				throw new Error(`Recovery failed: ${replayed.error.message}`);
		}
		firstRead = false;
		const input = await statusInput(runtime, context.resolution);
		return { input, status: deriveStatus(input) };
	};
	if (command.watch) {
		const watched = await watchStatus({
			source: { read, wait: Bun.sleep },
			write: (chunk) => {
				process.stdout.write(chunk);
			},
			...(command.slug === undefined ? {} : { slug: command.slug }),
			timeScale: Number(process.env.KOGEN_TIME_SCALE ?? "1"),
		});
		return { stdout: "", stderr: "", exitCode: watched.exitCode };
	}
	const snapshot = await read();
	const rendered = command.json
		? renderStatusJsonLines(snapshot.status, snapshot.input, command.slug)
		: renderStatusText(snapshot.status, snapshot.input, command.slug);
	if (rendered === null)
		return renderErrorLine("intent/not_found: Intent does not exist", 2);
	return { stdout: rendered, stderr: "", exitCode: 0 };
}

async function remove(
	command: Extract<ProjectCommand, { name: "intent remove" }>,
	runtime: ControllerRuntime,
	context: ProjectContext,
): Promise<CliOutput> {
	const adapted = commandAdapter(context.config);
	if (adapterIsOutput(adapted)) return adapted;
	if (!adapted.ok)
		return readableFailure(
			"environment/acceptance_adapter_invalid",
			adapted.error.message,
			3,
		);
	const removed = await removeIntent({
		origin: context.resolution.origin,
		checkout: context.resolution.checkout,
		slug: command.slug,
		acceptancePath: adapted.value.sourcePath(command.slug),
		force: command.force,
		filesystem: runtime.filesystem,
		git: runtime.publicGit,
		lifecycle: {
			async inspect(slug, approvalCommit) {
				try {
					const input = await statusInput(runtime, context.resolution);
					const derived = deriveStatus(input);
					const intent = derived.bySlug.get(slug);
					const current = intent?.currentApprovalRun;
					return {
						ok: true,
						value: {
							activeBuild: input.runs.some(
								(run) =>
									run.record.slug === slug &&
									run.record.status === "running" &&
									run.record.approval_commit === approvalCommit,
							),
							landed: intent?.status === "landed",
							buildDisposition:
								intent?.status === "interrupted"
									? "interrupted"
									: current?.record.status === "failed" ||
											current?.record.status === "parked"
										? current.record.status
										: null,
						},
					};
				} catch (cause) {
					return {
						ok: false,
						error: { code: "io", message: String(cause), retryable: true },
					};
				}
			},
		},
	});
	if (!removed.ok)
		return readableFailure(
			removed.error.code,
			removed.error.message,
			removed.error.exitCode,
		);
	return {
		stdout: `removed: ${command.slug}\ncommit: ${removed.value.commit}\n`,
		stderr: "",
		exitCode: 0,
	};
}

/** Public I1 lifecycle composition; the reducers and effect ports remain shared. */
export async function runI1Command(
	command: ProjectCommand,
	runtime: ControllerRuntime,
): Promise<CliOutput> {
	const context = await projectContext(command, runtime);
	if (isOutput(context)) return context;
	switch (command.name) {
		case "intent approve":
			return approve(command, runtime, context);
		case "intent remove":
			return remove(command, runtime, context);
		case "status":
			return status(command, runtime, context);
	}
}
