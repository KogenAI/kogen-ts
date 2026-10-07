import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	createLinuxSandboxProcessRequest,
	probeLinuxSandbox,
	resolveLinuxSandbox,
} from "../../packages/core/src/sandbox/linux";

const encoder = new TextEncoder();
const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		rmSync(fixture, { recursive: true, force: true });
	}
});

function fixtureDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "kts-sandbox-linux-"));
	fixtures.push(directory);
	return directory;
}

function processResult(
	exitCode: number,
	stdout = "",
	stderr = "",
): ProcessResult {
	return {
		exitCode,
		signal: null,
		stdout: encoder.encode(stdout),
		stderr: encoder.encode(stderr),
		timedOut: false,
	};
}

function fakeProcess(
	response:
		| ProcessResult
		| {
				readonly ok: false;
				readonly error: {
					readonly code:
						| "permission_denied"
						| "not_found"
						| "io"
						| "timeout"
						| "unavailable"
						| "unknown"
						| "cancelled"
						| "conflict"
						| "invalid_input";
					readonly message: string;
					readonly retryable: boolean;
				};
		  },
	requests: ProcessRequest[] = [],
): Pick<ProcessPort, "run"> {
	return {
		run: async (request) => {
			requests.push(request);
			if ("ok" in response) return response;
			return { ok: true, value: response };
		},
	};
}

