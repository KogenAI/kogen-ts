import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
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
import { FILESYSTEM_PUBLISH_HOST_OPERATION } from "../../packages/core/src/fs/publish";
import {
	FILESYSTEM_HOST_OPERATION,
	type FileSystemHostRequest,
} from "../../packages/core/src/fs/read";
import { buildProtectedManifest } from "../../packages/core/src/gate/manifest";
import {
	captureProtectedWorkspace,
	guardProtectedManifest,
	listProtectedWorkspacePaths,
	protectedWriteRefusal,
	restoreProtectedPaths,
	staleCheckoutPaths,
} from "../../packages/core/src/gate/protect";
import { scopeWarnings } from "../../packages/core/src/gate/scope";
import type { PrivateGitRepository } from "../../packages/core/src/git/repository";
import { createPrivateGitRepository } from "../../packages/core/src/git/repository";
import type { ProjectConfig } from "../../packages/core/src/project/schema";

const repositoryRoot = resolve(import.meta.dir, "../..");
const compiler = "/usr/bin/cc";
const intentBytes = new TextEncoder().encode("---\ntitle: Greet\n---\n");
const testBytes = new TextEncoder().encode("t_A1() { true; }\n");
let scratch = "";
let gitExecutable = "";
let filesystemDriver = "";

interface Fixture {
	readonly worktree: string;
	readonly outside: string;
	readonly outsideFile: string;
	readonly baseCommit: string;
	readonly repository: PrivateGitRepository;
	readonly project: Pick<
		ProjectConfig,
		| "protectedPaths"
		| "gatePaths"
		| "checks"
		| "acceptanceChecks"
		| "fix"
		| "acceptance"
	>;
}

