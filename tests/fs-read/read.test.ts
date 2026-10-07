import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createReadFileSystemPort,
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
	FileSystemStatus,
	listDirectoryBytes,
	readControllerFileBytes,
	readToolFileBytes,
} from "../../packages/core/src/fs/read";

const rootDirectory = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
let scratch = "";
let filesystemRoot = "";
let outsideRoot = "";
let driver = "";

function compileDriver(output: string): void {
	const result = spawnSync(
		compiler,
		[
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-I",
			"native",
			"native/paths.c",
			"native/read.c",
			"tests/fs-read/read-driver.c",
			"-o",
			output,
		],
		{ cwd: rootDirectory, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`filesystem driver compile failed: ${result.stderr || result.stdout}`,
		);
}

function spawnDriver(payload: Uint8Array, args: string[] = []) {
	const result = spawnSync(driver, args, {
		input: payload,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`filesystem driver failed (${result.status}): ${result.stderr.toString()}`,
		);
	return new Uint8Array(result.stdout);
}

const host: FileSystemHostRequest = {
	async request(operation, payload) {
		if (operation !== FILESYSTEM_HOST_OPERATION)
			throw new Error(`unexpected filesystem host operation ${operation}`);
		return spawnDriver(payload);
	},
};

function textBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function encodeTestRequest(
	action: number,
	root: Uint8Array,
	path: Uint8Array,
	maxBytes: number,
): Uint8Array {
	const payload = new Uint8Array(17 + root.byteLength + path.byteLength);
	const view = new DataView(payload.buffer);
	payload[0] = action;
	view.setUint32(1, maxBytes, false);
	view.setUint32(5, 0, false);
	view.setUint32(9, root.byteLength, false);
	view.setUint32(13, path.byteLength, false);
	payload.set(root, 17);
	payload.set(path, 17 + root.byteLength);
	return payload;
}

async function runParentSwapDriver(payload: Uint8Array): Promise<string> {
	const child = Bun.spawn({
		cmd: [driver, "--repeat-parent-swap"],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(payload);
	await child.stdin.flush();
	child.stdin.end();
	const stderrPromise = new Response(child.stderr).text();
	const exitCode = await child.exited;
	const stderr = await stderrPromise;
	if (exitCode !== 0)
		throw new Error(`parent swap driver failed (${exitCode}): ${stderr}`);
	return stderr;
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-fs-read-"));
	filesystemRoot = join(scratch, "workspace");
	outsideRoot = join(scratch, "outside");
	driver = join(scratch, "fs-read-driver");
	mkdirSync(filesystemRoot, { mode: 0o700 });
	mkdirSync(outsideRoot, { mode: 0o700 });
	compileDriver(driver);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("controller reads reject symlinked parent and final components", async () => {
	const filesDirectory = join(filesystemRoot, "files");
	const outsideFile = join(outsideRoot, "secret.txt");
	mkdirSync(filesDirectory);
	writeFileSync(join(filesDirectory, "inside.txt"), "inside");
	writeFileSync(outsideFile, "outside");
	symlinkSync(outsideFile, join(filesystemRoot, "final-link"));
	symlinkSync(outsideRoot, join(filesystemRoot, "parent-link"));

	const final = await readControllerFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("final-link"),
		maxBytes: 128,
	});
	const parent = await readControllerFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("parent-link/secret.txt"),
		maxBytes: 128,
	});
	expect(final.ok).toBe(false);
	if (!final.ok) expect(final.error.code).toBe("invalid_input");
	expect(parent.ok).toBe(false);
	if (!parent.ok) expect(parent.error.code).toBe("invalid_input");
});

test("tool reads follow bounded in-root links and reject outside links", async () => {
	const filesDirectory = join(filesystemRoot, "tool-files");
	mkdirSync(filesDirectory);
	writeFileSync(join(filesDirectory, "message.txt"), "anchored bytes");
	symlinkSync("tool-files/message.txt", join(filesystemRoot, "inside-link"));
	symlinkSync(
		join(filesDirectory, "message.txt"),
		join(filesystemRoot, "absolute-inside-link"),
	);
	symlinkSync(outsideRoot, join(filesystemRoot, "outside-link"));
	for (let index = 0; index < 41; index++) {
		const target =
			index === 40 ? "tool-files/message.txt" : `loop-${index + 1}`;
		symlinkSync(target, join(filesystemRoot, `loop-${index}`));
	}

	const linked = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("inside-link"),
		maxBytes: 128,
	});
	const absoluteLinked = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("absolute-inside-link"),
		maxBytes: 128,
	});
	const escaped = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("outside-link/secret.txt"),
		maxBytes: 128,
	});
	const overBound = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("loop-0"),
		maxBytes: 128,
	});
	expect(linked).toEqual({ ok: true, value: textBytes("anchored bytes") });
	expect(absoluteLinked).toEqual({
		ok: true,
		value: textBytes("anchored bytes"),
	});
	expect(escaped.ok).toBe(false);
	if (!escaped.ok) expect(escaped.error.code).toBe("permission_denied");
	expect(overBound.ok).toBe(false);
	if (!overBound.ok) expect(overBound.error.code).toBe("invalid_input");
});

