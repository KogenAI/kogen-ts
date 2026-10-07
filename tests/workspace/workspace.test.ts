import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
} from "../../packages/core/src/fs/read";
import { createPrivateGitRepository } from "../../packages/core/src/git/repository";
import { cloneFreshWorkspace } from "../../packages/core/src/workspace/clone";
import { checkGitIgnore } from "../../packages/core/src/workspace/ignore";
import { snapshotWorkspace } from "../../packages/core/src/workspace/snapshot";

const root = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
let scratch = "";
let gitExecutable = "";
let filesystemDriver = "";

function testEnvironment(home = scratch): Record<string, string> {
	return {
		PATH: `${dirname(gitExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
		HOME: home,
		TMPDIR: scratch,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function spawnGit(
	argv: readonly string[],
	options: { readonly cwd: string; readonly input?: Uint8Array },
) {
	const result = spawnSync(gitExecutable, [...argv], {
		cwd: options.cwd,
		env: testEnvironment(),
		...(options.input === undefined ? {} : { input: options.input }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`fixture Git command failed (${result.status}): ${argv.join(" ")}\n${result.stderr.toString()}`,
		);
	return new Uint8Array(result.stdout);
}

const processPort: ProcessPort = {
	async run(request: ProcessRequest) {
		const result = spawnSync(request.argv[0] ?? "", request.argv.slice(1), {
			cwd: request.cwd,
			env: request.env,
			...(request.stdin === undefined ? {} : { input: request.stdin }),
			maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
			timeout: request.timeoutMilliseconds,
		});
		if (
			(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
		) {
			const value: ProcessResult = {
				exitCode: null,
				signal: "SIGTERM",
				stdout: new Uint8Array(result.stdout ?? []),
				stderr: new Uint8Array(result.stderr ?? []),
				timedOut: true,
			};
			return { ok: true, value };
		}
		if (result.error)
			return {
				ok: false as const,
				error: {
					code: "unavailable" as const,
					message: `Fixture process failed: ${result.error.message}`,
					retryable: false,
				},
			};
		const value: ProcessResult = {
			exitCode: result.status,
			signal: result.signal,
			stdout: new Uint8Array(result.stdout),
			stderr: new Uint8Array(result.stderr),
			timedOut: false,
		};
		return { ok: true, value };
	},
};

const filesystemHost: FileSystemHostRequest = {
	async request(operation, payload) {
		if (operation !== FILESYSTEM_HOST_OPERATION)
			throw new Error(`unexpected filesystem operation ${operation}`);
		const result = spawnSync(filesystemDriver, [], {
			input: payload,
			maxBuffer: 2 * 1024 * 1024,
			timeout: 30_000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`filesystem test driver failed (${result.status}): ${result.stderr.toString()}`,
			);
		return new Uint8Array(result.stdout);
	},
};

function compileFilesystemDriver(output: string): void {
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
			"tests/workspace/workspace-driver.c",
			"-o",
			output,
		],
		{ cwd: root, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`workspace helper compile failed: ${result.stderr}`);
}

function createSourceRepository(
	format: "sha1" | "sha256",
	name: string,
): { readonly repository: string; readonly baseCommit: string } {
	const repository = join(scratch, name);
	mkdirSync(repository, { mode: 0o700 });
	spawnGit(
		["init", "--initial-branch=main", `--object-format=${format}`, "."],
		{ cwd: repository },
	);
	spawnGit(["config", "user.name", "Workspace fixture"], { cwd: repository });
	spawnGit(["config", "user.email", "workspace@example.invalid"], {
		cwd: repository,
	});
	spawnGit(["config", "commit.gpgsign", "false"], { cwd: repository });
	mkdirSync(join(repository, "nested"));
	writeFileSync(
		join(repository, ".gitignore"),
		"tracked.log\n*.cache\nignored-dir/\n",
	);
	writeFileSync(join(repository, "src.txt"), "base source\n");
	writeFileSync(join(repository, "tracked.log"), "base tracked log\n");
	writeFileSync(join(repository, "delete.txt"), "delete me\n");
	writeFileSync(join(repository, "rename.txt"), "rename me\n");
	writeFileSync(join(repository, "script.sh"), "#!/bin/sh\necho base\n", {
		mode: 0o700,
	});
	writeFileSync(
		join(repository, "nested", ".gitignore"),
		"*.tmp\n!important.tmp\n",
	);
	symlinkSync("src.txt", join(repository, "link.txt"));
	spawnGit(["add", "-A"], { cwd: repository });
	spawnGit(["add", "-f", "tracked.log"], { cwd: repository });
	spawnGit(["commit", "-m", "base"], { cwd: repository });
	const baseCommit = new TextDecoder()
		.decode(spawnGit(["rev-parse", "HEAD"], { cwd: repository }))
		.trim();
	return { repository, baseCommit };
}

function checkedFixtureGit(argv: readonly string[], cwd: string): Uint8Array {
	return spawnGit(argv, { cwd });
}

function objectFiles(directory: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...objectFiles(fullPath));
		else if (entry.isFile()) files.push(fullPath);
	}
	return files;
}

function entryPath(entry: { readonly path: Uint8Array }): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(entry.path);
	} catch {
		return null;
	}
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-workspace-"));
	const git = Bun.which("git");
	if (git === null) throw new Error("Git is not available in PATH");
	gitExecutable = resolve(git);
	filesystemDriver = join(scratch, "workspace-driver");
	compileFilesystemDriver(filesystemDriver);
});

afterAll(() => {
	if (scratch.length > 0) rmSync(scratch, { recursive: true, force: true });
});

test("fresh local clones check out the saved base without shared object inodes", async () => {
	for (const format of ["sha1", "sha256"] as const) {
		const source = createSourceRepository(format, `clone-source-${format}`);
		const workspace = join(scratch, `clone-${format}`);
		const cloned = await cloneFreshWorkspace(processPort, {
			sourceRepository: source.repository,
			destination: workspace,
			baseCommit: source.baseCommit,
			executable: gitExecutable,
			environment: testEnvironment(),
		});
		expect(cloned.ok).toBe(true);
		if (!cloned.ok) throw new Error(cloned.error.message);
		expect(cloned.value.headCommit).toBe(source.baseCommit);
		expect(cloned.value.objectFormat).toBe(format);
		const symbolicHead = spawnSync(
			gitExecutable,
			["symbolic-ref", "-q", "HEAD"],
			{ cwd: workspace, env: testEnvironment(), maxBuffer: 1024 },
		);
		if (symbolicHead.error) throw symbolicHead.error;
		expect(symbolicHead.status).toBe(1);
		const sourceObjects = objectFiles(
			join(source.repository, ".git", "objects"),
		);
		const clonedObjects = objectFiles(join(workspace, ".git", "objects"));
		expect(sourceObjects.length).toBeGreaterThan(0);
		expect(clonedObjects.length).toBeGreaterThan(0);
		const sourceInodes = new Set(
			sourceObjects.map((path) => {
				const stat = statSync(path);
				return `${stat.dev}:${stat.ino}`;
			}),
		);
		for (const path of clonedObjects) {
			const stat = statSync(path);
			expect(sourceInodes.has(`${stat.dev}:${stat.ino}`)).toBe(false);
		}
	}
});

test("snapshot uses saved base, real ignore rules, raw blobs, modes, links, and deletions", async () => {
	for (const format of ["sha1", "sha256"] as const) {
		const source = createSourceRepository(format, `snapshot-source-${format}`);
		const workspace = join(scratch, `snapshot-${format}`);
		const clone = await cloneFreshWorkspace(processPort, {
			sourceRepository: source.repository,
			destination: workspace,
			baseCommit: source.baseCommit,
			executable: gitExecutable,
			environment: testEnvironment(),
		});
		if (!clone.ok) throw new Error(clone.error.message);
		checkedFixtureGit(["config", "user.name", "Builder fixture"], workspace);
		checkedFixtureGit(
			["config", "user.email", "builder@example.invalid"],
			workspace,
		);
		writeFileSync(
			join(workspace, "src.txt"),
			Buffer.from([0x6e, 0x65, 0x77, 0x00, 0xff]),
		);
		writeFileSync(join(workspace, "tracked.log"), "edited tracked ignored\n");
		unlinkSync(join(workspace, "delete.txt"));
		writeFileSync(join(workspace, "renamed.txt"), "rename me\n");
		unlinkSync(join(workspace, "rename.txt"));
		chmodSync(join(workspace, "script.sh"), 0o755);
		symlinkSync("../outside-target", join(workspace, "new-link"));
		writeFileSync(join(workspace, "new.cache"), "ignored untracked\n");
		writeFileSync(join(workspace, "nested", "drop.tmp"), "ignored nested\n");
		writeFileSync(
			join(workspace, "nested", "important.tmp"),
			"negated nested\n",
		);
		mkdirSync(join(workspace, "ignored-dir"));
		writeFileSync(join(workspace, "ignored-dir", ".gitignore"), "!keep.txt\n");
		writeFileSync(
			join(workspace, "ignored-dir", "keep.txt"),
			"still ignored\n",
		);
		writeFileSync(
			join(workspace, ".gitattributes"),
			"*.txt filter=workspace-poison\n",
		);
		checkedFixtureGit(["add", "-A"], workspace);
		checkedFixtureGit(["commit", "-m", "builder moved HEAD"], workspace);
		const builderHead = new TextDecoder()
			.decode(checkedFixtureGit(["rev-parse", "HEAD"], workspace))
			.trim();
		expect(builderHead).not.toBe(source.baseCommit);
		checkedFixtureGit(["rm", "--cached", "-q", "src.txt"], workspace);
		const finalSourceBytes = Buffer.from([
			0x66, 0x69, 0x6e, 0x61, 0x6c, 0x00, 0xff,
		]);
		writeFileSync(join(workspace, "src.txt"), finalSourceBytes);
		const largeContents = Buffer.alloc(1_000_000, 0x5a);
		writeFileSync(join(workspace, "large.bin"), largeContents);

		const excluded = join(scratch, `hostile-excludes-${format}`);
		writeFileSync(excluded, "src.txt\nnested/important.tmp\n");
		writeFileSync(
			join(workspace, ".git", "config"),
			`${readFileSync(join(workspace, ".git", "config"), "utf8")}\n[core]\n\texcludesFile = ${excluded}\n[filter "workspace-poison"]\n\tclean = /bin/sh -c 'touch ${join(scratch, `filter-ran-${format}`)}; cat'\n\trequired = true\n`,
		);
		mkdirSync(join(workspace, ".git", "info"), { recursive: true });
		writeFileSync(
			join(workspace, ".git", "info", "exclude"),
			"src.txt\nnested/important.tmp\n",
		);
		const gitDirectory = join(scratch, `snapshot-metadata-${format}`);
		mkdirSync(gitDirectory, { mode: 0o700 });
		const privateRepositoryResult = await createPrivateGitRepository(
			processPort,
			{
				sourceRepository: source.repository,
				gitDirectory,
				workTree: workspace,
				executable: gitExecutable,
				environment: testEnvironment(),
			},
		);
		if (!privateRepositoryResult.ok)
			throw new Error(privateRepositoryResult.error.message);
		const privateRepository = privateRepositoryResult.value;
		const decisions = await checkGitIgnore(privateRepository, [
			new TextEncoder().encode("tracked.log"),
			new TextEncoder().encode("new.cache"),
			new TextEncoder().encode("nested/drop.tmp"),
			new TextEncoder().encode("nested/important.tmp"),
			new TextEncoder().encode("ignored-dir/keep.txt"),
			new TextEncoder().encode("src.txt"),
		]);
		expect(decisions.ok).toBe(true);
		if (!decisions.ok) throw new Error(decisions.error.message);
		expect(decisions.value.map((decision) => decision.ignored)).toEqual([
			true,
			true,
			true,
			false,
			true,
			false,
		]);

		const invalidName = spawnSync(
			filesystemDriver,
			["--create-invalid-name", workspace],
			{
				timeout: 30_000,
			},
		);
		if (invalidName.error) throw invalidName.error;
		expect(invalidName.status === 0 || invalidName.status === 72).toBe(true);

		const snapshot = await snapshotWorkspace({
			repository: privateRepository,
			sourceRepository: source.repository,
			baseCommit: source.baseCommit,
			filesystem: filesystemHost,
		});
		if (!snapshot.ok)
			throw new Error(`workspace snapshot failed: ${snapshot.error.message}`);
		expect(snapshot.ok).toBe(true);
		expect(snapshot.value.baseCommit).toBe(source.baseCommit);
		const paths = snapshot.value.indexEntries.map(entryPath);
		const pathSet = new Set(
			paths.filter((path): path is string => path !== null),
		);
		for (const included of [
			"src.txt",
			"large.bin",
			"tracked.log",
			"renamed.txt",
			"script.sh",
			"link.txt",
			"new-link",
			"nested/important.tmp",
		])
			expect(pathSet.has(included)).toBe(true);
		for (const omitted of [
			"delete.txt",
			"rename.txt",
			"new.cache",
			"nested/drop.tmp",
			"ignored-dir/keep.txt",
		])
			expect(pathSet.has(omitted)).toBe(false);
		const modes = new Map(
			snapshot.value.indexEntries.map((entry) => [
				entryPath(entry),
				entry.mode,
			]),
		);
		expect(modes.get("script.sh")).toBe("100755");
		expect(modes.get("link.txt")).toBe("120000");
		expect(modes.get("new-link")).toBe("120000");
		const changed = new Set(
			snapshot.value.changedPaths.map((path) => new TextDecoder().decode(path)),
		);
		expect(changed.has("delete.txt")).toBe(true);
		expect(changed.has("rename.txt")).toBe(true);
		expect(changed.has("renamed.txt")).toBe(true);
		const sourceBlob = await privateRepository.command(
			["show", `${snapshot.value.tree}:src.txt`],
			{ outputLimitBytes: 1024 },
		);
		expect(sourceBlob.ok).toBe(true);
		if (!sourceBlob.ok) throw new Error(sourceBlob.error.message);
		expect(sourceBlob.value.stdout).toEqual(finalSourceBytes);
		const largeEntry = snapshot.value.indexEntries.find(
			(entry) => entryPath(entry) === "large.bin",
		);
		expect(largeEntry).toBeDefined();
		const largeObjectId = new TextDecoder()
			.decode(
				checkedFixtureGit(
					["hash-object", "--no-filters", "--", "large.bin"],
					workspace,
				),
			)
			.trim();
		expect(largeEntry?.objectId).toBe(largeObjectId);
		const linkBlob = await privateRepository.command(
			["cat-file", "blob", `${snapshot.value.tree}:new-link`],
			{ outputLimitBytes: 1024 },
		);
		expect(linkBlob.ok).toBe(true);
		if (!linkBlob.ok) throw new Error(linkBlob.error.message);
		expect(new TextDecoder().decode(linkBlob.value.stdout)).toBe(
			"../outside-target",
		);
		const trackedLinkBlob = await privateRepository.command(
			["cat-file", "blob", `${snapshot.value.tree}:link.txt`],
			{ outputLimitBytes: 1024 },
		);
		expect(trackedLinkBlob.ok).toBe(true);
		if (!trackedLinkBlob.ok) throw new Error(trackedLinkBlob.error.message);
		expect(new TextDecoder().decode(trackedLinkBlob.value.stdout)).toBe(
			"src.txt",
		);
		expect(existsSync(join(scratch, `filter-ran-${format}`))).toBe(false);
		if (invalidName.status === 0)
			expect(
				snapshot.value.indexEntries.some(
					(entry) =>
						entry.path.byteLength === 5 &&
						entry.path[0] === 0x6e &&
						entry.path[1] === 0x61 &&
						entry.path[2] === 0x6d &&
						entry.path[3] === 0x65 &&
						entry.path[4] === 0xff,
				),
			).toBe(true);
	}
});
