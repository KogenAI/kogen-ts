import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	appendFileBytes,
	type BytePathPublishRequest,
	createPublicationFileSystemPort,
	FILESYSTEM_PUBLISH_HOST_OPERATION,
	publishFileAtomically,
	removePathNoFollow,
} from "../../packages/core/src/fs/publish";
import type { FileSystemHostRequest } from "../../packages/core/src/fs/read";
import { restorePathNoFollow } from "../../packages/core/src/fs/restore";

const repositoryRoot = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
let scratch = "";
let workspace = "";
let outside = "";
let driver = "";

function compileDriver(output: string): void {
	const result = spawnSync(
		compiler,
		[
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-DKOGEN_FS_PUBLISH_TESTING",
			"-I",
			"native",
			"native/paths.c",
			"native/publish.c",
			"tests/fs-publish/publish-driver.c",
			"-o",
			output,
		],
		{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`publication driver compile failed: ${result.stderr || result.stdout}`,
		);
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function request(
	root: string,
	path: string,
	value: string,
): BytePathPublishRequest {
	return { root: bytes(root), path: bytes(path), bytes: bytes(value) };
}

function runDriver(payload: Uint8Array, args: string[] = []) {
	const result = spawnSync(driver, args, {
		input: payload,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	return result;
}

const host: FileSystemHostRequest = {
	async request(operation, payload) {
		if (operation !== FILESYSTEM_PUBLISH_HOST_OPERATION)
			throw new Error(`unexpected filesystem host operation ${operation}`);
		const result = runDriver(payload);
		if (result.status !== 0)
			throw new Error(
				`publication driver failed (${result.status}): ${result.stderr.toString()}`,
			);
		return new Uint8Array(result.stdout);
	},
};

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-fs-publish-"));
	workspace = join(scratch, "workspace");
	outside = join(scratch, "outside");
	driver = join(scratch, "fs-publish-driver");
	mkdirSync(workspace, { mode: 0o700 });
	mkdirSync(outside, { mode: 0o700 });
	compileDriver(driver);
});

afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("atomic publication uses exclusive private temps and preserves executable state", async () => {
	const directory = join(workspace, "atomic");
	mkdirSync(directory, { mode: 0o700 });
	const first = await publishFileAtomically(
		host,
		request(workspace, "atomic/program", "first bytes"),
		0o600,
	);
	expect(first).toEqual({ ok: true, value: undefined });
	expect(readFileSync(join(directory, "program"), "utf8")).toBe("first bytes");
	expect(statSync(join(directory, "program")).mode & 0o777).toBe(0o600);

	const second = await publishFileAtomically(
		host,
		request(workspace, "atomic/program", "new executable"),
		0o700,
	);
	expect(second.ok).toBe(true);
	expect(readFileSync(join(directory, "program"), "utf8")).toBe(
		"new executable",
	);
	expect(statSync(join(directory, "program")).mode & 0o777).toBe(0o700);
	expect(readdirSync(directory)).toEqual(["program"]);

	const port = createPublicationFileSystemPort(host);
	const adapted = await port.writeFileAtomically({
		root: workspace,
		path: "atomic/nonexec",
		bytes: bytes("private"),
		mode: 0o644,
	});
	expect(adapted.ok).toBe(true);
	expect(statSync(join(directory, "nonexec")).mode & 0o777).toBe(0o600);
	const executable = await port.writeFileAtomically({
		root: workspace,
		path: "atomic/exec",
		bytes: bytes("private executable"),
		mode: 0o755,
	});
	expect(executable.ok).toBe(true);
	expect(statSync(join(directory, "exec")).mode & 0o777).toBe(0o700);
});

test("append creates private files and appends without replacing earlier bytes", async () => {
	mkdirSync(join(workspace, "journal"), { mode: 0o700 });
	const first = await appendFileBytes(
		host,
		request(workspace, "journal/events", "one\n"),
	);
	const second = await appendFileBytes(
		host,
		request(workspace, "journal/events", "two\n"),
	);
	expect(first.ok).toBe(true);
	expect(second.ok).toBe(true);
	expect(readFileSync(join(workspace, "journal/events"), "utf8")).toBe(
		"one\ntwo\n",
	);
	expect(statSync(join(workspace, "journal/events")).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(workspace, "journal"))).toEqual(["events"]);
});

test("symlink parents are rejected and final-link removal leaves external bytes alone", async () => {
	const sentinel = join(outside, "sentinel");
	writeFileSync(sentinel, "must remain unchanged", { mode: 0o600 });
	symlinkSync(outside, join(workspace, "outside-parent"));
	symlinkSync(sentinel, join(workspace, "final-link"));
	const parentPath = request(workspace, "outside-parent/new-file", "bad");
	const writeThroughParent = await publishFileAtomically(
		host,
		parentPath,
		0o600,
	);
	const appendThroughParent = await appendFileBytes(host, parentPath);
	const restoreThroughParent = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("outside-parent/new-file"),
		entry: { kind: "regular", bytes: bytes("bad"), executable: false },
	});
	const removeThroughParent = await removePathNoFollow(
		host,
		bytes(workspace),
		bytes("outside-parent/sentinel"),
	);
	expect(writeThroughParent.ok).toBe(false);
	expect(appendThroughParent.ok).toBe(false);
	expect(restoreThroughParent.ok).toBe(false);
	expect(removeThroughParent.ok).toBe(false);
	expect(
		lstatSync(join(outside, "new-file"), { throwIfNoEntry: false }),
	).toBeUndefined();

	const finalWrite = await publishFileAtomically(
		host,
		request(workspace, "final-link", "must not follow"),
		0o600,
	);
	const finalAppend = await appendFileBytes(
		host,
		request(workspace, "final-link", "must not append"),
	);
	expect(finalWrite.ok).toBe(false);
	expect(finalAppend.ok).toBe(false);
	const removed = await removePathNoFollow(
		host,
		bytes(workspace),
		bytes("final-link"),
	);
	expect(removed.ok).toBe(true);
	expect(readFileSync(sentinel, "utf8")).toBe("must remain unchanged");
	expect(lstatSync(join(workspace, "outside-parent")).isSymbolicLink()).toBe(
		true,
	);
});

