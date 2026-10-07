import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	createGitPort,
	createPublicGitPort,
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
	GIT_MAX_TIMEOUT_MS,
	runGitCommand,
} from "../../packages/core/src/git/command";
import {
	publicApproverLabel,
	readPublicGitIdentity,
} from "../../packages/core/src/git/identity";
import {
	createPrivateGitRepository,
	type GitObjectFormat,
} from "../../packages/core/src/git/repository";
import {
	type HostBridge,
	hostHelperName,
	startHostBridge,
} from "../../packages/core/src/process/host";
import { superviseProcess } from "../../packages/core/src/process/supervise";

const root = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
let scratch = "";
let cliPath = "";
let bridge: HostBridge | null = null;
let gitExecutable = "";

setDefaultTimeout(90_000);

function compile(sources: string[], output: string): void {
	const result = spawnSync(
		compiler,
		[
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-I",
			"native",
			...sources,
			"-o",
			output,
		],
		{ cwd: root, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`host helper compile failed: ${result.stderr}`);
}

function supervisedProcessPort(activeBridge: HostBridge): ProcessPort {
	return {
		async run(request: ProcessRequest) {
			const stdoutLimit = Math.ceil(request.outputLimitBytes * 0.75);
			const stderrLimit = request.outputLimitBytes - stdoutLimit;
			const response = await superviseProcess(activeBridge, {
				argv: request.argv,
				cwd: request.cwd,
				environment: request.env,
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				timeoutMs: request.timeoutMilliseconds,
				stdoutTailBytes: stdoutLimit,
				stderrTailBytes: stderrLimit,
			});
			const value: ProcessResult = {
				exitCode: response.exitCode,
				signal: response.signal === null ? null : String(response.signal),
				stdout: response.stdoutTail,
				stderr: response.stderrTail,
				timedOut: response.termination === "timed-out",
			};
			return { ok: true, value };
		},
	};
}

function requireGit(): string {
	const executable = Bun.which("git");
	if (executable === null) throw new Error("Git is not available in PATH");
	return resolve(executable);
}

function testEnvironment(home = scratch): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin",
		HOME: home,
		LANG: "C",
		LC_ALL: "C",
		TMPDIR: scratch,
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
}

function currentPort(): ProcessPort {
	if (bridge === null) throw new Error("test supervisor is not running");
	return supervisedProcessPort(bridge);
}

async function mustSucceed(
	port: ReturnType<typeof createGitPort>,
	repository: string,
	argv: readonly string[],
	options: { stdin?: Uint8Array; timeoutMilliseconds?: number } = {},
): Promise<ProcessResult> {
	const result = await port.command({
		repository,
		argv,
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
		timeoutMilliseconds: options.timeoutMilliseconds ?? GIT_DEFAULT_TIMEOUT_MS,
		outputLimitBytes: 16 * 1024,
	});
	if (!result.ok)
		throw new Error(
			`Git port failed: ${result.error.message}; cause=${String(result.error.cause)}; helper=${bridge?.stderrText ?? ""}`,
		);
	if (result.value.timedOut || result.value.exitCode !== 0) {
		throw new Error(
			"Git command failed: " +
				argv.join(" ") +
				"; exit=" +
				result.value.exitCode +
				"; stderr=" +
				new TextDecoder().decode(result.value.stderr),
		);
	}
	return result.value;
}