function executableFixture(): string {
	const directory = fixtureDirectory();
	const path = join(directory, "bwrap");
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

function optionIndex(
	argv: readonly string[],
	option: string,
	value: string,
): number {
	for (let index = 0; index + 1 < argv.length; index += 1) {
		if (argv[index] === option && argv[index + 1] === value) return index;
	}
	return -1;
}

test("capability probe exercises user, pid, ipc and uts namespaces without isolating network", async () => {
	const requests: ProcessRequest[] = [];
	const bwrapPath = executableFixture();
	const probe = await probeLinuxSandbox({
		process: fakeProcess(processResult(0), requests),
		hostPlatform: "linux",
		bwrapPath,
	});

	expect(probe).toEqual({
		available: true,
		bwrapPath: realpathSync(bwrapPath),
	});
	expect(requests).toHaveLength(1);
	expect(requests[0]?.argv).toContain("--unshare-user");
	expect(requests[0]?.argv).toContain("--unshare-pid");
	expect(requests[0]?.argv).toContain("--unshare-ipc");
	expect(requests[0]?.argv).toContain("--unshare-uts");
	expect(requests[0]?.argv).not.toContain("--unshare-net");
	expect(requests[0]?.timeoutMilliseconds).toBe(5_000);
	expect(requests[0]?.outputLimitBytes).toBe(4_096);
});

test("missing user namespace becomes an observable unconfined fallback", async () => {
	const bwrapPath = executableFixture();
	const probe = await probeLinuxSandbox({
		process: fakeProcess(
			processResult(
				1,
				"",
				"bwrap: No permissions to create a new namespace, likely because the kernel does not support user namespaces",
			),
		),
		hostPlatform: "linux",
		bwrapPath,
	});
	const command: ProcessRequest = {
		argv: ["/bin/sh", "/run/check.sh"],
		cwd: "/workspace",
		env: { HOME: "/home/test", PATH: "/usr/bin:/bin" },
		timeoutMilliseconds: 120_000,
		outputLimitBytes: 16_384,
	};
	const resolution = resolveLinuxSandbox(command, {
		enabled: true,
		probe,
	});

	expect(probe.available).toBe(false);
	if (probe.available) throw new Error("expected user namespace probe to fail");
	expect(probe.reason).toBe("user-namespace-unavailable");
	expect(resolution.mode).toBe("unconfined");
	if (resolution.mode !== "unconfined") {
		throw new Error("expected an unconfined fallback observation");
	}
	expect(resolution.request).toBe(command);
	expect(resolution.report).toBe("unconfined");
	expect(resolution.event).toEqual({
		kind: "sandbox_unavailable",
		reason:
			"user namespaces are unavailable: bwrap: No permissions to create a new namespace, likely because the kernel does not support user namespaces",
	});
	expect(resolution.warning).toBe(
		"kogen: warning: sandbox unavailable: user namespaces are unavailable: bwrap: No permissions to create a new namespace, likely because the kernel does not support user namespaces; building unconfined",
	);
});

test("missing bwrap is reported without starting a process", async () => {
	const requests: ProcessRequest[] = [];
	const probe = await probeLinuxSandbox({
		process: fakeProcess(processResult(0), requests),
		hostPlatform: "linux",
		bwrapPath: null,
	});

	expect(probe).toEqual({
		available: false,
		reason: "bwrap-not-found",
		detail: "bubblewrap executable was not found on PATH",
	});
	expect(requests).toHaveLength(0);
});

test("mount plan exposes only the workspace, run directory, and declared caches as writable", () => {
	const root = fixtureDirectory();
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const runDirectory = join(home, ".kogen/runs/run-1");
	const cacheDirectory = join(home, ".cache/mise");
	const credentials = join(home, ".kogen/credentials");
	const ssh = join(home, ".ssh");
	const gnupg = join(home, ".gnupg");
	const codex = join(home, ".codex");
	const keyrings = join(home, ".local/share/keyrings");
	const authPath = join(home, "auth.json");
	for (const directory of [
		home,
		workspace,
		runDirectory,
		join(runDirectory, "tmp"),
		cacheDirectory,
		credentials,
		ssh,
		gnupg,
		codex,
		keyrings,
	]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const [path, value] of [
		[join(credentials, "token"), "credential"],
		[join(ssh, "id_ed25519"), "ssh"],
		[join(gnupg, "private-keys-v1.d"), "gnupg"],
		[join(codex, "auth.json"), "codex"],
		[join(keyrings, "login.keyring"), "keyring"],
		[authPath, "injected"],
	] as const) {
		writeFileSync(path, value, { mode: 0o600 });
	}
	const canonicalWorkspace = realpathSync(workspace);
	const canonicalRunDirectory = realpathSync(runDirectory);
	const canonicalCacheDirectory = realpathSync(cacheDirectory);
	const canonicalCredentials = realpathSync(credentials);
	const canonicalSsh = realpathSync(ssh);
	const canonicalGnupg = realpathSync(gnupg);
	const canonicalCodex = realpathSync(codex);
	const canonicalKeyrings = realpathSync(keyrings);
	const canonicalAuthPath = realpathSync(authPath);
	const checkout = join(root, "checkout");
	const origin = join(root, "origin");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(origin, { recursive: true });
	const canonicalCheckout = realpathSync(checkout);
	const canonicalOrigin = realpathSync(origin);

	const original: ProcessRequest = {
		argv: ["/bin/sh", "/run-1/script.sh"],
		cwd: workspace,
		env: {
			HOME: home,
			PATH: "/usr/bin:/bin",
			TMPDIR: join(runDirectory, "tmp"),
		},
		stdin: encoder.encode("input bytes"),
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 8_192,
	};
	const request = createLinuxSandboxProcessRequest({
		bwrapPath: "/usr/bin/bwrap",
		homeDirectory: home,
		workspaceDirectory: workspace,
		runDirectory,
		checkoutDirectory: checkout,
		originDirectory: origin,
		writableCacheDirectories: [cacheDirectory],
		authPath,
		userRuntimeDirectory: null,
		command: original,
	});
	const argv = request.argv;

	expect(argv[0]).toBe("/usr/bin/bwrap");
	expect(optionIndex(argv, "--ro-bind", "/")).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--bind", "/tmp")).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--tmpfs", canonicalCredentials)).toBeGreaterThan(
		-1,
	);
	expect(optionIndex(argv, "--tmpfs", canonicalSsh)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--tmpfs", canonicalGnupg)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--tmpfs", canonicalCodex)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--tmpfs", canonicalKeyrings)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--bind", canonicalWorkspace)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--bind", canonicalRunDirectory)).toBeGreaterThan(
		-1,
	);
	expect(optionIndex(argv, "--bind", canonicalCacheDirectory)).toBeGreaterThan(
		-1,
	);
	const authMaskIndex = optionIndex(argv, "--tmpfs", canonicalAuthPath);
	expect(authMaskIndex).toBeGreaterThan(-1);
	expect(argv.slice(authMaskIndex - 2, authMaskIndex + 2)).toEqual([
		"--perms",
		"000",
		"--tmpfs",
		canonicalAuthPath,
	]);
	for (const writableDirectory of [
		canonicalWorkspace,
		canonicalRunDirectory,
		canonicalCacheDirectory,
	]) {
		expect(authMaskIndex).toBeGreaterThan(
			optionIndex(argv, "--bind", writableDirectory),
		);
	}
	expect(optionIndex(argv, "--ro-bind", canonicalCheckout)).toBeGreaterThan(-1);
	expect(optionIndex(argv, "--ro-bind", canonicalOrigin)).toBeGreaterThan(-1);
	expect(argv).not.toContain("--unshare-net");
	expect(argv).toContain("--disable-userns");
	expect(argv).toContain("ALL");
	expect(argv[argv.indexOf("--chdir") + 1]).toBe(canonicalWorkspace);
	expect(argv.slice(argv.indexOf("--") + 1)).toEqual([...original.argv]);
	expect(request.env).toBe(original.env);
	expect(request.stdin).toBe(original.stdin);
	expect(request.cwd).toBe("/");
});

