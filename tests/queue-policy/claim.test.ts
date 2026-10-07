import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GitPort,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { createPublicGitPort } from "../../packages/core/src/git/command";
import {
	acquireBuildClaim,
	type ClaimOwnerStatus,
	PROJECT_CLAIM_REF,
	releaseBuildClaim,
} from "../../packages/core/src/queue/claim";
import type {
	ProcessIdentityObservation,
	ProcessIdentityPort,
	QueueOwnerIdentity,
} from "../../packages/core/src/queue/lock";

setDefaultTimeout(90_000);

let scratch = "";
const decoder = new TextDecoder();
const ownerA: QueueOwnerIdentity = { pid: 1001, startedMs: 1_780_000_000_001 };
const ownerB: QueueOwnerIdentity = { pid: 1002, startedMs: 1_780_000_000_002 };
const ownerC: QueueOwnerIdentity = { pid: 1003, startedMs: 1_780_000_000_003 };

function fixtureIdentity(owner: QueueOwnerIdentity): ProcessIdentityPort {
	return {
		current: () => owner,
		async inspect(pid) {
			const observation: ProcessIdentityObservation =
				pid === owner.pid
					? { kind: "alive", startedMs: owner.startedMs }
					: { kind: "dead" };
			return { ok: true, value: observation };
		},
	};
}

function fixtureEnvironment(home: string): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: home,
		TMPDIR: scratch,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Queue fixture",
		GIT_AUTHOR_EMAIL: "queue@example.invalid",
		GIT_COMMITTER_NAME: "Queue fixture",
		GIT_COMMITTER_EMAIL: "queue@example.invalid",
	};
}

function syncGit(
	git: string,
	repository: string,
	environment: Readonly<Record<string, string>>,
	args: readonly string[],
): void {
	const response = spawnSync(git, [...args], {
		cwd: repository,
		env: environment,
		encoding: "utf8",
		timeout: 30_000,
	});
	if (response.error) throw response.error;
	if (response.status !== 0)
		throw new Error(
			`Git fixture setup failed: ${args.join(" ")}: ${response.stderr}`,
		);
}

function asyncProcessPort(): ProcessPort {
	return {
		async run(request: ProcessRequest) {
			const child = Bun.spawn({
				cmd: [...request.argv],
				cwd: request.cwd,
				env: { ...request.env },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			if (request.stdin !== undefined && request.stdin.byteLength > 0)
				child.stdin.write(request.stdin);
			child.stdin.end();
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, request.timeoutMilliseconds);
			const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
				new Response(child.stdout).arrayBuffer(),
				new Response(child.stderr).arrayBuffer(),
				child.exited,
			]);
			clearTimeout(timeout);
			const stdout = new Uint8Array(stdoutBuffer);
			const stderr = new Uint8Array(stderrBuffer);
			if (stdout.byteLength + stderr.byteLength > request.outputLimitBytes)
				return {
					ok: false as const,
					error: {
						code: "unknown" as const,
						message: "Git fixture exceeded its output limit.",
						retryable: false,
					},
				};
			const value: ProcessResult = {
				exitCode,
				signal: null,
				stdout,
				stderr,
				timedOut,
			};
			return { ok: true as const, value };
		},
	};
}

async function createFixtureRepository(
	name: string,
	objectFormat: "sha1" | "sha256" = "sha1",
): Promise<{
	readonly repository: string;
	readonly gitPath: string;
	readonly environment: Record<string, string>;
	readonly git: GitPort;
}> {
	const gitPath = Bun.which("git");
	if (gitPath === null)
		throw new Error("Git is unavailable to the queue race fixture.");
	const repository = join(scratch, name);
	const home = join(scratch, `${name}-home`);
	mkdirSync(repository, { mode: 0o700 });
	mkdirSync(home, { mode: 0o700 });
	const environment = fixtureEnvironment(home);
	syncGit(gitPath, repository, environment, [
		"init",
		"--initial-branch=main",
		`--object-format=${objectFormat}`,
		".",
	]);
	syncGit(gitPath, repository, environment, [
		"config",
		"user.name",
		"Queue fixture",
	]);
	syncGit(gitPath, repository, environment, [
		"config",
		"user.email",
		"queue@example.invalid",
	]);
	syncGit(gitPath, repository, environment, [
		"config",
		"commit.gpgsign",
		"false",
	]);
	syncGit(gitPath, repository, environment, [
		"config",
		"core.hooksPath",
		"/dev/null",
	]);
	const port = createPublicGitPort(asyncProcessPort(), {
		executable: gitPath,
		environment,
	});
	return { repository, gitPath, environment, git: port };
}

function barrierGitPort(inner: GitPort, parties: number): GitPort {
	let arrivals = 0;
	let open = (): void => undefined;
	const barrier = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		async command(request) {
			if (
				request.argv[0] === "update-ref" &&
				request.argv[1] === PROJECT_CLAIM_REF &&
				!request.argv.includes("-d")
			) {
				arrivals += 1;
				if (arrivals === parties) open();
				await barrier;
			}
			return inner.command(request);
		},
	};
}

async function requireClaimResult(
	result: Awaited<ReturnType<typeof acquireBuildClaim>>,
): Promise<Exclude<typeof result, { readonly ok: false }>> {
	if (!result.ok) throw new Error(result.error.message);
	return result;
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kts-queue-claim-"));
});