function fixtureEnvironment(home = scratch): Record<string, string> {
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

function runGit(
	argv: readonly string[],
	options: { readonly cwd: string; readonly input?: Uint8Array },
): Uint8Array {
	const result = spawnSync(gitExecutable, [...argv], {
		cwd: options.cwd,
		env: fixtureEnvironment(),
		...(options.input === undefined ? {} : { input: options.input }),
		maxBuffer: 4 * 1024 * 1024,
		timeout: 30_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`fixture Git failed (${result.status}): ${argv.join(" ")}\n${result.stderr.toString()}`,
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
			return { ok: true as const, value };
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
		return { ok: true as const, value };
	},
};

const filesystemHost: FileSystemHostRequest = {
	async request(operation, payload) {
		const action =
			operation === FILESYSTEM_HOST_OPERATION
				? "read"
				: operation === FILESYSTEM_PUBLISH_HOST_OPERATION
					? "publish"
					: null;
		if (action === null)
			throw new Error(`unexpected filesystem operation ${operation}`);
		const result = spawnSync(filesystemDriver, [action], {
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
			"native/publish.c",
			"tests/protection/protection-driver.c",
			"-o",
			output,
		],
		{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`protection filesystem helper compile failed: ${result.stderr}`,
		);
}

function writeFixtureFiles(worktree: string): void {
	for (const directory of [
		".kogen",
		"checks",
		"docs",
		"ci/build",
		"tools",
		"lib",
	])
		mkdirSync(join(worktree, directory), { recursive: true, mode: 0o700 });
	const files: Readonly<Record<string, string>> = {
		".kogen/project.yaml": "name: fixture\nchecks: []\n",
		Makefile: "lint:\n\ttrue\n",
		"checks/unit.sh": "exit 0\n",
		"checks/lint.sh": "exit 0\n",
		"checks/acceptance-check.sh": "exit 0\n",
		"docs/guide.md": "# Guide\n",
		"ci/build/release.yml": "name: build\n",
		"tools/format.py": "print('format')\n",
		"run-acceptance.sh": "exit 0\n",
		"lib/greet.txt": "Hello!\n",
	};
	for (const [path, contents] of Object.entries(files))
		writeFileSync(join(worktree, path), contents, { mode: 0o600 });
	chmodSync(join(worktree, "checks/unit.sh"), 0o700);
}

async function createFixture(name: string): Promise<Fixture> {
	const worktree = join(scratch, name);
	const outside = join(scratch, `${name}-outside`);
	mkdirSync(worktree, { mode: 0o700 });
	mkdirSync(outside, { mode: 0o700 });
	writeFileSync(join(outside, "sentinel.txt"), "must remain untouched\n");
	writeFixtureFiles(worktree);
	runGit(["init", "-q", "--initial-branch=main", "--object-format=sha1", "."], {
		cwd: worktree,
	});
	runGit(["config", "user.name", "Protection fixture"], { cwd: worktree });
	runGit(["config", "user.email", "protection@example.invalid"], {
		cwd: worktree,
	});
	runGit(["config", "commit.gpgsign", "false"], { cwd: worktree });
	runGit(["add", "-A"], { cwd: worktree });
	runGit(["commit", "-q", "-m", "base"], { cwd: worktree });
	const baseCommit = new TextDecoder()
		.decode(runGit(["rev-parse", "HEAD"], { cwd: worktree }))
		.trim();
	mkdirSync(join(worktree, ".kogen/intents/greet"), {
		recursive: true,
		mode: 0o700,
	});
	mkdirSync(join(worktree, ".kogen/acceptance"), {
		recursive: true,
		mode: 0o700,
	});
	writeFileSync(join(worktree, ".kogen/intents/greet/intent.md"), intentBytes, {
		mode: 0o600,
	});
	writeFileSync(join(worktree, ".kogen/acceptance/greet.t.sh"), testBytes, {
		mode: 0o600,
	});
	const gitDirectory = join(scratch, `${name}-metadata`);
	mkdirSync(gitDirectory, { mode: 0o700 });
	const privateResult = await createPrivateGitRepository(processPort, {
		sourceRepository: worktree,
		gitDirectory,
		workTree: worktree,
		executable: gitExecutable,
		environment: fixtureEnvironment(),
	});
	if (!privateResult.ok) throw new Error(privateResult.error.message);
	const project = {
		protectedPaths: ["Makefile", "docs/**", "SECRET.txt"],
		gatePaths: ["ci/**/*.yml"],
		checks: [
			{ name: "lint", argv: ["make", "-s", "lint"], timeoutMs: 60_000 },
			{ name: "unit", argv: ["sh", "checks/unit.sh"], timeoutMs: 60_000 },
		],
		acceptanceChecks: [
			{
				name: "acceptance",
				argv: ["sh", "checks/acceptance-check.sh"],
				timeoutMs: 60_000,
			},
		],
		fix: [
			{
				name: "format",
				argv: ["python3", "./tools/format.py"],
				timeoutMs: 60_000,
			},
		],
		acceptance: {
			adapter: "command" as const,
			timeoutMs: 60_000,
			run: ["sh", "run-acceptance.sh", "{path}"],
		},
	} satisfies Pick<
		ProjectConfig,
		| "protectedPaths"
		| "gatePaths"
		| "checks"
		| "acceptanceChecks"
		| "fix"
		| "acceptance"
	>;
	return {
		worktree,
		outside,
		outsideFile: join(outside, "sentinel.txt"),
		baseCommit,
		repository: privateResult.value,
		project,
	};
}

async function manifestFor(fixture: Fixture, changesGate = false) {
	const checkout = await listProtectedWorkspacePaths(
		filesystemHost,
		fixture.worktree,
	);
	if (!checkout.ok) throw new Error(checkout.error.message);
	const result = await buildProtectedManifest({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		baseCommit: fixture.baseCommit,
		project: fixture.project,
		changesGate,
		intentPath: ".kogen/intents/greet/intent.md",
		intentBytes,
		testPath: ".kogen/acceptance/greet.t.sh",
		testBytes,
		checkoutPaths: checkout.value
			.filter((entry) => entry.kind !== "directory")
			.map((entry) => entry.path),
	});
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kogen-protection-"));
	const git = Bun.which("git");
	if (git === null) throw new Error("Git is not available in PATH");
	gitExecutable = resolve(git);
	filesystemDriver = join(scratch, "protection-driver");
	compileFilesystemDriver(filesystemDriver);
});

afterAll(() => {
	if (scratch.length > 0) rmSync(scratch, { recursive: true, force: true });
});

test("manifest expands protected globs and effective gate program paths from the saved base", async () => {
	const fixture = await createFixture("manifest");
	const manifest = await manifestFor(fixture);
	expect(Object.keys(manifest.hashes).sort()).toEqual(
		[
			".kogen/acceptance/greet.t.sh",
			".kogen/intents/greet/intent.md",
			".kogen/project.yaml",
			"Makefile",
			"SECRET.txt",
			"checks/acceptance-check.sh",
			"checks/unit.sh",
			"ci/build/release.yml",
			"docs/guide.md",
			"run-acceptance.sh",
			"tools/format.py",
		].sort(),
	);
	expect(manifest.hashes["SECRET.txt"]).toBe(
		"23518d434b5b519ad017aaaa4ca8e63cc5402a8051dec5242c918913969cfeec",
	);
	expect(
		manifest.entries.some((entry) => entry.path === "checks/lint.sh"),
	).toBe(false);

	const changedGate = await manifestFor(fixture, true);
	expect(Object.keys(changedGate.hashes).sort()).toEqual(
		[
			".kogen/acceptance/greet.t.sh",
			".kogen/intents/greet/intent.md",
			"Makefile",
			"SECRET.txt",
			"docs/guide.md",
		].sort(),
	);
	expect(protectedWriteRefusal(manifest, "./ci/build/release.yml")).toBe(
		"ERROR: ci/build/release.yml is approved and protected; change the implementation instead.",
	);
	expect(protectedWriteRefusal(changedGate, "ci/build/release.yml")).toBeNull();
	expect(protectedWriteRefusal(manifest, "docs/new.md")).toBe(
		"ERROR: docs/new.md is approved and protected; change the implementation instead.",
	);
	expect(protectedWriteRefusal(manifest, "src/feature.ts")).toBeNull();
});

test("approval detects stale non-own protected bytes against the origin base", async () => {
	const fixture = await createFixture("stale");
	const manifest = await manifestFor(fixture);
	writeFileSync(join(fixture.worktree, "Makefile"), "lint:\n\tfalse\n");
	const state = await captureProtectedWorkspace({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		baseCommit: fixture.baseCommit,
		filesystem: filesystemHost,
		manifest,
	});
	if (!state.ok) throw new Error(state.error.message);
	expect(staleCheckoutPaths(manifest, state.value)).toContain("Makefile");
});

test("restorer repairs hostile final links, parent links and file-to-directory swaps without following links", async () => {
	const fixture = await createFixture("hostile");
	const manifest = await manifestFor(fixture);
	const savedDocs = join(fixture.worktree, "docs-saved");
	renameSync(join(fixture.worktree, "docs"), savedDocs);
	symlinkSync(fixture.outside, join(fixture.worktree, "docs"));
	unlinkSync(join(fixture.worktree, "Makefile"));
	symlinkSync(fixture.outsideFile, join(fixture.worktree, "Makefile"));
	unlinkSync(join(fixture.worktree, "checks/unit.sh"));
	mkdirSync(join(fixture.worktree, "checks/unit.sh"));
	symlinkSync(
		fixture.outsideFile,
		join(fixture.worktree, "checks/unit.sh/escape"),
	);

	const restored = await restoreProtectedPaths({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		manifest,
		filesystem: filesystemHost,
		rung: "R1",
		previousRestoreCount: 0,
	});
	if (!restored.ok) throw new Error(restored.error.message);
	expect(restored.value.limitReached).toBe(true);
	expect(restored.value.restoreCount).toBeGreaterThanOrEqual(4);
	expect(restored.value.events.map((event) => event.path)).toContain(
		"Makefile",
	);
	expect(restored.value.events.map((event) => event.path)).toContain(
		"docs/guide.md",
	);
	expect(restored.value.events.map((event) => event.path)).toContain(
		"checks/unit.sh",
	);
	expect(lstatSync(join(fixture.worktree, "docs")).isDirectory()).toBe(true);
	expect(lstatSync(join(fixture.worktree, "Makefile")).isSymbolicLink()).toBe(
		false,
	);
	expect(lstatSync(join(fixture.worktree, "checks/unit.sh")).isFile()).toBe(
		true,
	);
	expect(readFileSync(join(fixture.worktree, "docs/guide.md"), "utf8")).toBe(
		"# Guide\n",
	);
	expect(readFileSync(join(fixture.worktree, "Makefile"), "utf8")).toBe(
		"lint:\n\ttrue\n",
	);
	expect(readFileSync(fixture.outsideFile, "utf8")).toBe(
		"must remain untouched\n",
	);
	expect(existsSync(join(fixture.outside, "escape"))).toBe(false);
	const findings = await guardProtectedManifest({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		manifest,
		filesystem: filesystemHost,
	});
	expect(findings).toEqual({ ok: true, value: [] });
});

test("dynamic protected globs restore new and ignored paths", async () => {
	const fixture = await createFixture("dynamic-glob");
	const manifest = await manifestFor(fixture);
	writeFileSync(join(fixture.worktree, ".gitignore"), "docs/private.md\n");
	writeFileSync(join(fixture.worktree, "docs/new.md"), "new\n");
	writeFileSync(join(fixture.worktree, "docs/private.md"), "ignored\n");
	const before = await guardProtectedManifest({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		manifest,
		filesystem: filesystemHost,
	});
	expect(before.ok).toBe(true);
	if (!before.ok) throw new Error(before.error.message);
	expect(before.value.map((finding) => finding.path)).toContain("docs/new.md");
	expect(before.value.map((finding) => finding.path)).toContain(
		"docs/private.md",
	);
	const restored = await restoreProtectedPaths({
		repository: fixture.repository,
		sourceRepository: fixture.worktree,
		manifest,
		filesystem: filesystemHost,
		rung: "R1",
		previousRestoreCount: 0,
	});
	if (!restored.ok) throw new Error(restored.error.message);
	expect(existsSync(join(fixture.worktree, "docs/new.md"))).toBe(false);
	expect(existsSync(join(fixture.worktree, "docs/private.md"))).toBe(false);
});

test("four successful protected restores end the rung on the fourth", async () => {
	const fixture = await createFixture("restore-limit");
	const manifest = await manifestFor(fixture);
	let restoreCount = 0;
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		writeFileSync(
			join(fixture.worktree, ".kogen/acceptance/greet.t.sh"),
			`t_A1() { true ${attempt}; }\n`,
		);
		const restored = await restoreProtectedPaths({
			repository: fixture.repository,
			sourceRepository: fixture.worktree,
			manifest,
			filesystem: filesystemHost,
			rung: "R1",
			previousRestoreCount: restoreCount,
		});
		if (!restored.ok) throw new Error(restored.error.message);
		restoreCount = restored.value.restoreCount;
		expect(restored.value.events).toHaveLength(1);
		expect(restored.value.limitReached).toBe(attempt === 4);
	}
	expect(restoreCount).toBe(4);
	expect(
		readFileSync(
			join(fixture.worktree, ".kogen/acceptance/greet.t.sh"),
			"utf8",
		),
	).toBe(new TextDecoder().decode(testBytes));
});

test("scope results are sorted advice and remain separate from gate state", () => {
	const warnings = scopeWarnings(
		["lib/greet.txt", "README.md", "lib-extra/file.ts", "README.md"],
		["app"],
		new Map([["app", ["lib"]]]),
	);
	expect(warnings).toEqual([
		{ path: "README.md", declaredDomains: ["app"] },
		{ path: "lib-extra/file.ts", declaredDomains: ["app"] },
	]);
});