test("mount plan rejects workspace paths that would re-expose a credential directory", () => {
	const root = fixtureDirectory();
	const home = join(root, "home");
	const credentials = join(home, ".kogen/credentials");
	const runDirectory = join(root, "run");
	const checkout = join(root, "checkout");
	const origin = join(root, "origin");
	mkdirSync(credentials, { recursive: true });
	mkdirSync(runDirectory, { recursive: true });
	mkdirSync(checkout, { recursive: true });
	mkdirSync(origin, { recursive: true });

	expect(() =>
		createLinuxSandboxProcessRequest({
			bwrapPath: "/usr/bin/bwrap",
			homeDirectory: home,
			workspaceDirectory: home,
			runDirectory,
			checkoutDirectory: checkout,
			originDirectory: origin,
			writableCacheDirectories: [],
			userRuntimeDirectory: null,
			command: {
				argv: ["/bin/true"],
				cwd: home,
				env: {},
				timeoutMilliseconds: 1_000,
				outputLimitBytes: 128,
			},
		}),
	).toThrow("writable sandbox path overlaps a hidden credential path");
});

function findBwrapOnPath(): string | null {
	const pathValue = process.env.PATH ?? "";
	for (const directory of pathValue.split(delimiter)) {
		const candidate = join(directory.length === 0 ? "." : directory, "bwrap");
		try {
			const result = spawnSync(candidate, ["--version"], {
				encoding: "utf8",
				timeout: 2_000,
			});
			if (result.status === 0) return resolve(candidate);
		} catch {
			// Continue searching PATH.
		}
	}
	return null;
}

function canCreateNamespaces(bwrapPath: string): boolean {
	const result = spawnSync(
		bwrapPath,
		[
			"--die-with-parent",
			"--new-session",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-ipc",
			"--unshare-uts",
			"--ro-bind",
			"/",
			"/",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--bind",
			"/tmp",
			"/tmp",
			"--disable-userns",
			"--cap-drop",
			"ALL",
			"--",
			"/bin/true",
		],
		{ encoding: "utf8", timeout: 5_000 },
	);
	return result.status === 0;
}

const integrationBwrap =
	process.platform === "linux" ? findBwrapOnPath() : null;