test("restore retains regular executable mode and symlink target bytes", async () => {
	mkdirSync(join(workspace, "restored"), { mode: 0o700 });
	const sentinel = join(outside, "restore-sentinel");
	writeFileSync(sentinel, "external sentinel", { mode: 0o600 });
	const executable = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored/tool"),
		entry: { kind: "regular", bytes: bytes("#!/bin/sh\n"), executable: true },
	});
	expect(executable.ok).toBe(true);
	expect(readFileSync(join(workspace, "restored/tool"), "utf8")).toBe(
		"#!/bin/sh\n",
	);
	expect(statSync(join(workspace, "restored/tool")).mode & 0o777).toBe(0o700);

	symlinkSync(sentinel, join(workspace, "link-to-sentinel"));
	const replaced = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("link-to-sentinel"),
		entry: {
			kind: "regular",
			bytes: bytes("restored file"),
			executable: false,
		},
	});
	expect(replaced.ok).toBe(true);
	expect(lstatSync(join(workspace, "link-to-sentinel")).isFile()).toBe(true);
	expect(readFileSync(sentinel, "utf8")).toBe("external sentinel");

	const linkTarget = bytes(sentinel);
	const restoredLink = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored-link"),
		entry: { kind: "symlink", target: linkTarget },
	});
	expect(restoredLink.ok).toBe(true);
	expect(lstatSync(join(workspace, "restored-link")).isSymbolicLink()).toBe(
		true,
	);
	expect(readlinkSync(join(workspace, "restored-link"))).toBe(sentinel);
	expect(readFileSync(sentinel, "utf8")).toBe("external sentinel");
	symlinkSync(sentinel, join(workspace, "replace-link"));
	const replacedLink = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("replace-link"),
		entry: { kind: "symlink", target: bytes("relative-target") },
	});
	expect(replacedLink.ok).toBe(true);
	expect(readlinkSync(join(workspace, "replace-link"))).toBe("relative-target");
	expect(readFileSync(sentinel, "utf8")).toBe("external sentinel");

	const directory = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored/directory"),
		entry: { kind: "directory" },
	});
	expect(directory.ok).toBe(true);
	chmodSync(join(workspace, "restored/directory"), 0o755);
	const restoredDirectory = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored/directory"),
		entry: { kind: "directory" },
	});
	expect(restoredDirectory.ok).toBe(true);
	expect(statSync(join(workspace, "restored/directory")).mode & 0o777).toBe(
		0o700,
	);
	const absent = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored-link"),
		entry: { kind: "absent" },
	});
	expect(absent.ok).toBe(true);
	expect(
		lstatSync(join(workspace, "restored-link"), { throwIfNoEntry: false }),
	).toBeUndefined();
	expect(readFileSync(sentinel, "utf8")).toBe("external sentinel");
});

