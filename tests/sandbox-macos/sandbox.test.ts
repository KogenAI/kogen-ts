import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	createMacOSSandboxProfile,
	MACOS_SANDBOX_EXECUTABLE,
	macOSSandboxCommand,
	probeMacOSSandbox,
} from "../../packages/core/src/sandbox/macos";
import {
	forcedSandboxUnavailableReason,
	formatSandboxWarning,
	resolveSandboxPolicy,
	sandboxAlreadyConfined,
} from "../../packages/core/src/sandbox/policy";

let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-sandbox-macos-"));
	chmodSync(scratch, 0o700);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(path: string, contents: string): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function fakeProcess(
	responses: readonly (
		| { readonly ok: true; readonly value: ProcessResult }
		| {
				readonly ok: false;
				readonly error: {
					readonly message: string;
					readonly code: "unknown";
					readonly retryable: false;
				};
		  }
	)[],
	requests: ProcessRequest[],
): ProcessPort {
	let index = 0;
	return {
		async run(request) {
			requests.push(request);
			const response = responses[index];
			index++;
			if (!response) throw new Error("unexpected process probe request");
			return response;
		},
	};
}

function processResult(
	exitCode: number,
	stderr = "",
	timedOut = false,
): { readonly ok: true; readonly value: ProcessResult } {
	return {
		ok: true,
		value: {
			exitCode,
			signal: null,
			stdout: new Uint8Array(),
			stderr: new TextEncoder().encode(stderr),
			timedOut,
		},
	};
}

function makeProfilePaths() {
	const root = join(scratch, "profile-fixture");
	const home = join(root, "home");
	const checkout = join(root, "checkout");
	const origin = join(root, "origin.git");
	const workspace = join(root, "workspace");
	const runDirectory = join(root, "run");
	const cache = join(home, ".cache", "mise");
	const ssh = join(home, ".ssh");
	const codex = join(home, ".codex");
	const kogen = join(home, ".kogen");
	for (const path of [
		home,
		checkout,
		origin,
		workspace,
		runDirectory,
		cache,
		ssh,
		codex,
		kogen,
	])
		mkdirSync(path, { recursive: true, mode: 0o700 });
	const authPath = join(root, "auth.json");
	writeFixture(join(ssh, "id_ed25519"), "ssh-secret-fixture");
	writeFixture(join(codex, "auth.json"), "codex-secret-fixture");
	writeFixture(join(kogen, "credentials-store"), "credential-secret-fixture");
	writeFixture(authPath, "injected-auth-fixture");
	writeFixture(join(checkout, "tracked.txt"), "checkout-original\n");
	writeFixture(join(origin, "object-marker"), "origin-original\n");
	return {
		root,
		home,
		checkout,
		origin,
		workspace,
		runDirectory,
		cache,
		authPath,
	};
}

function fakePathOptions(paths: ReturnType<typeof makeProfilePaths>) {
	return {
		checkout: paths.checkout,
		origins: [paths.origin],
		workspace: paths.workspace,
		runDirectory: paths.runDirectory,
		home: paths.home,
		authPath: paths.authPath,
		cachePaths: [paths.cache],
	};
}

function physical(path: string): string {
	return realpathSync.native(path);
}