const canRunLinuxMountIntegration =
	integrationBwrap !== null && canCreateNamespaces(integrationBwrap);

if (canRunLinuxMountIntegration && integrationBwrap !== null) {
	test("real Linux mounts hide secrets, keep the origin read-only, and allow workspace/cache writes", () => {
		const root = mkdtempSync(join(process.cwd(), ".sandbox-linux-"));
		fixtures.push(root);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		const runDirectory = join(home, ".kogen/runs/run-1");
		const cacheDirectory = join(home, ".cache/mise");
		const checkout = join(home, "checkout");
		const origin = join(home, "origin");
		const credentials = join(home, ".kogen/credentials");
		const ssh = join(home, ".ssh");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(join(runDirectory, "tmp"), { recursive: true });
		mkdirSync(cacheDirectory, { recursive: true });
		mkdirSync(checkout, { recursive: true });
		mkdirSync(credentials, { recursive: true });
		mkdirSync(ssh, { recursive: true });
		mkdirSync(origin, { recursive: true });
		writeFileSync(join(credentials, "token"), "credential", { mode: 0o600 });
		writeFileSync(join(ssh, "id_ed25519"), "private key", { mode: 0o600 });
		writeFileSync(join(checkout, "sentinel"), "checkout", { mode: 0o600 });
		writeFileSync(join(origin, "sentinel"), "origin", { mode: 0o600 });

		const homeAuthPath = join(home, "auth.json");
		writeFileSync(homeAuthPath, "injected", { mode: 0o600 });
		const command: ProcessRequest = {
			argv: [
				"/bin/sh",
				"-c",
				[
					'test ! -r "$HOME/.kogen/credentials/token"',
					'test ! -r "$HOME/.ssh/id_ed25519"',
					'test ! -r "$HOME/auth.json"',
					'printf changed > "$1/result.txt"',
					'printf cache > "$HOME/.cache/mise/result.txt"',
					'if printf bad >> "$2/sentinel" 2>/dev/null; then exit 91; fi',
					'if printf bad >> "$3/sentinel" 2>/dev/null; then exit 92; fi',
					"readlink /proc/self/ns/net",
				].join(" && "),
				"kogen-sandbox-test",
				workspace,
				checkout,
				origin,
			],
			cwd: workspace,
			env: {
				HOME: home,
				PATH: "/usr/bin:/bin",
				TMPDIR: join(runDirectory, "tmp"),
			},
			timeoutMilliseconds: 10_000,
			outputLimitBytes: 4_096,
		};
		const request = createLinuxSandboxProcessRequest({
			bwrapPath: integrationBwrap,
			homeDirectory: home,
			workspaceDirectory: workspace,
			runDirectory,
			checkoutDirectory: checkout,
			originDirectory: origin,
			writableCacheDirectories: [cacheDirectory],
			authPath: homeAuthPath,
			userRuntimeDirectory: null,
			command,
		});
		const [program, ...args] = request.argv;
		if (program === undefined) throw new Error("sandbox command was empty");
		const execution = spawnSync(program, args, {
			cwd: request.cwd,
			env: request.env,
			input: request.stdin,
			encoding: "utf8",
			timeout: request.timeoutMilliseconds,
			maxBuffer: request.outputLimitBytes,
		});

		expect(execution.status).toBe(0);
		expect(execution.stderr).toBe("");
		expect(execution.stdout.trim()).toBe(readlinkSync("/proc/self/ns/net"));
		expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("changed");
		expect(readFileSync(join(cacheDirectory, "result.txt"), "utf8")).toBe(
			"cache",
		);
		expect(readFileSync(join(checkout, "sentinel"), "utf8")).toBe("checkout");
		expect(readFileSync(join(origin, "sentinel"), "utf8")).toBe("origin");
	});
} else {
	test.skip("real Linux mounts require Linux user namespaces and bubblewrap", () => {});
}