afterAll(() => {
	if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

test("Git CAS lets exactly one concurrent process own refs/kogen/claim", async () => {
	const fixture = await createFixtureRepository("origin");
	const git = barrierGitPort(fixture.git, 2);
	const [left, right] = await Promise.all([
		acquireBuildClaim(
			git,
			fixture.repository,
			"a".repeat(32),
			ownerA,
			async () => ({ ok: true, value: "live" as ClaimOwnerStatus }),
		),
		acquireBuildClaim(
			git,
			fixture.repository,
			"b".repeat(32),
			ownerB,
			async () => ({ ok: true, value: "live" as ClaimOwnerStatus }),
		),
	]);
	const leftResult = await requireClaimResult(left);
	const rightResult = await requireClaimResult(right);
	const acquisitions = [leftResult.value, rightResult.value].filter(
		(result) => result.kind === "acquired",
	);
	const held = [leftResult.value, rightResult.value].filter(
		(result) => result.kind === "held",
	);
	expect(acquisitions).toHaveLength(1);
	expect(held).toHaveLength(1);
	const acquired = acquisitions[0];
	if (acquired?.kind !== "acquired")
		throw new Error("race winner was not retained");
	const read = await fixture.git.command({
		repository: fixture.repository,
		argv: ["for-each-ref", "--format=%(objectname)", PROJECT_CLAIM_REF],
		timeoutMilliseconds: 10_000,
		outputLimitBytes: 1024,
	});
	expect(read.ok).toBe(true);
	if (read.ok)
		expect(decoder.decode(read.value.stdout).trim()).toBe(
			acquired.claim.commit,
		);
	const wrongRelease = await releaseBuildClaim(
		fixture.git,
		fixture.repository,
		{
			runId:
				acquired.claim.runId === "a".repeat(32)
					? "b".repeat(32)
					: "a".repeat(32),
			commit: acquired.claim.commit,
			owner: acquired.claim.owner,
		},
		fixtureIdentity(acquired.claim.owner.pid === ownerA.pid ? ownerB : ownerA),
	);
	expect(wrongRelease).toEqual({ ok: true, value: false });
	expect(
		await releaseBuildClaim(
			fixture.git,
			fixture.repository,
			acquired.claim,
			fixtureIdentity(acquired.claim.owner),
		),
	).toEqual({ ok: true, value: true });
	const afterRelease = await fixture.git.command({
		repository: fixture.repository,
		argv: ["for-each-ref", "--format=%(objectname)", PROJECT_CLAIM_REF],
		timeoutMilliseconds: 10_000,
		outputLimitBytes: 1024,
	});
	expect(afterRelease.ok).toBe(true);
	if (afterRelease.ok)
		expect(decoder.decode(afterRelease.value.stdout).trim()).toBe("");
});

test("stale claim takeover uses CAS and an old owner cannot release the replacement", async () => {
	const fixture = await createFixtureRepository("stale-origin");
	const first = await acquireBuildClaim(
		fixture.git,
		fixture.repository,
		"c".repeat(32),
		ownerA,
		async () => ({ ok: true, value: "unknown" }),
	);
	const firstResult = await requireClaimResult(first);
	if (firstResult.value.kind !== "acquired")
		throw new Error("initial claim failed");
	const firstClaim = firstResult.value.claim;
	const second = await acquireBuildClaim(
		fixture.git,
		fixture.repository,
		"d".repeat(32),
		ownerB,
		async (runId) => ({
			ok: true,
			value: runId === firstClaim.runId ? "stale" : "unknown",
		}),
	);
	const secondResult = await requireClaimResult(second);
	if (secondResult.value.kind !== "acquired")
		throw new Error("stale claim was not taken over");
	expect(secondResult.value.tookOver).toBe(true);
	expect(
		await releaseBuildClaim(
			fixture.git,
			fixture.repository,
			firstClaim,
			fixtureIdentity(ownerA),
		),
	).toEqual({ ok: true, value: false });
	const third = await acquireBuildClaim(
		fixture.git,
		fixture.repository,
		"e".repeat(32),
		ownerC,
		async () => ({ ok: true, value: "live" }),
	);
	const thirdResult = await requireClaimResult(third);
	expect(thirdResult.value.kind).toBe("held");
	if (thirdResult.value.kind === "held")
		expect(thirdResult.value.ownerRunId).toBe(secondResult.value.claim.runId);
});

test("claim ref creation and release support SHA-256 repositories", async () => {
	const fixture = await createFixtureRepository("sha256-origin", "sha256");
	const acquired = await acquireBuildClaim(
		fixture.git,
		fixture.repository,
		"f".repeat(32),
		ownerC,
		async () => ({ ok: true, value: "unknown" }),
	);
	const acquiredResult = await requireClaimResult(acquired);
	if (acquiredResult.value.kind !== "acquired")
		throw new Error("SHA-256 claim was not acquired");
	expect(acquiredResult.value.claim.commit).toHaveLength(64);
	expect(
		await releaseBuildClaim(
			fixture.git,
			fixture.repository,
			acquiredResult.value.claim,
			fixtureIdentity(ownerC),
		),
	).toEqual({ ok: true, value: true });
});