async function createSourceRepository(
	format: GitObjectFormat,
	name: string,
	publicPort = createPublicGitPort(currentPort(), {
		executable: gitExecutable,
		environment: testEnvironment(),
	}),
): Promise<string> {
	const repository = join(scratch, name);
	mkdirSync(repository, { mode: 0o700 });
	await mustSucceed(publicPort, repository, [
		"init",
		"--initial-branch=main",
		`--object-format=${format}`,
		".",
	]);
	await mustSucceed(publicPort, repository, [
		"config",
		"user.name",
		"Git Port Fixture",
	]);
	await mustSucceed(publicPort, repository, [
		"config",
		"user.email",
		"git-port@example.invalid",
	]);
	await mustSucceed(publicPort, repository, [
		"config",
		"commit.gpgsign",
		"false",
	]);
	writeFileSync(join(repository, "tracked.txt"), "base\n");
	await mustSucceed(publicPort, repository, ["add", "tracked.txt"]);
	await mustSucceed(publicPort, repository, ["commit", "-F", "-"], {
		stdin: new TextEncoder().encode("base commit\n"),
	});
	return repository;
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-git-port-"));
	cliPath = join(scratch, "kogen");
	writeFileSync(cliPath, "test executable placeholder\n", { mode: 0o700 });
	compile(
		[
			"tests/custody/supervisor-host.c",
			"native/protocol.c",
			"native/supervisor.c",
		],
		join(scratch, hostHelperName()),
	);
	gitExecutable = requireGit();
	bridge = await startHostBridge({ compiledExecutablePath: cliPath });
});

