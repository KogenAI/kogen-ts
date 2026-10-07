import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type {
	ProcessPort,
	ProcessRequest,
} from "../../packages/core/src/contracts/ports";
import {
	buildChildEnvironment,
	ChildEnvironmentError,
	MISE_ENV_TIMEOUT_MS,
} from "../../packages/core/src/process/environment";
import { runPrivateShellScript } from "../../packages/core/src/process/script";

let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-environment-"));
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function successfulProcess(stdout = new Uint8Array()): ProcessPort {
	return {
		async run() {
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout,
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
}

test("allowlisted base environment excludes host secrets and Kogen runtime paths", async () => {
	const runtimePath = dirname(process.execPath);
	const environment = await buildChildEnvironment({
		projectRoot: "/work/project",
		workspace: "/work/project",
		runDirectory: "/state/runs/one",
		miseBinaryPath: null,
		hostEnvironment: {
			PATH: [runtimePath, "/usr/bin", "/tools/bin"].join(delimiter),
			HOME: "/home/worker",
			SHELL: "/bin/zsh",
			HTTP_PROXY: "http://proxy.invalid",
			https_proxy: "http://lower-proxy.invalid",
			GIT_CONFIG_GLOBAL: "/dev/null",
			MISE_ENV_CACHE: "0",
			MIX_HOME: "/home/worker/.mix",
			HEX_HOME: "/home/worker/.hex",
			TMPDIR: "/host/tmp",
			OPENAI_API_KEY: "host-secret",
			KOGEN_PROVIDER_URL: "http://fake.invalid",
			CODEX_HOME: "/host/runtime/codex",
			BUN_INSTALL: dirname(runtimePath),
			NODE_OPTIONS: "--require /host/secret.js",
		},
		process: successfulProcess(),
	});

	expect(environment.environment).toEqual({
		PATH: ["/usr/bin", "/tools/bin"].join(delimiter),
		HOME: "/home/worker",
		SHELL: "/bin/zsh",
		HTTP_PROXY: "http://proxy.invalid",
		https_proxy: "http://lower-proxy.invalid",
		GIT_CONFIG_GLOBAL: "/dev/null",
		MISE_ENV_CACHE: "0",
		TMPDIR: "/state/runs/one/tmp",
	});
	expect(environment.environment).not.toHaveProperty("OPENAI_API_KEY");
	expect(environment.environment).not.toHaveProperty("KOGEN_PROVIDER_URL");
	expect(environment.environment).not.toHaveProperty("CODEX_HOME");
	expect(environment.environment).not.toHaveProperty("BUN_INSTALL");
	expect(environment.environment).not.toHaveProperty("NODE_OPTIONS");
	expect(environment.environment).not.toHaveProperty("MIX_HOME");
	expect(environment.environment).not.toHaveProperty("HEX_HOME");

	const exunitEnvironment = await buildChildEnvironment({
		projectRoot: "/work/project",
		workspace: "/work/project",
		runDirectory: "/state/runs/two",
		adapter: "exunit",
		miseBinaryPath: null,
		runtimePaths: [],
		hostEnvironment: { MIX_HOME: "/stack/mix", HEX_HOME: "/stack/hex" },
		process: successfulProcess(),
	});
	expect(exunitEnvironment.environment).toMatchObject({
		MIX_HOME: "/stack/mix",
		HEX_HOME: "/stack/hex",
	});
});

test("mise environment is isolated and project PATH overrides it verbatim", async () => {
	let miseRequest: ProcessRequest | undefined;
	const processPort: ProcessPort = {
		async run(request) {
			miseRequest = request;
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new TextEncoder().encode(
						JSON.stringify({
							PATH: "/toolchain/bin:/opt/kogen-runtime/bin:/usr/bin",
							TASK_SETTING: "from-mise",
							MISE_STATE_DIR: "/host/state",
							MISE_CACHE_DIR: "/host/cache",
							MISE_TRUSTED_CONFIG_PATHS: "/host/trusted",
							KOGEN_TIME_SCALE: "0.01",
						}),
					),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const result = await buildChildEnvironment({
		projectRoot: "/work/project",
		workspace: "/work/run-1/workspace",
		runDirectory: "/state/runs/run-1",
		miseBinaryPath: "/mise/bin/mise",
		runtimePaths: ["/opt/kogen-runtime/bin"],
		projectEnvironment: {
			PATH: "./project-tools:/usr/bin",
			TASK_SETTING: "from-project",
		},
		hostEnvironment: {
			PATH: "/mise/bin:/opt/kogen-runtime/bin:/usr/bin",
			MISE_TRUSTED_CONFIG_PATHS: "/opt/trusted",
			KOGEN_TIME_SCALE: "0.01",
			OPENAI_API_KEY: "host-secret",
		},
		process: processPort,
	});

	expect(miseRequest).toBeDefined();
	expect(miseRequest?.argv).toEqual([
		"/mise/bin/mise",
		"env",
		"-C",
		"/work/run-1/workspace",
		"--json",
		"--quiet",
	]);
	expect(miseRequest?.cwd).toBe("/work/run-1/workspace");
	expect(miseRequest?.timeoutMilliseconds).toBe(MISE_ENV_TIMEOUT_MS);
	expect(MISE_ENV_TIMEOUT_MS).toBe(30_000);
	expect(miseRequest?.env).toMatchObject({
		TMPDIR: "/state/runs/run-1/tmp",
		MISE_STATE_DIR: "/state/runs/run-1/mise-state",
		MISE_CACHE_DIR: "/state/runs/run-1/mise-cache",
		MISE_TRUSTED_CONFIG_PATHS:
			"/opt/trusted:/work/project:/work/run-1/workspace",
	});
	expect(miseRequest?.env).not.toHaveProperty("OPENAI_API_KEY");
	expect(result.environment).toMatchObject({
		PATH: "./project-tools:/usr/bin",
		TASK_SETTING: "from-project",
		MISE_STATE_DIR: "/state/runs/run-1/mise-state",
		MISE_CACHE_DIR: "/state/runs/run-1/mise-cache",
		MISE_TRUSTED_CONFIG_PATHS:
			"/opt/trusted:/work/project:/work/run-1/workspace",
		TMPDIR: "/state/runs/run-1/tmp",
	});
	expect(result.environment).not.toHaveProperty("KOGEN_TIME_SCALE");
	const misePathWinsWithoutAProjectOverride = await buildChildEnvironment({
		projectRoot: "/work/project",
		workspace: "/work/run-1/workspace",
		runDirectory: "/state/runs/run-1",
		miseBinaryPath: "/mise/bin/mise",
		runtimePaths: ["/opt/kogen-runtime/bin"],
		hostEnvironment: {
			PATH: "/mise/bin:/opt/kogen-runtime/bin:/usr/bin",
		},
		process: processPort,
	});
	expect(misePathWinsWithoutAProjectOverride.environment.PATH).toBe(
		"/mise/bin:/toolchain/bin:/usr/bin",
	);
});

test("project timeout stays unscaled and large script bytes travel in a private file", async () => {
	const runDirectory = join(scratch, "script-run");
	const workingDirectory = join(scratch, "workspace");
	mkdirSync(runDirectory, { mode: 0o700 });
	const scriptBytes = new Uint8Array(300 * 1024).fill(0x78);
	const stdinBytes = new Uint8Array(96 * 1024).fill(0x73);
	let processRequest: ProcessRequest | undefined;
	let savedScriptPath = "";
	const filesystem = {
		async writeFileAtomically(request: {
			readonly root: string;
			readonly path: string;
			readonly bytes: Uint8Array;
			readonly mode: number;
		}) {
			savedScriptPath = join(request.root, request.path);
			writeFileSync(savedScriptPath, request.bytes, { mode: request.mode });
			chmodSync(savedScriptPath, request.mode);
			return { ok: true as const, value: undefined };
		},
	};
	const processPort: ProcessPort = {
		async run(request) {
			processRequest = request;
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const childEnvironment = await buildChildEnvironment({
		projectRoot: workingDirectory,
		workspace: workingDirectory,
		runDirectory,
		miseBinaryPath: null,
		runtimePaths: [],
		hostEnvironment: {
			PATH: "/usr/bin:/bin",
			KOGEN_TIME_SCALE: "0.01",
			OPENAI_API_KEY: "host-secret",
		},
		process: successfulProcess(),
	});
	const result = await runPrivateShellScript(filesystem, processPort, {
		runDirectory,
		workingDirectory,
		script: scriptBytes,
		environment: childEnvironment.environment,
		timeoutMilliseconds: 4321,
		outputLimitBytes: 16 * 1024,
		stdin: stdinBytes,
	});

	expect(result.ok).toBe(true);
	expect(existsSync(savedScriptPath)).toBe(true);
	expect(readFileSync(savedScriptPath)).toEqual(Buffer.from(scriptBytes));
	expect(statSync(savedScriptPath).mode & 0o777).toBe(0o600);
	expect(processRequest).toBeDefined();
	expect(processRequest?.argv).toEqual(["sh", savedScriptPath]);
	expect(
		processRequest?.argv.every(
			(argument) => Buffer.byteLength(argument) <= 4096,
		),
	).toBe(true);
	expect(processRequest?.stdin).toEqual(stdinBytes);
	expect(processRequest?.timeoutMilliseconds).toBe(4321);
	expect(processRequest?.env).not.toHaveProperty("KOGEN_TIME_SCALE");
	expect(processRequest?.env).not.toHaveProperty("OPENAI_API_KEY");
	expect(savedScriptPath).toContain(`${runDirectory}/shell-`);
});

test("project environment rejects KOGEN control variables", async () => {
	await expect(
		buildChildEnvironment({
			projectRoot: "/work/project",
			workspace: "/work/project",
			runDirectory: "/state/runs/three",
			miseBinaryPath: null,
			projectEnvironment: { KOGEN_TIME_SCALE: "100" },
			hostEnvironment: {},
			process: successfulProcess(),
		}),
	).rejects.toBeInstanceOf(ChildEnvironmentError);
});