function crashRequest(path: string): Uint8Array {
	const payload = new Uint8Array(
		16 + Buffer.byteLength(workspace) + Buffer.byteLength(path) + 3,
	);
	const view = new DataView(payload.buffer);
	const rootBytes = bytes(workspace);
	const pathBytes = bytes(path);
	payload[0] = 1;
	view.setUint16(2, 0o600, false);
	view.setUint32(4, rootBytes.byteLength, false);
	view.setUint32(8, pathBytes.byteLength, false);
	view.setUint32(12, 3, false);
	payload.set(rootBytes, 16);
	payload.set(pathBytes, 16 + rootBytes.byteLength);
	payload.set(bytes("new"), 16 + rootBytes.byteLength + pathBytes.byteLength);
	return payload;
}

test("rename crash matrix exposes only the old or fully written new file", () => {
	for (const phase of [1, 2, 3, 4, 5]) {
		const directory = join(workspace, `crash-matrix-${phase}`);
		mkdirSync(directory, { mode: 0o700 });
		const target = join(directory, "state");
		const payload = crashRequest(`crash-matrix-${phase}/state`);
		writeFileSync(target, "old", { mode: 0o600 });
		const result = runDriver(payload, ["--crash-after", String(phase)]);
		expect(result.status).toBe(80 + phase);
		expect(readFileSync(target, "utf8")).toBe(phase < 4 ? "old" : "new");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		if (phase < 4) {
			const temporaryNames = readdirSync(directory).filter((name) =>
				name.startsWith(".kogen-pub-"),
			);
			expect(temporaryNames.length).toBeGreaterThan(0);
			for (const name of temporaryNames)
				expect(lstatSync(join(directory, name)).mode & 0o777).toBe(0o600);
		} else {
			expect(
				readdirSync(directory).filter((name) => name.startsWith(".kogen-pub-")),
			).toEqual([]);
		}
	}
});

test("a racing parent link cannot redirect publication to the external sentinel", async () => {
	const actualParent = join(workspace, "racing-parent");
	const holdingParent = join(workspace, ".racing-parent-holding");
	const externalTarget = join(outside, "target");
	const linkPath = join(workspace, "racing-link");
	mkdirSync(actualParent, { mode: 0o700 });
	writeFileSync(join(actualParent, "target"), "inside", { mode: 0o600 });
	writeFileSync(externalTarget, "external sentinel", { mode: 0o600 });
	symlinkSync(outside, linkPath);
	let swapping = true;
	const swapTask = (async () => {
		while (swapping) {
			try {
				rmSync(holdingParent, { recursive: true, force: true });
				renameSync(actualParent, holdingParent);
				renameSync(linkPath, actualParent);
				renameSync(holdingParent, linkPath);
			} catch {
				// The writer may be between components; continue the adversarial swap.
			}
			await Bun.sleep(0);
		}
	})();
	try {
		for (let index = 0; index < 40; index++) {
			await publishFileAtomically(
				host,
				request(workspace, "racing-parent/target", `inside-${index}`),
				0o600,
			);
		}
	} finally {
		swapping = false;
		await swapTask;
	}
	expect(readFileSync(externalTarget, "utf8")).toBe("external sentinel");
});

test("restore and removal reject final directory type changes", async () => {
	const sentinel = join(outside, "directory-type-sentinel");
	writeFileSync(sentinel, "unchanged", { mode: 0o600 });
	const result = await restorePathNoFollow(host, {
		root: bytes(workspace),
		path: bytes("restored"),
		entry: {
			kind: "regular",
			bytes: bytes("replace directory"),
			executable: false,
		},
	});
	expect(result.ok).toBe(false);
	const missing = await removePathNoFollow(
		host,
		bytes(workspace),
		bytes("absent-entry"),
	);
	expect(missing.ok).toBe(true);
	expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
});