test("directory enumeration returns raw names and classifies links without following", async () => {
	const rawName = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0xff]);
	const listingTarget = join(filesystemRoot, "listing-target");
	mkdirSync(listingTarget);
	writeFileSync(join(listingTarget, "child.txt"), "child");
	symlinkSync("listing-target/child.txt", join(filesystemRoot, "listed-link"));
	const created = spawnSync(driver, ["--create-invalid-name", filesystemRoot], {
		encoding: "utf8",
	});
	if (created.error) throw created.error;

	const listing = await listDirectoryBytes(host, {
		root: textBytes(filesystemRoot),
		path: new Uint8Array(),
		maxEntries: 64,
		maxNameBytes: 4096,
	});
	expect(listing.ok).toBe(true);
	if (!listing.ok) return;
	const invalidUtf8 = listing.value.find((entry) =>
		Buffer.from(entry.name).equals(rawName),
	);
	const link = listing.value.find(
		(entry) => new TextDecoder().decode(entry.name) === "listed-link",
	);
	if (created.status === 0) expect(invalidUtf8?.kind).toBe("regular");
	else {
		expect(created.status).toBe(72);
		expect(invalidUtf8).toBeUndefined();
	}
	expect(link?.kind).toBe("symlink");
	let rawRequest = new Uint8Array();
	const rawByteHost: FileSystemHostRequest = {
		async request(operation, payload) {
			rawRequest = payload.slice();
			return host.request(operation, payload);
		},
	};
	const rawRead = await readToolFileBytes(rawByteHost, {
		root: textBytes(filesystemRoot),
		path: rawName,
		maxBytes: 128,
	});
	const rootLength = new DataView(rawRequest.buffer).getUint32(9, false);
	const pathLength = new DataView(rawRequest.buffer).getUint32(13, false);
	expect(
		rawRequest.slice(17 + rootLength, 17 + rootLength + pathLength),
	).toEqual(new Uint8Array(rawName));
	if (created.status === 0) {
		expect(rawRead).toEqual({ ok: true, value: textBytes("raw-name") });
	} else {
		expect(rawRead.ok).toBe(false);
		if (!rawRead.ok)
			expect(["invalid_input", "not_found"]).toContain(rawRead.error.code);
	}
});

test("nonregular handles are refused without blocking", async () => {
	const directory = join(filesystemRoot, "not-a-file");
	const fifo = join(filesystemRoot, "named-pipe");
	mkdirSync(directory);
	const created = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
	if (created.error) throw created.error;
	if (created.status !== 0) throw new Error(`mkfifo failed: ${created.stderr}`);

	const directoryRead = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("not-a-file"),
		maxBytes: 128,
	});
	const fifoRead = await readToolFileBytes(host, {
		root: textBytes(filesystemRoot),
		path: textBytes("named-pipe"),
		maxBytes: 128,
	});
	expect(directoryRead.ok).toBe(false);
	if (!directoryRead.ok) expect(directoryRead.error.code).toBe("invalid_input");
	expect(fifoRead.ok).toBe(false);
	if (!fifoRead.ok) expect(fifoRead.error.code).toBe("invalid_input");
});

test("parent link swaps never redirect the opened path outside the root", async () => {
	const parent = join(filesystemRoot, "swap-parent");
	const alternate = join(outsideRoot, "swap-alternate");
	const holding = join(filesystemRoot, ".swap-holding");
	mkdirSync(parent);
	mkdirSync(alternate);
	writeFileSync(join(parent, "probe"), "inside");
	writeFileSync(join(alternate, "probe"), "outside");
	const parentLink = join(filesystemRoot, "swap-link");
	symlinkSync(alternate, parentLink);

	let swapping = true;
	const swapTask = (async () => {
		while (swapping) {
			renameSync(parent, holding);
			renameSync(parentLink, parent);
			renameSync(holding, parentLink);
			await Bun.sleep(0);
		}
	})();
	const payload = encodeTestRequest(
		2,
		textBytes(filesystemRoot),
		textBytes("swap-parent/probe"),
		128,
	);
	let report = "";
	try {
		report = await runParentSwapDriver(payload);
	} finally {
		swapping = false;
		await swapTask;
	}
	expect(report).toMatch(/inside=\d+/);
});

test("FileSystemPort adapts text paths and rejects non-Unicode JS strings", async () => {
	writeFileSync(join(filesystemRoot, "controller.txt"), "controller");
	const filesystem = createReadFileSystemPort(host);
	const read = await filesystem.readFile({
		root: filesystemRoot,
		path: "controller.txt",
		maxBytes: 64,
	});
	expect(read).toEqual({ ok: true, value: textBytes("controller") });
	const badPath = await filesystem.readFile({
		root: filesystemRoot,
		path: "bad\ud800name",
		maxBytes: 64,
	});
	expect(badPath.ok).toBe(false);
	if (!badPath.ok) expect(badPath.error.code).toBe("invalid_input");
});

test("native and TypeScript status values stay aligned", () => {
	expect(FileSystemStatus.outsideRoot).toBe(4);
	expect(FileSystemStatus.notRegular).toBe(5);
});