afterAll(async () => {
	if (bridge !== null) {
		await bridge.close();
		bridge = null;
	}
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("Git commands use explicit argv/stdin and enforce finite limits", async () => {
	let captured: ProcessRequest | undefined;
	const fake: ProcessPort = {
		async run(request) {
			captured = request;
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new TextEncoder().encode("ok\n"),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const stdin = new Uint8Array([0, 1, 2, 255]);
	const result = await runGitCommand(
		fake,
		{
			repository: "/repo",
			argv: ["hash-object", "--stdin"],
			stdin,
		},
		{
			executable: gitExecutable,
			environment: {
				PATH: "/usr/bin:/bin",
				HOME: "/isolated-home",
				GIT_DIR: "/hostile/other.git",
				GIT_WORK_TREE: "/hostile/worktree",
				GIT_INDEX_FILE: "/hostile/index",
				GIT_OBJECT_DIRECTORY: "/hostile/objects",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: "/hostile/hooks",
				GIT_TRACE: "/tmp/hostile-trace",
			},
		},
	);
	expect(result.ok).toBe(true);
	expect(captured).toBeDefined();
	expect(captured?.argv[0]).toBe(gitExecutable);
	expect(captured?.argv).toContain("--no-pager");
	expect(captured?.argv).toContain("core.hooksPath=/dev/null");
	expect(captured?.argv).toContain("core.fsmonitor=false");
	expect(captured?.argv).toContain("hash-object");
	expect(captured?.cwd).toBe("/repo");
	expect(captured?.stdin).not.toBe(stdin);
	expect(captured?.stdin).toEqual(stdin);
	expect(captured?.timeoutMilliseconds).toBe(GIT_DEFAULT_TIMEOUT_MS);
	expect(captured?.outputLimitBytes).toBe(64 * 1024);
	expect(captured?.env).not.toHaveProperty("GIT_DIR");
	expect(captured?.env).not.toHaveProperty("GIT_WORK_TREE");
	expect(captured?.env).not.toHaveProperty("GIT_INDEX_FILE");
	expect(captured?.env).not.toHaveProperty("GIT_OBJECT_DIRECTORY");
	expect(captured?.env).not.toHaveProperty("GIT_CONFIG_COUNT");
	expect(captured?.env).not.toHaveProperty("GIT_CONFIG_KEY_0");
	expect(captured?.env).not.toHaveProperty("GIT_TRACE");
	expect(captured?.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	const commitRequest = await runGitCommand(fake, {
		repository: "/repo",
		argv: ["commit", "-F", "-"],
		stdin: new TextEncoder().encode("message over stdin\n"),
	});
	expect(commitRequest.ok).toBe(true);
	expect(captured?.argv).toContain("--no-verify");
	expect(captured?.stdin).toEqual(
		new TextEncoder().encode("message over stdin\n"),
	);
	const hookOverride = await runGitCommand(fake, {
		repository: "/repo",
		argv: ["commit", "--verify", "-F", "-"],
	});
	expect(hookOverride.ok).toBe(false);

	const tooMuchOutput: ProcessPort = {
		async run() {
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new Uint8Array(GIT_MAX_OUTPUT_LIMIT_BYTES),
					stderr: new Uint8Array(1),
					timedOut: false,
				},
			};
		},
	};
	const rejectedOutput = await runGitCommand(tooMuchOutput, {
		repository: "/repo",
		argv: ["status"],
		outputLimitBytes: 8,
	});
	expect(rejectedOutput.ok).toBe(false);
	if (!rejectedOutput.ok)
		expect(rejectedOutput.error.message).toContain(
			"beyond the requested bound",
		);

	const rejectedArgument = await runGitCommand(fake, {
		repository: "/repo",
		argv: ["config", "bad\0value"],
	});
	expect(rejectedArgument.ok).toBe(false);
	const rejectedTimeout = await runGitCommand(fake, {
		repository: "/repo",
		argv: ["status"],
		timeoutMilliseconds: GIT_MAX_TIMEOUT_MS + 1,
	});
	expect(rejectedTimeout.ok).toBe(false);
});

test("private metadata follows both Git object formats", async () => {
	const ids: string[] = [];
	for (const format of ["sha1", "sha256"] as const) {
		const sourceRepository = await createSourceRepository(
			format,
			`source-${format}`,
		);
		const gitDirectory = join(scratch, `metadata-${format}`);
		mkdirSync(gitDirectory, { mode: 0o700 });
		const metadata = await createPrivateGitRepository(currentPort(), {
			sourceRepository,
			gitDirectory,
			workTree: sourceRepository,
			executable: gitExecutable,
			environment: testEnvironment(),
		});
		expect(metadata.ok).toBe(true);
		if (!metadata.ok) throw new Error(metadata.error.message);
		expect(metadata.value.objectFormat).toBe(format);
		const objectId = await metadata.value.hashObject(
			new TextEncoder().encode("same bytes\n"),
		);
		if (!objectId.ok)
			throw new Error(`private hash failed: ${objectId.error.message}`);
		expect(objectId.ok).toBe(true);
		expect(objectId.value).toMatch(/^[0-9a-f]+$/);
		expect(objectId.value).toHaveLength(format === "sha1" ? 40 : 64);
		ids.push(objectId.value);
	}
	expect(ids[0]).not.toBe(ids[1]);
});

test("private metadata ignores hostile workspace hooks, filters, fsmonitor and excludes", async () => {
	const sourceRepository = await createSourceRepository(
		"sha1",
		"hostile-worktree",
	);
	const markerDirectory = join(scratch, "hostile-markers");
	mkdirSync(markerDirectory, { mode: 0o700 });
	const hookMarker = join(markerDirectory, "hook-ran");
	const filterMarker = join(markerDirectory, "filter-ran");
	const fsmonitorMarker = join(markerDirectory, "fsmonitor-ran");
	const textconvMarker = join(markerDirectory, "textconv-ran");
	const hooksDirectory = join(sourceRepository, ".git", "hooks");
	mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 });
	const preCommit = join(hooksDirectory, "pre-commit");
	writeFileSync(preCommit, `#!/bin/sh\ntouch '${hookMarker}'\n`, {
		mode: 0o700,
	});
	chmodSync(preCommit, 0o700);
	const filterCommand = `sh -c 'touch ${filterMarker}; cat'`;
	const fsmonitorCommand = `sh -c 'touch ${fsmonitorMarker}; exit 0'`;
	const textconvCommand = `sh -c 'touch ${textconvMarker}; cat'`;
	const publicPort = createPublicGitPort(currentPort(), {
		executable: gitExecutable,
		environment: testEnvironment(),
	});
	await mustSucceed(publicPort, sourceRepository, [
		"config",
		"core.hooksPath",
		hooksDirectory,
	]);
	await mustSucceed(publicPort, sourceRepository, [
		"config",
		"core.fsmonitor",
		fsmonitorCommand,
	]);
	await mustSucceed(publicPort, sourceRepository, [
		"config",
		"filter.evil.clean",
		filterCommand,
	]);
	await mustSucceed(publicPort, sourceRepository, [
		"config",
		"diff.evil.textconv",
		textconvCommand,
	]);
	mkdirSync(join(sourceRepository, ".git", "info"), { recursive: true });
	writeFileSync(
		join(sourceRepository, ".git", "info", "exclude"),
		"hidden.txt\n",
	);
	writeFileSync(
		join(sourceRepository, ".git", "info", "attributes"),
		"*.txt filter=evil diff=evil\n",
	);
	writeFileSync(
		join(sourceRepository, ".gitattributes"),
		"*.txt filter=evil diff=evil\n",
	);
	writeFileSync(join(sourceRepository, "tracked.txt"), "edited\n");
	writeFileSync(join(sourceRepository, "hidden.txt"), "secret\n");
	const decoyDirectory = join(scratch, "redirected.git");
	const hostileEnvironment = {
		...testEnvironment(),
		GIT_DIR: decoyDirectory,
		GIT_WORK_TREE: scratch,
		GIT_INDEX_FILE: join(scratch, "decoy-index"),
		GIT_OBJECT_DIRECTORY: join(scratch, "decoy-objects"),
		GIT_ALTERNATE_OBJECT_DIRECTORIES: decoyDirectory,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: hooksDirectory,
	};
	const metadataDirectory = join(scratch, "hostile-metadata");
	mkdirSync(metadataDirectory, { mode: 0o700 });
	const privateRepository = await createPrivateGitRepository(currentPort(), {
		sourceRepository,
		gitDirectory: metadataDirectory,
		workTree: sourceRepository,
		executable: gitExecutable,
		environment: hostileEnvironment,
	});
	expect(privateRepository.ok).toBe(true);
	if (!privateRepository.ok) throw new Error(privateRepository.error.message);
	const privatePort = createGitPort(currentPort(), {
		executable: gitExecutable,
		environment: hostileEnvironment,
	});
	await mustSucceed(privatePort, sourceRepository, [
		`--git-dir=${metadataDirectory}`,
		`--work-tree=${sourceRepository}`,
		"fetch",
		"--no-tags",
		sourceRepository,
		"HEAD:refs/heads/main",
	]);
	await mustSucceed(privatePort, sourceRepository, [
		`--git-dir=${metadataDirectory}`,
		`--work-tree=${sourceRepository}`,
		"symbolic-ref",
		"HEAD",
		"refs/heads/main",
	]);
	await mustSucceed(privatePort, sourceRepository, [
		`--git-dir=${metadataDirectory}`,
		`--work-tree=${sourceRepository}`,
		"read-tree",
		"HEAD",
	]);
	const privateCommand = (argv: readonly string[], stdin?: Uint8Array) =>
		privatePort.command({
			repository: sourceRepository,
			argv: [
				`--git-dir=${metadataDirectory}`,
				`--work-tree=${sourceRepository}`,
				...argv,
			],
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 16 * 1024,
		});
	const status = await privateCommand([
		"status",
		"--short",
		"--untracked-files=all",
	]);
	expect(status.ok).toBe(true);
	if (!status.ok) throw new Error(status.error.message);
	expect(new TextDecoder().decode(status.value.stdout)).toContain("hidden.txt");
	const add = await privateCommand(["add", "-A"]);
	expect(add.ok).toBe(true);
	if (!add.ok) throw new Error(add.error.message);
	const stagedHidden = await privateCommand(["show", ":hidden.txt"]);
	expect(stagedHidden.ok).toBe(true);
	if (!stagedHidden.ok) throw new Error(stagedHidden.error.message);
	expect(new TextDecoder().decode(stagedHidden.value.stdout)).toBe("secret\n");
	const stagedTracked = await privateCommand(["show", ":tracked.txt"]);
	expect(stagedTracked.ok).toBe(true);
	if (!stagedTracked.ok) throw new Error(stagedTracked.error.message);
	expect(new TextDecoder().decode(stagedTracked.value.stdout)).toBe("edited\n");
	const diff = await privateCommand(["diff", "HEAD"]);
	expect(diff.ok).toBe(true);
	if (!diff.ok) throw new Error(diff.error.message);
	expect(existsSync(textconvMarker)).toBe(false);
	const commit = await privateCommand(
		["commit", "-F", "-"],
		new TextEncoder().encode("private metadata commit\n"),
	);
	expect(commit.ok).toBe(true);
	if (!commit.ok) throw new Error(commit.error.message);
	expect(commit.value.timedOut).toBe(false);
	expect(existsSync(hookMarker)).toBe(false);
	expect(existsSync(filterMarker)).toBe(false);
	expect(existsSync(fsmonitorMarker)).toBe(false);
	expect(existsSync(textconvMarker)).toBe(false);
	const landedHidden = await privateCommand(["show", "HEAD:hidden.txt"]);
	expect(landedHidden.ok).toBe(true);
	if (!landedHidden.ok) throw new Error(landedHidden.error.message);
	expect(new TextDecoder().decode(landedHidden.value.stdout)).toBe("secret\n");
});

test("public identity honors global config and a hung signing child is bounded", async () => {
	const publicHome = join(scratch, "public-home");
	mkdirSync(publicHome, { mode: 0o700 });
	const signingScript = join(publicHome, "slow-signer");
	const signerStarted = join(publicHome, "signer-started");
	writeFileSync(
		signingScript,
		"#!/bin/sh\nprintf '%s\\n' \"$$\" > '" +
			signerStarted +
			"'\nexec /bin/sleep 30\n",
		{ mode: 0o700 },
	);
	chmodSync(signingScript, 0o700);
	const globalConfig = join(publicHome, ".gitconfig");
	writeFileSync(
		globalConfig,
		"[user]\n\tname = Public Fixture\n\temail = public@example.invalid\n\tsigningkey = fixture-key\n" +
			"[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = " +
			signingScript +
			"\n",
	);
	const publicEnvironment = {
		...testEnvironment(publicHome),
		GIT_CONFIG_GLOBAL: globalConfig,
	};
	const port = currentPort();
	const publicPort = createPublicGitPort(port, {
		executable: gitExecutable,
		environment: publicEnvironment,
	});
	const identity = await readPublicGitIdentity(port, publicHome, {
		executable: gitExecutable,
		environment: publicEnvironment,
	});
	expect(identity.ok).toBe(true);
	if (!identity.ok) throw new Error(identity.error.message);
	expect(identity.value.ident).toBe("Public Fixture <public@example.invalid>");
	expect(publicApproverLabel("  ", identity.value)).toEqual({
		ok: true,
		value: "Public Fixture <public@example.invalid>",
	});
	expect(publicApproverLabel("Approved by Ada", identity.value)).toEqual({
		ok: true,
		value: "Approved by Ada",
	});
	expect(publicApproverLabel("Ada\nInjected", identity.value).ok).toBe(false);

	const repository = join(publicHome, "signed-repository");
	mkdirSync(repository, { mode: 0o700 });
	await mustSucceed(publicPort, repository, [
		"init",
		"--initial-branch=main",
		"--object-format=sha1",
		".",
	]);
	await mustSucceed(publicPort, repository, [
		"config",
		"commit.gpgsign",
		"true",
	]);
	await mustSucceed(publicPort, repository, [
		"config",
		"gpg.format",
		"openpgp",
	]);
	writeFileSync(join(repository, "signed.txt"), "signed\n");
	await mustSucceed(publicPort, repository, ["add", "signed.txt"]);
	const commit = await publicPort.command({
		repository,
		argv: ["commit", "-F", "-"],
		stdin: new TextEncoder().encode("sign this commit\n"),
		timeoutMilliseconds: 3000,
		outputLimitBytes: 16 * 1024,
	});
	expect(commit.ok).toBe(true);
	if (!commit.ok) throw new Error(commit.error.message);
	expect(commit.value.timedOut).toBe(true);
	expect(existsSync(signerStarted)).toBe(true);
	const signerPid = Number(readFileSync(signerStarted, "utf8").trim());
	expect(Number.isInteger(signerPid)).toBe(true);
	if (Number.isInteger(signerPid) && signerPid > 0) {
		const probe = spawnSync("/bin/kill", ["-0", String(signerPid)]);
		expect(probe.status).not.toBe(0);
	}
});
