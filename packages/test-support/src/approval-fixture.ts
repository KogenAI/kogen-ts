import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ApprovalCheckStatus } from "../../core/src/approval/card";
import type { ApprovalCommitSuccess } from "../../core/src/approval/commit";
import { commitApprovalPackage } from "../../core/src/approval/commit";
import type { ApprovalPreflightSuccess } from "../../core/src/approval/preflight";
import {
	type IntentRemoveLifecycle,
	removeIntent,
} from "../../core/src/approval/remove";
import type { PortError, Result } from "../../core/src/contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	GitRequest,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../core/src/contracts/ports";
import { createPublicGitPort } from "../../core/src/git/command";
import { hashApprovalBytes, hashIntentBytes } from "../../core/src/intent/hash";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_SLUGS = ["alpha", "bravo"] as const;
const CLOCK_EPOCH = 1_800_000_000_000;

export interface FixtureSourceBytes {
	readonly intent: Uint8Array;
	readonly acceptance: Uint8Array;
}

export interface FixtureLateMutation {
	readonly source: "intent" | "acceptance";
	readonly bytes: Uint8Array;
}

export interface FixtureApprovalRequest {
	readonly slug: string;
	readonly givenHash: string;
	readonly by?: string;
	readonly baseline?: ApprovalCheckStatus;
	readonly lateMutation?: FixtureLateMutation;
	readonly casRace?: 0 | 1 | 2;
	readonly witnessRequired?: boolean;
	readonly witness?: {
		readonly verdict: "PROVEN" | "PROVEN_WITH_CONCERNS";
		readonly diff_sha256: string;
	};
}

export interface FixtureApprovalRef {
	readonly commit: string;
	readonly approvalSha256: string;
	readonly parent: string | null;
}

