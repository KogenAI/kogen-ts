import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type HostBridge,
	hostHelperName,
	startHostBridge,
} from "../../packages/core/src/process/host";
import {
	encodeSupervisorRequest,
	PROCESS_SUPERVISE_OPERATION,
	ProcessSupervisorError,
	superviseProcess,
} from "../../packages/core/src/process/supervise";

const root = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
let scratch = "";
let hostPath = "";
let cliPath = "";
let escapedProgram = "";
const hostProcesses = new Set<number>();

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
		throw new Error(`compile failed: ${result.stderr || result.stdout}`);
}

async function startBridge(): Promise<HostBridge> {
	const bridge = await startHostBridge({ compiledExecutablePath: cliPath });
	hostProcesses.add(bridge.pid);
	return bridge;
}

async function withSupervisor<T>(
	callback: (bridge: HostBridge) => Promise<T>,
): Promise<T> {
	const bridge = await startBridge();
	try {
		return await callback(bridge);
	} finally {
		await bridge.close();
		hostProcesses.delete(bridge.pid);
	}
}

function isAlive(pid: number, expectedCommand = ""): boolean {
	const state = spawnSync("/bin/ps", ["-o", "stat=,comm=", "-p", String(pid)], {
		encoding: "utf8",
	});
	if (state.status !== 0 || state.stdout.trim().length === 0) return false;
	const [processState = "", ...commandParts] = state.stdout.trim().split(/\s+/);
	return (
		!processState.startsWith("Z") &&
		(expectedCommand.length === 0 ||
			commandParts.join(" ").includes(expectedCommand))
	);
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return predicate();
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-custody-"));
	hostPath = join(scratch, hostHelperName());
	cliPath = join(scratch, "kogen");
	escapedProgram = join(scratch, "escaped-session");
	writeFileSync(cliPath, "compiled cli fixture\n", { mode: 0o700 });
	compile(
		[
			"tests/custody/supervisor-host.c",
			"native/protocol.c",
			"native/supervisor.c",
		],
		hostPath,
	);
	compile(["tests/custody/escaped-session.c"], escapedProgram);
});

