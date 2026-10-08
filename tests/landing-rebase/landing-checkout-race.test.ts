import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLandingCheckoutSync,
	planLandingCheckoutSync,
} from "../../packages/core/src/build/landing/sync";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	GitPort,
	GitRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";

const decoder = new TextDecoder();

function commandError(message: string): PortError {
	return { code: "unavailable", message, retryable: false };
}

function testGitPort(home: string): GitPort {
	const executable = Bun.which("git");
	if (executable === null) throw new Error("Git is unavailable");
	const environment = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: home,
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return {
		async command(request: GitRequest): Promise<Result<ProcessResult>> {
			const result = spawnSync(executable, request.argv, {
				cwd: request.repository,
				env: environment,
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				timeout: request.timeoutMilliseconds,
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				encoding: "buffer",
			});
			if (result.error !== undefined)
				return { ok: false, error: commandError(result.error.message) };
			return {
				ok: true,
				value: {
					exitCode: result.status,
					signal: result.signal,
					stdout: result.stdout ?? new Uint8Array(),
					stderr: result.stderr ?? new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
}

async function gitText(
	git: GitPort,
	repository: string,
	argv: readonly string[],
): Promise<string> {
	const result = await git.command({
		repository,
		argv,
		timeoutMilliseconds: 10_000,
		outputLimitBytes: 64 * 1024,
	});
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.exitCode !== 0 || result.value.timedOut)
		throw new Error(
			`git ${argv[0]} failed: ${decoder.decode(result.value.stderr)}`,
		);
	return decoder.decode(result.value.stdout).trimEnd();
}

test("a checkout edit made after the sync plan is retained", async () => {
	const root = mkdtempSync(join(tmpdir(), "kogen-landing-race-"));
	const home = join(root, "home");
	const repository = join(root, "checkout");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(repository, { mode: 0o700 });
	const git = testGitPort(home);
	try {
		await gitText(git, repository, ["init", "--initial-branch=main", "."]);
		await gitText(git, repository, ["config", "user.name", "Landing Test"]);
		await gitText(git, repository, [
			"config",
			"user.email",
			"landing@example.invalid",
		]);
		mkdirSync(join(repository, "lib"));
		writeFileSync(join(repository, "lib", "greet.txt"), "Hello!\n");
		await gitText(git, repository, ["add", "-A"]);
		await gitText(git, repository, ["commit", "-m", "base"]);
		const base = await gitText(git, repository, ["rev-parse", "HEAD"]);

		writeFileSync(join(repository, "lib", "greet.txt"), "Hello, Almir!\n");
		await gitText(git, repository, ["add", "-A"]);
		await gitText(git, repository, ["commit", "-m", "landing candidate"]);
		const candidate = await gitText(git, repository, ["rev-parse", "HEAD"]);
		await gitText(git, repository, ["reset", "--hard", base]);

		const plan = await planLandingCheckoutSync(git, {
			origin: repository,
			branch: "main",
			expectedParent: base,
			candidateCommit: candidate,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.checkouts).toEqual([
			{ path: realpathSync(repository), state: "clean" },
		]);

		const lateEdit = "local edit after landing preflight\n";
		writeFileSync(join(repository, "lib", "greet.txt"), lateEdit);
		await gitText(git, repository, [
			"update-ref",
			"refs/heads/main",
			candidate,
			base,
		]);

		const warnings = await applyLandingCheckoutSync(git, plan.value);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("your checkout at ");
		expect(readFileSync(join(repository, "lib", "greet.txt"), "utf8")).toBe(
			lateEdit,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