export interface ApprovalFixtureDriver {
	readonly root: string;
	readonly origin: string;
	readonly checkout: string;
	readonly git: GitPort;
	readonly baseSha: string;
	readonly baseTree: string;
	reset(): Promise<void>;
	writeSources(slug: string, source: FixtureSourceBytes): void;
	recordSources(slug: string, source: FixtureSourceBytes): Promise<void>;
	readSources(slug: string): FixtureSourceBytes;
	removeAcceptance(slug: string): void;
	configureIdentity(identity: string | null): Promise<void>;
	approve(
		request: FixtureApprovalRequest,
	): Promise<
		Result<
			ApprovalCommitSuccess,
			import("../../core/src/approval/commit").ApprovalCommitFailure
		>
	>;
	remove(input: {
		readonly slug: string;
		readonly force: boolean;
		readonly lifecycle: IntentRemoveLifecycle;
	}): ReturnType<typeof removeIntent>;
	approvalRef(slug: string): Promise<FixtureApprovalRef | null>;
	gitText(
		repository: string,
		argv: readonly string[],
		stdin?: Uint8Array,
	): Promise<string>;
	close(): void;
}

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function fixtureEnvironment(
	home: string,
	scratch: string,
): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: scratch,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function fixtureProcessPort(): ProcessPort {
	return {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			const executable = request.argv[0];
			if (executable === undefined)
				return { ok: false, error: error("invalid_input", "empty argv") };
			const result = spawnSync(executable, request.argv.slice(1), {
				cwd: request.cwd,
				env: { ...request.env },
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				timeout: request.timeoutMilliseconds,
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				encoding: "buffer",
			});
			const spawnError = result.error as NodeJS.ErrnoException | undefined;
			if (spawnError?.code === "ETIMEDOUT")
				return {
					ok: true,
					value: {
						exitCode: null,
						signal: result.signal ?? null,
						stdout: result.stdout ?? new Uint8Array(),
						stderr: result.stderr ?? new Uint8Array(),
						timedOut: true,
					},
				};
			if (result.error !== undefined)
				return {
					ok: false,
					error: error("unavailable", result.error.message),
				};
			return {
				ok: true,
				value: {
					exitCode: result.status,
					signal: result.signal,
					stdout: result.stdout ?? new Uint8Array(),
					stderr: result.stderr ?? new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
}

function sourcePath(slug: string): string {
	return `.kogen/intents/${slug}/intent.md`;
}

function acceptancePath(slug: string): string {
	return `.kogen/acceptance/${slug}.t.sh`;
}

function absoluteFixturePath(root: string, path: string): string {
	const resolvedRoot = resolve(root);
	const target = resolve(resolvedRoot, path);
	if (!target.startsWith(resolvedRoot + sep))
		throw new Error("fixture path escapes its root");
	return target;
}

function fixtureFileSystem(
	checkout: string,
	lateMutation: () => FixtureLateMutation | null,
): Pick<FileSystemPort, "readFile"> & { resetReads(): void } {
	const reads = new Map<string, number>();
	return {
		resetReads() {
			reads.clear();
		},
		async readFile(request) {
			if (resolve(request.root) !== resolve(checkout))
				return {
					ok: false,
					error: error("invalid_input", "fixture read used an unexpected root"),
				};
			let target: string;
			try {
				target = absoluteFixturePath(checkout, request.path);
			} catch (cause) {
				return {
					ok: false,
					error: error(
						"invalid_input",
						cause instanceof Error ? cause.message : "invalid fixture path",
					),
				};
			}
			const count = (reads.get(request.path) ?? 0) + 1;
			reads.set(request.path, count);
			const mutation = lateMutation();
			const intendedPath = request.path.endsWith("/intent.md");
			const acceptance = request.path.startsWith(".kogen/acceptance/");
			if (
				mutation !== null &&
				count === 2 &&
				((mutation.source === "intent" && intendedPath) ||
					(mutation.source === "acceptance" && acceptance))
			) {
				writeFileSync(target, mutation.bytes, { mode: 0o600 });
			}
			let descriptor: number | undefined;
			try {
				descriptor = openSync(
					target,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
				);
				if (!fstatSync(descriptor).isFile())
					return {
						ok: false,
						error: error(
							"invalid_input",
							"fixture source is not a regular file",
						),
					};
				const bytes = new Uint8Array(readFileSync(descriptor));
				if (bytes.byteLength > request.maxBytes)
					return {
						ok: false,
						error: error(
							"invalid_input",
							"fixture source exceeds its byte limit",
						),
					};
				return { ok: true, value: bytes };
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				return {
					ok: false,
					error:
						code === "ENOENT"
							? error("not_found", "fixture source is missing")
							: error("io", "fixture source read failed"),
				};
			} finally {
				if (descriptor !== undefined) closeSync(descriptor);
			}
		},
	};
}

function processOutput(result: ProcessResult, command: string): string {
	if (result.timedOut || result.exitCode !== 0)
		throw new Error(
			"Git " +
				command +
				" failed (" +
				String(result.exitCode) +
				"): " +
				DECODER.decode(result.stderr),
		);
	return DECODER.decode(result.stdout).trimEnd();
}

function objectId(value: string): string {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value))
		throw new Error("Git fixture returned an invalid object id");
	return value;
}

function parseIdentity(
	identity: string,
): { name: string; email: string } | null {
	const match = /^(.*) <([^<>]+)>$/u.exec(identity);
	const name = match?.[1];
	const email = match?.[2];
	if (
		name === undefined ||
		email === undefined ||
		name.trim().length === 0 ||
		email.trim().length === 0 ||
		/[\r\n\0]/u.test(identity)
	)
		return null;
	return { name, email };
}

function defaultSource(slug: string): FixtureSourceBytes {
	const intent = ENCODER.encode(
		"---\n" +
			"title: Fixture " +
			slug +
			" Intent\n" +
			"size: small\n" +
			"domains: [app]\n" +
			"---\n" +
			"Update the fixture output to contain its expected value.\n\n" +
			"## Acceptance\n" +
			"- A1: The fixture output contains its expected value.\n\n" +
			"## Verify\n" +
			"- A1: test\n\n" +
			"## Request\n" +
			"Set the fixture output to its expected value for " +
			slug +
			".\n",
	);
	const acceptance = ENCODER.encode(
		"# fixture bytes for " +
			slug +
			"\n" +
			"t_A1() { test -f fixture-output.txt; }\n",
	);
	return { intent, acceptance };
}

export async function createApprovalFixtureDriver(): Promise<ApprovalFixtureDriver> {
	const root = mkdtempSync(join(tmpdir(), "kogen-xspec-approval-"));
	const home = join(root, "home");
	const origin = join(root, "origin");
	const checkout = join(root, "checkout");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(origin, { mode: 0o700 });
	const processPort = fixtureProcessPort();
	const executable = Bun.which("git");
	if (executable === null) throw new Error("Git is unavailable");
	const baseEnvironment = fixtureEnvironment(home, root);
	const git = createPublicGitPort(processPort, {
		executable,
		environment: baseEnvironment,
	});
	const plainGit: GitPort = git;
	const runGit = async (
		repository: string,
		argv: readonly string[],
		stdin?: Uint8Array,
		port: GitPort = plainGit,
	): Promise<string> => {
		const result = await port.command({
			repository,
			argv,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: 30_000,
			outputLimitBytes: 128 * 1024,
		});
		if (!result.ok) throw new Error(result.error.message);
		return processOutput(result.value, argv[0] ?? "command");
	};
	const initialSources = new Map<string, FixtureSourceBytes>();
	for (const slug of DEFAULT_SLUGS)
		initialSources.set(slug, defaultSource(slug));
	await runGit(origin, ["init", "--initial-branch=main", "."]);
	await runGit(origin, ["config", "user.name", "Kogen Fixture"]);
	await runGit(origin, ["config", "user.email", "fixture@kogen.invalid"]);
	await runGit(origin, ["config", "commit.gpgsign", "false"]);
	await runGit(origin, ["config", "core.hooksPath", "/dev/null"]);
	for (const [slug, source] of initialSources) {
		const intentFile = absoluteFixturePath(origin, sourcePath(slug));
		const acceptanceFile = absoluteFixturePath(origin, acceptancePath(slug));
		mkdirSync(join(intentFile, ".."), { recursive: true, mode: 0o700 });
		mkdirSync(join(acceptanceFile, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(intentFile, source.intent, { mode: 0o600 });
		writeFileSync(acceptanceFile, source.acceptance, { mode: 0o600 });
	}
	await runGit(origin, ["add", "--", ".kogen"]);
	await runGit(origin, ["commit", "--message", "Fixture base"]);
	const baseSha = objectId(
		await runGit(origin, ["rev-parse", "--verify", "HEAD"]),
	);
	const baseTree = objectId(
		await runGit(origin, ["rev-parse", "--verify", "HEAD^{tree}"]),
	);
	await runGit(root, ["clone", origin, checkout]);
	for (const repository of [origin, checkout]) {
		await runGit(repository, ["config", "user.name", "Kogen Fixture"]);
		await runGit(repository, ["config", "user.email", "fixture@kogen.invalid"]);
		await runGit(repository, ["config", "commit.gpgsign", "false"]);
		await runGit(repository, ["config", "core.hooksPath", "/dev/null"]);
	}
	let readMutation: FixtureLateMutation | null = null;
	let logicalNow = CLOCK_EPOCH;
	const filesystem = fixtureFileSystem(checkout, () => readMutation);
	const sourceAbsolutePath = (slug: string, source: "intent" | "acceptance") =>
		absoluteFixturePath(
			checkout,
			source === "intent" ? sourcePath(slug) : acceptancePath(slug),
		);
	const readSources = (slug: string): FixtureSourceBytes => {
		const intent = readFileSync(sourceAbsolutePath(slug, "intent"));
		const acceptance = readFileSync(sourceAbsolutePath(slug, "acceptance"));
		return {
			intent: new Uint8Array(intent),
			acceptance: new Uint8Array(acceptance),
		};
	};
	const writeSources = (slug: string, source: FixtureSourceBytes): void => {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug))
			throw new Error("fixture slug is invalid");
		const intentFile = sourceAbsolutePath(slug, "intent");
		const acceptanceFile = sourceAbsolutePath(slug, "acceptance");
		mkdirSync(join(intentFile, ".."), { recursive: true, mode: 0o700 });
		mkdirSync(join(acceptanceFile, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(intentFile, source.intent, { mode: 0o600 });
		writeFileSync(acceptanceFile, source.acceptance, { mode: 0o600 });
	};
	const recordSources = async (
		slug: string,
		source: FixtureSourceBytes,
	): Promise<void> => {
		writeSources(slug, source);
		const paths = [sourcePath(slug), acceptancePath(slug)];
		await runGit(checkout, ["add", "-f", "--", ...paths]);
		const status = await runGit(checkout, [
			"status",
			"--porcelain",
			"--",
			...paths,
		]);
		if (status.length === 0) return;
		await runGit(checkout, [
			"commit",
			"--only",
			"--message",
			`Shape fixture ${slug}`,
			"--",
			...paths,
		]);
	};
	const removeAcceptance = (slug: string): void => {
		try {
			rmSync(sourceAbsolutePath(slug, "acceptance"));
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
		}
	};
	const configureIdentity = async (identity: string | null): Promise<void> => {
		const parsed = identity === null ? null : parseIdentity(identity);
		if (parsed === null) {
			for (const repository of [origin, checkout]) {
				for (const key of ["user.name", "user.email"]) {
					const result = await git.command({
						repository,
						argv: ["config", "--unset-all", key],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 4096,
					});
					if (!result.ok) throw new Error(result.error.message);
					if (result.value.timedOut)
						throw new Error("Git config identity reset timed out");
				}
			}
			return;
		}
		for (const repository of [origin, checkout]) {
			await runGit(repository, ["config", "user.name", parsed.name]);
			await runGit(repository, ["config", "user.email", parsed.email]);
		}
	};
	const reset = async (): Promise<void> => {
		readMutation = null;
		logicalNow = CLOCK_EPOCH;
		await runGit(checkout, ["reset", "--hard", baseSha]);
		await runGit(checkout, ["clean", "-fdx"]);
		const refs = await runGit(origin, [
			"for-each-ref",
			"--format=%(refname)",
			"refs/kogen/",
		]);
		for (const ref of refs.split("\n").filter((value) => value.length > 0))
			await runGit(origin, ["update-ref", "--no-deref", "-d", ref]);
		for (const [slug, source] of initialSources) writeSources(slug, source);
		await configureIdentity("Kogen Fixture <fixture@kogen.invalid>");
	};
	const approvalRef = async (
		slug: string,
	): Promise<FixtureApprovalRef | null> => {
		const name = `refs/kogen/intents/${slug}`;
		const target = await runGit(origin, [
			"rev-parse",
			"--verify",
			"--quiet",
			name,
		]).catch(() => "");
		if (target.length === 0) return null;
		const commit = objectId(target);
		const raw = await runGit(origin, [
			"show",
			"-s",
			"--format=%P%n%(trailers:key=Kogen-Approved-Hash,valueonly)",
			commit,
		]);
		const [parentText = "", hashText = ""] = raw.split("\n");
		return {
			commit,
			approvalSha256: /^[0-9a-f]{64}$/u.test(hashText) ? hashText : "",
			parent: parentText.length === 0 ? null : objectId(parentText),
		};
	};
	const approve = async (
		request: FixtureApprovalRequest,
	): Promise<
		ReturnType<typeof commitApprovalPackage> extends Promise<infer R>
			? R
			: never
	> => {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.slug))
			throw new Error("fixture slug is invalid");
		const source = readSources(request.slug);
		const intentSha256 = hashIntentBytes(source.intent);
		const approvalSha256 = hashApprovalBytes(source.intent, source.acceptance);
		const priorRef = await approvalRef(request.slug);
		const actualGit = git;
		let injectedRaces = 0;
		const casGit: GitPort = {
			async command(gitRequest: GitRequest) {
				const ref = `refs/kogen/intents/${request.slug}`;
				if (
					request.casRace !== undefined &&
					injectedRaces < request.casRace &&
					gitRequest.argv[0] === "update-ref" &&
					gitRequest.argv[2] === ref &&
					gitRequest.argv[1] === "--no-deref"
				) {
					const expected = gitRequest.argv.at(-1);
					if (expected === undefined)
						return {
							ok: false as const,
							error: error("invalid_input", "missing CAS parent"),
						};
					const tree = baseTree;
					const competitorArgs = ["commit-tree", tree];
					if (!/^0+$/u.test(expected)) competitorArgs.push("-p", expected);
					competitorArgs.push("-F", "-");
					const competitor = await runGit(
						origin,
						competitorArgs,
						ENCODER.encode(
							"fixture concurrent CAS writer " +
								String(injectedRaces + 1) +
								"\n",
						),
					);
					const moved = await actualGit.command({
						repository: origin,
						argv: ["update-ref", "--no-deref", ref, competitor, expected],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 4096,
					});
					if (!moved.ok || moved.value.timedOut || moved.value.exitCode !== 0)
						throw new Error("fixture could not inject the competing ref move");
					injectedRaces += 1;
				}
				return actualGit.command(gitRequest);
			},
		};
		const baseline = request.baseline ?? "green";
		const acceptance = {
			name: "fixture acceptance",
			status: "green" as const,
			exit_status: 0,
			timed_out: false,
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
		};
		const preflight: ApprovalPreflightSuccess = {
			kind: "ready_to_approve",
			exitCode: 0,
			approvalSha256,
			intentSha256,
			checkedBaseTree: baseTree,
			checkBaseline: [
				{
					name: "fixture baseline",
					status: baseline,
					exit_status: baseline === "green" ? 0 : 1,
					findings: [],
				},
			],
			acceptanceChecks: [acceptance],
			warnings: [],
			warningText: "",
			card: null,
			baselineCacheKey: null,
			baselineCacheHit: false,
			checkoutTree: baseTree,
			checkedInScratch: true,
		};
		const witness =
			request.witness === undefined
				? undefined
				: {
						verdict: request.witness.verdict,
						commit: baseSha,
						diff_sha256: request.witness.diff_sha256,
						base_sha: baseSha,
					};
		filesystem.resetReads();
		readMutation = request.lateMutation ?? null;
		const result = await commitApprovalPackage({
			origin,
			checkout,
			slug: request.slug,
			intentPath: sourcePath(request.slug),
			acceptancePath: acceptancePath(request.slug),
			targetBranch: "main",
			baseSha,
			givenHash: request.givenHash,
			...(request.by === undefined ? {} : { by: request.by }),
			preflight,
			protectedManifest: {
				[sourcePath(request.slug)]: intentSha256,
				[acceptancePath(request.slug)]: hashIntentBytes(source.acceptance),
			},
			...(request.witnessRequired === undefined
				? {}
				: { witnessRequired: request.witnessRequired }),
			...(witness === undefined ? {} : { witness }),
			filesystem,
			git: casGit,
			clock: {
				unixMilliseconds() {
					logicalNow += 1_000;
					return logicalNow;
				},
			},
		});
		readMutation = null;
		if (request.casRace === 2 && !result.ok && priorRef !== null) {
			const current = await actualGit.command({
				repository: origin,
				argv: [
					"rev-parse",
					"--verify",
					"--quiet",
					`refs/kogen/intents/${request.slug}`,
				],
				timeoutMilliseconds: 30_000,
				outputLimitBytes: 4096,
			});
			if (
				current.ok &&
				!current.value.timedOut &&
				current.value.exitCode === 0
			) {
				const currentId = DECODER.decode(current.value.stdout).trimEnd();
				const rollback = await actualGit.command({
					repository: origin,
					argv:
						priorRef === null
							? [
									"update-ref",
									"--no-deref",
									"-d",
									`refs/kogen/intents/${request.slug}`,
									currentId,
								]
							: [
									"update-ref",
									"--no-deref",
									`refs/kogen/intents/${request.slug}`,
									priorRef.commit,
									currentId,
								],
					timeoutMilliseconds: 30_000,
					outputLimitBytes: 4096,
				});
				if (
					!rollback.ok ||
					rollback.value.timedOut ||
					rollback.value.exitCode !== 0
				)
					throw new Error(
						"fixture could not roll back injected competing ref moves",
					);
			}
		}
		return result;
	};
	const remove = (input: {
		readonly slug: string;
		readonly force: boolean;
		readonly lifecycle: IntentRemoveLifecycle;
	}) =>
		removeIntent({
			origin,
			checkout,
			slug: input.slug,
			acceptancePath: acceptancePath(input.slug),
			force: input.force,
			filesystem,
			git,
			lifecycle: {
				async inspect() {
					return { ok: true as const, value: input.lifecycle };
				},
			},
		});
	const driver: ApprovalFixtureDriver = {
		root,
		origin,
		checkout,
		git,
		baseSha,
		baseTree,
		reset,
		writeSources,
		recordSources,
		readSources,
		removeAcceptance,
		configureIdentity,
		approve,
		remove,
		approvalRef,
		gitText: runGit,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
	await driver.reset();
	return driver;
}

export function sourceHashes(source: FixtureSourceBytes): {
	readonly intentSha256: string;
	readonly approvalSha256: string;
} {
	return {
		intentSha256: hashIntentBytes(source.intent),
		approvalSha256: hashApprovalBytes(source.intent, source.acceptance),
	};
}

export function fixtureIntentBytes(slug: string, marker: string): Uint8Array {
	return ENCODER.encode(
		"---\n" +
			"title: Fixture " +
			slug +
			" Intent\n" +
			"size: small\n" +
			"domains: [app]\n" +
			"---\n" +
			"Update the fixture output to contain its expected value.\n\n" +
			"## Acceptance\n" +
			"- A1: The fixture output contains its expected value.\n\n" +
			"## Verify\n" +
			"- A1: test\n\n" +
			"## Request\n" +
			"Set the fixture output to its expected value for " +
			slug +
			".\n" +
			"Fixture identity: " +
			marker +
			"\n",
	);
}

export function fixtureAcceptanceBytes(
	slug: string,
	marker: string,
): Uint8Array {
	return ENCODER.encode(
		"# fixture bytes for " +
			slug +
			" / " +
			marker +
			"\n" +
			"t_A1() { test -f fixture-output.txt; }\n",
	);
}

export function fixtureSymbolForDigest(
	actualDigest: string,
	identity: string,
): { readonly identity: string; readonly digest: string } {
	if (!/^[0-9a-f]{64}$/u.test(actualDigest) || identity.length === 0)
		throw new Error("invalid symbolic digest mapping");
	return { identity, digest: actualDigest };
}

export function fixtureRootIsAbsolute(path: string): boolean {
	return isAbsolute(path);
}
