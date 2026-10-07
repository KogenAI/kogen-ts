import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ControllerRuntime,
	createControllerRuntime,
} from "../../packages/cli/src/composition";
import { helpText } from "../../packages/cli/src/output";
import { FileSystemStatus } from "../../packages/core/src/fs/read";
import { parseProjectConfig } from "../../packages/core/src/project/schema";
import { YAML_MAX_BYTES } from "../../packages/core/src/yaml/preflight";

let scratch: string;
let runtime: ControllerRuntime;
beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "kts-foundation-"));
	const build = spawnSync(
		process.execPath,
		["--no-install", "tools/build-foundation.ts", scratch],
		{
			cwd: resolve(import.meta.dir, "../.."),
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	if (build.status !== 0) throw new Error(`${build.error ?? build.stderr}`);
	runtime = await createControllerRuntime(join(scratch, "kogen"));
}, 30_000);

afterAll(async () => {
	if (runtime) await runtime.close();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("compiled public help runs without a checkout or helper", () => {
	const executable = join(scratch, "kogen");
	const helper = join(
		scratch,
		`kogen-host-${process.platform}-${process.arch}`,
	);
	// A help route must never attempt to start the native helper.
	renameSync(helper, `${helper}.held`);
	try {
		const result = spawnSync(executable, ["help"], {
			cwd: tmpdir(),
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(helpText("kogen"));
		expect(result.stderr).toBe("");
	} finally {
		renameSync(`${helper}.held`, helper);
	}
});

test("production registration publishes, reads and removes without following a final link", async () => {
	const bytes = new TextEncoder().encode("inside");
	expect(
		await runtime.filesystem.writeFileAtomically({
			root: scratch,
			path: "published",
			bytes,
			mode: 0o600,
		}),
	).toEqual({ ok: true, value: undefined });
	expect(
		await runtime.filesystem.readFile({
			root: scratch,
			path: "published",
			maxBytes: 128,
		}),
	).toEqual({ ok: true, value: bytes });
	const sentinel = join(scratch, "sentinel");
	writeFileSync(sentinel, "sentinel");
	symlinkSync(sentinel, join(scratch, "link"));
	expect(
		(
			await runtime.filesystem.readFile({
				root: scratch,
				path: "link",
				maxBytes: 128,
			})
		).ok,
	).toBe(false);
	expect((await runtime.filesystem.removeFile(scratch, "link")).ok).toBe(true);
	expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
	expect((await runtime.filesystem.removeFile(scratch, "published")).ok).toBe(
		true,
	);
});

test("production supervisor and Git port run through the registered bridge", async () => {
	const processResult = await runtime.process.run({
		argv: ["/bin/sh", "-c", "printf inside; printf separate >&2"],
		cwd: scratch,
		env: { PATH: "/usr/bin:/bin" },
		timeoutMilliseconds: 3000,
		outputLimitBytes: 4096,
	});
	expect(processResult.ok).toBe(true);
	if (!processResult.ok) return;
	expect(processResult.value.exitCode).toBe(0);
	expect(new TextDecoder().decode(processResult.value.stdout)).toBe("inside");
	expect(new TextDecoder().decode(processResult.value.stderr)).toBe("separate");
	const git = await runtime.git.command({
		repository: scratch,
		argv: ["--version"],
		timeoutMilliseconds: 3000,
		outputLimitBytes: 4096,
	});
	expect(git.ok).toBe(true);
	if (git.ok)
		expect(new TextDecoder().decode(git.value.stdout)).toMatch(/^git version /);
});

test("production bridge preserves the exact YAML byte boundary and oversized rejection", async () => {
	const prefix = "name: kt\nchecks: []\n#";
	const path = "project.yaml";
	writeFileSync(
		join(scratch, path),
		prefix + "x".repeat(YAML_MAX_BYTES - prefix.length),
	);
	const atLimit = await runtime.filesystem.readFile({
		root: scratch,
		path,
		maxBytes: YAML_MAX_BYTES + 1,
	});
	expect(atLimit.ok).toBe(true);
	if (atLimit.ok) {
		expect(atLimit.value.byteLength).toBe(YAML_MAX_BYTES);
		expect(parseProjectConfig(atLimit.value).ok).toBe(true);
	}
	writeFileSync(
		join(scratch, path),
		prefix + "x".repeat(YAML_MAX_BYTES + 1 - prefix.length),
	);
	const oneOver = await runtime.filesystem.readFile({
		root: scratch,
		path,
		maxBytes: YAML_MAX_BYTES + 1,
	});
	expect(oneOver.ok).toBe(true);
	if (oneOver.ok) expect(parseProjectConfig(oneOver.value).ok).toBe(false);
	writeFileSync(
		join(scratch, path),
		prefix + "x".repeat(YAML_MAX_BYTES + 2 - prefix.length),
	);
	const twoOver = await runtime.filesystem.readFile({
		root: scratch,
		path,
		maxBytes: YAML_MAX_BYTES + 1,
	});
	expect(twoOver.ok).toBe(false);
	if (!twoOver.ok)
		expect(twoOver.error.cause).toEqual({ status: FileSystemStatus.tooLarge });
});