async function runSandboxed(
	profile: string,
	argv: readonly string[],
	options: {
		readonly cwd: string;
		readonly environment: Record<string, string>;
	},
): Promise<{
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}> {
	const child = Bun.spawn({
		cmd: [MACOS_SANDBOX_EXECUTABLE, "-p", profile, ...argv],
		cwd: options.cwd,
		env: options.environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function bunProcessPort(): ProcessPort {
	return {
		async run(request) {
			const child = Bun.spawn({
				cmd: [...request.argv],
				cwd: request.cwd,
				env: { ...request.env },
				stdin: request.stdin ?? "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const timeout = setTimeout(
				() => child.kill("SIGKILL"),
				request.timeoutMilliseconds,
			);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).arrayBuffer(),
					new Response(child.stderr).arrayBuffer(),
				]);
				return {
					ok: true as const,
					value: {
						exitCode,
						signal: null,
						stdout: new Uint8Array(stdout),
						stderr: new Uint8Array(stderr),
						timedOut: false,
					},
				};
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}

test("sandbox policy keeps off, already-confined and unavailable outcomes distinct", () => {
	const capability = { available: true };
	expect(
		resolveSandboxPolicy({
			enabled: false,
			capability,
			forcedUnavailableReason: "forced",
		}),
	).toEqual({
		mode: "off",
		wrapCommands: false,
		alreadyConfined: false,
		unavailableReason: null,
		warning: null,
		event: null,
	});
	expect(
		resolveSandboxPolicy({
			enabled: true,
			alreadyConfined: true,
			capability: { available: false },
		}),
	).toEqual({
		mode: "confined",
		wrapCommands: false,
		alreadyConfined: true,
		unavailableReason: null,
		warning: null,
		event: null,
	});
	const forced = resolveSandboxPolicy({
		enabled: true,
		capability,
		forcedUnavailableReason: "fixture says unavailable",
	});
	expect(forced.mode).toBe("unconfined");
	expect(forced.wrapCommands).toBe(false);
	expect(forced.event).toBe("sandbox_unavailable");
	expect(forced.warning).toBe(
		"kogen: warning: sandbox unavailable: fixture says unavailable; building unconfined",
	);
	const failedProbe = resolveSandboxPolicy({
		enabled: true,
		capability: { available: false, reason: "sandbox-exec missing" },
	});
	expect(failedProbe.unavailableReason).toBe("sandbox-exec missing");
	expect(failedProbe.warning).toBe(
		formatSandboxWarning("sandbox-exec missing"),
	);
	expect(
		resolveSandboxPolicy({
			enabled: true,
			capability: { available: false, reason: "bad\nreason\0" },
		}).unavailableReason,
	).toBe("bad reason");
	expect(sandboxAlreadyConfined({ KOGEN_SANDBOXED: "1" })).toBe(true);
	expect(sandboxAlreadyConfined({ KOGEN_SANDBOXED: "true" })).toBe(false);
	expect(forcedSandboxUnavailableReason({ KOGEN_SANDBOX: "unavailable" })).toBe(
		"forced unavailable by KOGEN_SANDBOX=unavailable",
	);
});

test("macOS profile confines writes and hides credential paths", () => {
	const paths = makeProfilePaths();
	const profile = createMacOSSandboxProfile({
		...fakePathOptions(paths),
		environment: { GOMODCACHE: join(paths.root, "go-cache") },
	});
	expect(profile.startsWith("(version 1)\n(deny default)\n")).toBe(true);
	expect(profile).toContain("(allow process-fork)");
	expect(profile).toContain("(allow process-exec)");
	expect(profile).toContain("(allow network*)");
	expect(profile).toContain(
		`(allow file-write* (subpath "${physical(paths.workspace)}"))`,
	);
	expect(profile).toContain(
		`(allow file-write* (subpath "${physical(paths.runDirectory)}"))`,
	);
	expect(profile).toContain(
		`(allow file-write* (subpath "${physical(paths.cache)}"))`,
	);
	expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
	expect(profile).toContain(
		`(deny file-write* (subpath "${physical(paths.checkout)}"))`,
	);
	expect(profile).toContain(
		`(deny file-write* (subpath "${physical(paths.origin)}"))`,
	);
	expect(profile).toContain(
		`(deny file-read* (subpath "${physical(join(paths.home, ".ssh"))}"))`,
	);
	expect(profile).toContain(
		`(deny file-read* (literal "${physical(paths.authPath)}"))`,
	);
	expect(profile).toContain(".kogen/credentials[^/]*(/.*)?$");
	expect(profile).toContain(
		'(deny mach-lookup (global-name "com.apple.securityd"))',
	);
	expect(profile).toContain(
		`(allow file-write* (subpath "${join(physical(paths.root), "go-cache")}"))`,
	);
	expect(
		macOSSandboxCommand("/private/run/profile.sb", [
			"/bin/sh",
			"/private/run/script",
		]),
	).toEqual([
		MACOS_SANDBOX_EXECUTABLE,
		"-f",
		"/private/run/profile.sb",
		"/bin/sh",
		"/private/run/script",
	]);
	expect(() => macOSSandboxCommand("relative.sb", ["/bin/true"])).toThrow();
});

test("sandbox capability probe distinguishes a denied write from an unavailable host", async () => {
	const requests: ProcessRequest[] = [];
	const probeProcess = fakeProcess(
		[processResult(0), processResult(1, "touch: Operation not permitted")],
		requests,
	);
	const probe = await probeMacOSSandbox({
		process: probeProcess,
		platform: "darwin",
	});
	expect(probe).toEqual({ available: true });
	expect(requests).toHaveLength(2);
	expect(requests[0]?.argv[0]).toBe(MACOS_SANDBOX_EXECUTABLE);
	expect(requests[0]?.timeoutMilliseconds).toBe(5_000);
	const forcedRequests: ProcessRequest[] = [];
	const forced = await probeMacOSSandbox({
		process: fakeProcess([], forcedRequests),
		platform: "darwin",
		environment: { KOGEN_SANDBOX: "unavailable" },
	});
	expect(forced).toEqual({
		available: false,
		reason: "forced unavailable by KOGEN_SANDBOX=unavailable",
	});
	expect(forcedRequests).toHaveLength(0);
	const unsupportedRequests: ProcessRequest[] = [];
	expect(
		await probeMacOSSandbox({
			process: fakeProcess([], unsupportedRequests),
			platform: "linux",
		}),
	).toEqual({
		available: false,
		reason: "macOS sandbox is unavailable on this host",
	});
	expect(unsupportedRequests).toHaveLength(0);
	const brokenRequests: ProcessRequest[] = [];
	expect(
		await probeMacOSSandbox({
			process: fakeProcess(
				[processResult(127, "sandbox-exec missing")],
				brokenRequests,
			),
			platform: "darwin",
		}),
	).toEqual({
		available: false,
		reason: "sandbox-exec capability probe failed: sandbox-exec missing",
	});
});

test("real macOS sandbox blocks checkout/origin writes and secret reads while allowing workspace, cache and network", async () => {
	expect(process.platform).toBe("darwin");
	const paths = makeProfilePaths();
	const profile = createMacOSSandboxProfile(fakePathOptions(paths));
	const scriptPath = join(paths.runDirectory, "sandbox-fixture.sh");
	const networkBodyPath = join(paths.workspace, "network-response.txt");
	const script = [
		"/usr/bin/printf 'discarded\\n' > /dev/null",
		`printf 'workspace-write-ok\\n' > ${JSON.stringify(join(paths.workspace, "workspace.txt"))}`,
		`printf 'cache-write-ok\\n' > ${JSON.stringify(join(paths.cache, "cache.txt"))}`,
		`if /bin/cat ${JSON.stringify(join(paths.home, ".ssh", "id_ed25519"))} > ${JSON.stringify(join(paths.workspace, "ssh-leak"))} 2>/dev/null && /usr/bin/test -s ${JSON.stringify(join(paths.workspace, "ssh-leak"))}; then echo secret-readable; fi`,
		`if /bin/cat ${JSON.stringify(join(paths.home, ".kogen", "credentials-store"))} > ${JSON.stringify(join(paths.workspace, "credential-leak"))} 2>/dev/null && /usr/bin/test -s ${JSON.stringify(join(paths.workspace, "credential-leak"))}; then echo credential-readable; fi`,
		`if /bin/cat ${JSON.stringify(paths.authPath)} > ${JSON.stringify(join(paths.workspace, "auth-leak"))} 2>/dev/null && /usr/bin/test -s ${JSON.stringify(join(paths.workspace, "auth-leak"))}; then echo auth-readable; fi`,
		`if /usr/bin/printf 'escape\\n' >> ${JSON.stringify(join(paths.checkout, "tracked.txt"))} 2>/dev/null; then echo checkout-writable; fi`,
		`if /usr/bin/printf 'escape\\n' > ${JSON.stringify(join(paths.origin, "escape.txt"))} 2>/dev/null; then echo origin-writable; fi`,
		`/usr/bin/curl --silent --fail --output ${JSON.stringify(networkBodyPath)} "$KOGEN_SANDBOX_TEST_URL"`,
	].join("\n");
	writeFixture(scriptPath, script);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("network-allowed\n"),
	});
	try {
		const result = await runSandboxed(profile, ["/bin/sh", scriptPath], {
			cwd: paths.workspace,
			environment: {
				PATH: "/usr/bin:/bin",
				HOME: paths.home,
				LANG: "C",
				LC_ALL: "C",
				KOGEN_SANDBOX_TEST_URL: `http://127.0.0.1:${server.port}/probe`,
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("secret-readable");
		expect(result.stdout).not.toContain("credential-readable");
		expect(result.stdout).not.toContain("auth-readable");
		expect(result.stdout).not.toContain("checkout-writable");
		expect(result.stdout).not.toContain("origin-writable");
		expect(result.stderr).toContain("Operation not permitted");
		expect(result.stderr).not.toContain("/dev/null");
		expect(readFileSync(join(paths.workspace, "workspace.txt"), "utf8")).toBe(
			"workspace-write-ok\n",
		);
		expect(readFileSync(join(paths.cache, "cache.txt"), "utf8")).toBe(
			"cache-write-ok\n",
		);
		expect(readFileSync(networkBodyPath, "utf8")).toBe("network-allowed\n");
		expect(readFileSync(join(paths.checkout, "tracked.txt"), "utf8")).toBe(
			"checkout-original\n",
		);
		expect(readFileSync(join(paths.origin, "object-marker"), "utf8")).toBe(
			"origin-original\n",
		);
	} finally {
		server.stop(true);
	}
});

test("the production macOS probe confirms sandbox-exec and kernel write denial", async () => {
	expect(process.platform).toBe("darwin");
	expect(await probeMacOSSandbox({ process: bunProcessPort() })).toEqual({
		available: true,
	});
});