afterAll(() => {
	for (const pid of hostProcesses) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("request encoding refuses an argv element over 4 KiB", () => {
	expect(() =>
		encodeSupervisorRequest({
			argv: ["/bin/echo", "x".repeat(4097)],
			timeoutMs: 1000,
		}),
	).toThrow(ProcessSupervisorError);
});

test("native decoding also refuses an argv element over 4 KiB", async () => {
	const payload = new Uint8Array(32 + 4 + 4097);
	const view = new DataView(payload.buffer);
	view.setUint16(0, 1, false);
	view.setBigUint64(4, 1000n, false);
	view.setUint16(24, 1, false);
	view.setUint32(32, 4097, false);
	payload.set(new TextEncoder().encode("x".repeat(4097)), 36);
	await withSupervisor(async (bridge) => {
		await expect(
			bridge.request(PROCESS_SUPERVISE_OPERATION, payload),
		).rejects.toThrow("rejected request");
	});
});

test("a monotonic deadline drains chatty output into bounded tails", async () => {
	const result = await withSupervisor((bridge) =>
		superviseProcess(bridge, {
			argv: ["/usr/bin/yes"],
			environment: { PATH: "/usr/bin:/bin" },
			timeoutMs: 100,
			stdoutTailBytes: 128,
			stderrTailBytes: 32,
		}),
	);
	expect(result.termination).toBe("timed-out");
	expect(result.stdoutBytes).toBeGreaterThan(result.stdoutTail.byteLength);
	expect(result.stdoutTail.byteLength).toBe(128);
	expect(result.stderrTail.byteLength).toBe(0);
	expect(result.durationMs).toBeGreaterThanOrEqual(100);
});

test("TERM is delivered to the group and a TERM handler can exit", async () => {
	const result = await withSupervisor((bridge) =>
		superviseProcess(bridge, {
			argv: ["/bin/sh", "-c", "trap 'exit 37' TERM; while :; do :; done"],
			environment: { PATH: "/usr/bin:/bin" },
			timeoutMs: 100,
			stdoutTailBytes: 0,
			stderrTailBytes: 0,
		}),
	);
	expect(result.termination).toBe("timed-out");
	expect(result.exitCode).toBe(37);
	expect(result.signal).toBeNull();
	expect(result.durationMs).toBeGreaterThanOrEqual(100);
	expect(result.durationMs).toBeLessThan(1000);
});

test("an ignored TERM is followed by KILL after the 200 ms grace", async () => {
	const result = await withSupervisor((bridge) =>
		superviseProcess(bridge, {
			argv: ["/bin/sh", "-c", "trap '' TERM; while :; do :; done"],
			environment: { PATH: "/usr/bin:/bin" },
			timeoutMs: 100,
			stdoutTailBytes: 0,
			stderrTailBytes: 0,
		}),
	);
	expect(result.termination).toBe("timed-out");
	expect(result.signal).toBe(9);
	expect(result.durationMs).toBeGreaterThanOrEqual(250);
	expect(result.durationMs).toBeLessThan(1000);
});

test("normal leader exit terminates its remaining process group", async () => {
	const grandchildPath = join(scratch, "normal-grandchild.pid");
	const result = await withSupervisor((bridge) =>
		superviseProcess(bridge, {
			argv: [
				"/bin/sh",
				"-c",
				'sleep 30 & echo $! > "$1"; exit 0',
				"custody-grandchild",
				grandchildPath,
			],
			environment: { PATH: "/usr/bin:/bin" },
			timeoutMs: 5000,
			stdoutTailBytes: 32,
			stderrTailBytes: 32,
		}),
	);
	expect(result.termination).toBe("exited");
	expect(result.exitCode).toBe(0);
	expect(existsSync(grandchildPath)).toBe(true);
	const grandchildPid = Number(readFileSync(grandchildPath, "utf8").trim());
	expect(grandchildPid).toBeGreaterThan(0);
	expect(await waitUntil(() => !isAlive(grandchildPid, "sleep"), 3000)).toBe(
		true,
	);
});

test("an escaped session is outside group custody and cannot hold output open forever", async () => {
	const escapedPath = join(scratch, "escaped-grandchild.pid");
	let escapedPid = 0;
	try {
		const result = await withSupervisor((bridge) =>
			superviseProcess(bridge, {
				argv: [escapedProgram, escapedPath],
				environment: { PATH: "/usr/bin:/bin" },
				timeoutMs: 5000,
				stdoutTailBytes: 32,
				stderrTailBytes: 32,
			}),
		);
		expect(result.termination).toBe("exited");
		expect(result.exitCode).toBe(0);
		escapedPid = Number(readFileSync(escapedPath, "utf8").trim());
		// The escaped process holds the output pipe open, yet the leader exits
		// normally and the supervisor returns before the command deadline.
		expect(result.durationMs).toBeLessThan(5000);
		expect(escapedPid).toBeGreaterThan(0);
		expect(isAlive(escapedPid, "sleep")).toBe(true);
	} finally {
		if (escapedPid === 0 && existsSync(escapedPath))
			escapedPid = Number(readFileSync(escapedPath, "utf8").trim());
		if (escapedPid > 0 && isAlive(escapedPid, "sleep")) {
			try {
				process.kill(escapedPid, "SIGKILL");
			} catch {}
		}
	}
});

test("parent SIGKILL closes control EOF and the helper kills the process group", async () => {
	const helperReportPath = join(scratch, "parent-helper.pid");
	const processReportPath = join(scratch, "parent-processes.txt");
	const driverPath = join(import.meta.dir, "parent-kill-driver.ts");
	const driver = Bun.spawn({
		cmd: [
			process.execPath,
			"--no-install",
			driverPath,
			cliPath,
			helperReportPath,
			processReportPath,
		],
		cwd: root,
		stdio: ["ignore", "ignore", "ignore"],
		env: process.env,
	});
	let helperPid = 0;
	let processPids: number[] = [];
	try {
		expect(await waitUntil(() => existsSync(helperReportPath), 5000)).toBe(
			true,
		);
		helperPid = Number(readFileSync(helperReportPath, "utf8"));
		// The shell creates the report before its echo has written both PIDs.
		// Wait for the complete report so this test observes process readiness.
		expect(
			await waitUntil(() => {
				if (!existsSync(processReportPath)) return false;
				processPids = readFileSync(processReportPath, "utf8")
					.trim()
					.split(/\s+/)
					.map(Number);
				return processPids.length === 2 && processPids.every((pid) => pid > 0);
			}, 5000),
		).toBe(true);
		expect(processPids).toHaveLength(2);
		expect(isAlive(processPids[0] ?? -1, "sh")).toBe(true);
		expect(isAlive(processPids[1] ?? -1, "sleep")).toBe(true);
		driver.kill("SIGKILL");
		await driver.exited;
		const cleaned = await waitUntil(
			() =>
				!isAlive(helperPid, "kogen-host") &&
				!isAlive(processPids[0] ?? -1, "sh") &&
				!isAlive(processPids[1] ?? -1, "sleep"),
			3000,
		);
		expect(cleaned).toBe(true);
	} finally {
		if (driver.exitCode === null) driver.kill("SIGKILL");
		for (const pid of [helperPid, ...processPids]) {
			if (
				(pid === helperPid && isAlive(pid, "kogen-host")) ||
				(pid === processPids[0] && isAlive(pid, "sh")) ||
				(pid === processPids[1] && isAlive(pid, "sleep"))
			) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	}
});

test("stdin is streamed and stdout and stderr tails remain separate", async () => {
	const input = new TextEncoder().encode("alpha\0beta\nomega\n");
	const result = await withSupervisor((bridge) =>
		superviseProcess(bridge, {
			argv: ["/bin/sh", "-c", "cat; printf out; printf err >&2"],
			environment: { PATH: "/usr/bin:/bin" },
			stdin: input,
			timeoutMs: 5000,
			stdoutTailBytes: 7,
			stderrTailBytes: 3,
		}),
	);
	expect(result.termination).toBe("exited");
	expect(result.stdoutTail).toEqual(new TextEncoder().encode("ega\nout"));
	expect(result.stderrTail).toEqual(new TextEncoder().encode("err"));
	expect(result.stdoutBytes).toBe(input.byteLength + 3);
	expect(result.stderrBytes).toBe(3);
});
