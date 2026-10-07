import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	HOST_MAX_PAYLOAD_BYTES,
	HostBridgeError,
	hostHelperName,
	resolveHostHelperPath,
	startHostBridge,
} from "../../packages/core/src/process/host";

const root = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
type PipeProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;
let scratch = "";
let compiledDirectory = "";
let probeDirectory = "";
let helperPath = "";
let probeHelperPath = "";
let cliPath = "";
let probeCliPath = "";
let workerPath = "";

interface GroupReport {
	helperPid: number;
	workerPid: number;
	grandchildPid: number;
	controlFdClosedOnExec: boolean;
}

function compile(
	sourceFiles: string[],
	output: string,
	extra: string[] = [],
): void {
	const result = spawnSync(
		compiler,
		[
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			...extra,
			...sourceFiles,
			"-o",
			output,
		],
		{ cwd: root, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`compile failed: ${result.stderr || result.stdout}`);
	}
}

function rawHelper() {
	const child = Bun.spawn<"pipe", "pipe", "pipe">({
		cmd: [helperPath],
		stdio: ["pipe", "pipe", "pipe", "socket-fd"],
		env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
	});
	const controlFd = child.stdio[3];
	if (controlFd == null) throw new Error("missing raw helper control fd");
	return { child, controlFd };
}

async function writeRaw(child: PipeProcess, bytes: Uint8Array) {
	child.stdin.write(bytes);
	await child.stdin.flush();
	child.stdin.end();
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EPERM")
			return true;
		return false;
	}
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
	scratch = mkdtempSync(join(tmpdir(), "kogen-host-bridge-"));
	compiledDirectory = join(scratch, "compiled");
	probeDirectory = join(scratch, "probe");
	mkdirSync(compiledDirectory, { mode: 0o700 });
	mkdirSync(probeDirectory, { mode: 0o700 });
	helperPath = join(compiledDirectory, hostHelperName());
	cliPath = join(compiledDirectory, "kogen");
	probeHelperPath = join(probeDirectory, hostHelperName());
	probeCliPath = join(probeDirectory, "kogen");
	workerPath = join(probeDirectory, "probe-worker");
	writeFileSync(cliPath, "compiled CLI placeholder\n", { mode: 0o700 });
	writeFileSync(probeCliPath, "compiled CLI placeholder\n", { mode: 0o700 });
	compile(["native/main.c", "native/protocol.c"], helperPath);
	compile(["native/main.c", "native/protocol.c"], probeHelperPath, [
		"-DKOGEN_HOST_TESTING=1",
	]);
	compile(["tests/host-bridge/probe-worker.c"], workerPath);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("compiled helper lookup uses the executable's private sibling", () => {
	expect(resolveHostHelperPath({ compiledExecutablePath: cliPath })).toBe(
		helperPath,
	);
	expect(hostHelperName("darwin", "arm64")).toBe("kogen-host-darwin-arm64");
	expect(hostHelperName("linux", "x64")).toBe("kogen-host-linux-x64");
	expect(() => hostHelperName("win32", "x64")).toThrow(HostBridgeError);
});

test("binary framing echoes the full bounded payload and preserves NUL bytes", async () => {
	const bridge = await startHostBridge({ compiledExecutablePath: cliPath });
	const payload = new Uint8Array(HOST_MAX_PAYLOAD_BYTES);
	for (let index = 0; index < payload.byteLength; index++)
		payload[index] = index % 256;
	const response = await bridge.request(2, payload);
	expect(response.byteLength).toBe(HOST_MAX_PAYLOAD_BYTES);
	expect(response[0]).toBe(0);
	expect(response[1]).toBe(1);
	expect(response[255]).toBe(255);
	expect(response.at(-1)).toBe(payload.at(-1));
	await bridge.close();
});

test("unknown operations are rejected without desynchronizing the next frame", async () => {
	const bridge = await startHostBridge({ compiledExecutablePath: cliPath });
	await expect(bridge.request(0x1234)).rejects.toThrow("rejected request");
	const response = await bridge.request(2, Uint8Array.of(0, 255, 4));
	expect([...response]).toEqual([0, 255, 4]);
	await bridge.close();
});

test("concurrent calls serialize frames and preserve each caller's bytes", async () => {
	const bridge = await startHostBridge({ compiledExecutablePath: cliPath });
	const first = Uint8Array.of(0, 1, 2);
	const second = Uint8Array.of(255, 4, 0);
	const [firstResponse, secondResponse] = await Promise.all([
		bridge.request(2, first),
		bridge.request(2, second),
	]);
	first[0] = 99;
	expect([...firstResponse]).toEqual([0, 1, 2]);
	expect([...secondResponse]).toEqual([255, 4, 0]);
	await bridge.close();
});

test("test-only supervisor probe is absent from the product helper", async () => {
	const bridge = await startHostBridge({ compiledExecutablePath: cliPath });
	await expect(bridge.request(0x7f01)).rejects.toThrow("rejected request");
	await bridge.close();
});

test("oversized and unknown-version frames fail before payload allocation", async () => {
	const tooLarge = rawHelper();
	const oversizedPrefix = new Uint8Array(4);
	new DataView(oversizedPrefix.buffer).setUint32(0, 1024 * 1024 + 1, false);
	await writeRaw(tooLarge.child, oversizedPrefix);
	const oversizedExit = await tooLarge.child.exited;
	closeSync(tooLarge.controlFd);
	expect(oversizedExit).not.toBe(0);

	const wrongVersion = rawHelper();
	const frame = new Uint8Array(12);
	const view = new DataView(frame.buffer);
	view.setUint32(0, 8, false);
	view.setUint16(4, 2, false);
	view.setUint16(6, 2, false);
	view.setUint32(8, 7, false);
	await writeRaw(wrongVersion.child, frame);
	const versionExit = await wrongVersion.child.exited;
	closeSync(wrongVersion.controlFd);
	expect(versionExit).not.toBe(0);
});

test("SIGKILL of the Kogen parent closes control EOF and kills the child group", async () => {
	const reportPath = join(scratch, "parent-report.json");
	const driverPath = join(import.meta.dir, "parent-kill-driver.ts");
	const driver = Bun.spawn({
		cmd: [
			process.execPath,
			"--no-install",
			driverPath,
			probeCliPath,
			workerPath,
			reportPath,
		],
		cwd: root,
		stdio: ["ignore", "ignore", "ignore"],
		env: process.env,
	});
	let report: GroupReport | undefined;
	try {
		const ready = await waitUntil(() => existsSync(reportPath), 5000);
		expect(ready).toBe(true);
		report = JSON.parse(readFileSync(reportPath, "utf8")) as GroupReport;
		expect(report.controlFdClosedOnExec).toBe(true);
		expect(isAlive(report.workerPid)).toBe(true);
		expect(isAlive(report.grandchildPid)).toBe(true);
		driver.kill("SIGKILL");
		await driver.exited;
		const stopped = await waitUntil(
			() =>
				!isAlive(report?.helperPid ?? -1) &&
				!isAlive(report?.workerPid ?? -1) &&
				!isAlive(report?.grandchildPid ?? -1),
			5000,
		);
		expect(stopped).toBe(true);
	} finally {
		if (driver.exitCode === null) driver.kill("SIGKILL");
	}
});
