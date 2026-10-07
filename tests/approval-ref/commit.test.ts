import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitApprovalPackage } from "../../packages/core/src/approval/commit";
import type { ApprovalPreflightSuccess } from "../../packages/core/src/approval/preflight";
import {
	type ApprovalCasDecision,
	approvalCasTransition,
} from "../../packages/core/src/approval/transition";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	GitRequest,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { createPublicGitPort } from "../../packages/core/src/git/command";
import {
	hashApprovalBytes,
	hashIntentBytes,
} from "../../packages/core/src/intent/hash";

const CHECKOUT = "/tmp/kogen-approval-ref-checkout";
const SLUG = "greet";
const INTENT_PATH = `.kogen/intents/${SLUG}/intent.md`;
const ACCEPTANCE_PATH = `.kogen/acceptance/${SLUG}.t.sh`;
const INTENT = new TextEncoder().encode(
	"---\ntitle: Greet Almir by name\nsize: small\ndomains: [app]\n---\nChange the greeting in lib/greet.txt so that it names Almir.\n\n## Acceptance\n- A1: lib/greet.txt contains the line Hello, Almir!\n\n## Verify\n- A1: test\n\n## Request\nMake the greeting in lib/greet.txt say Hello, Almir! instead of Hello!\n",
);
const ACCEPTANCE = new TextEncoder().encode(
	"# café source bytes\r\nt_A1() { grep -qx 'Hello, Almir!' lib/greet.txt; }\r\n",
);

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function testEnvironment(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: home,
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function makeProcessPort(): ProcessPort {
	return {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			const executable = request.argv[0];
			if (executable === undefined)
				return {
					ok: false,
					error: portError("invalid_input", "empty argv"),
				};
			const result = spawnSync(executable, request.argv.slice(1), {
				cwd: request.cwd,
				env: { ...request.env },
				...(request.stdin === undefined ? {} : { input: request.stdin }),
				timeout: request.timeoutMilliseconds,
				maxBuffer: Math.max(1024, request.outputLimitBytes + 1),
				encoding: "buffer",
			});
			const spawnError = result.error as NodeJS.ErrnoException | undefined;
			if (spawnError?.code === "ETIMEDOUT")
				return {
					ok: true,
					value: {
						exitCode: null,
						signal: result.signal ?? null,
						stdout: result.stdout ?? new Uint8Array(),
						stderr: result.stderr ?? new Uint8Array(),
						timedOut: true,
					},
				};
			if (result.error !== undefined)
				return {
					ok: false,
					error: portError("unavailable", result.error.message),
				};
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

function makeFileSystem(
	options: {
		readonly mutatePath?: string;
		readonly changedBytes?: Uint8Array;
	} = {},
): Pick<FileSystemPort, "readFile"> & {
	readonly put: (path: string, bytes: Uint8Array) => void;
} {
	const files = new Map<string, Uint8Array>();
	const reads = new Map<string, number>();
	return {
		put(path, bytes) {
			files.set(path, bytes.slice());
		},
		async readFile(request) {
			const count = (reads.get(request.path) ?? 0) + 1;
			reads.set(request.path, count);
			if (
				request.path === options.mutatePath &&
				count === 2 &&
				options.changedBytes !== undefined
			)
				files.set(request.path, options.changedBytes.slice());
			const value = files.get(request.path);
			if (value === undefined)
				return {
					ok: false,
					error: portError("not_found", "file does not exist"),
				};
			if (value.byteLength > request.maxBytes)
				return {
					ok: false,
					error: portError("invalid_input", "file too large"),
				};
			return { ok: true, value: value.slice() };
		},
	};
}

function responseText(response: ProcessResult): string {
	if (response.exitCode !== 0 || response.timedOut)
		throw new Error(
			`git command failed with ${String(response.exitCode)}: ${new TextDecoder().decode(response.stderr)}`,
		);
	return new TextDecoder().decode(response.stdout);
}

async function gitText(
	git: GitPort,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
): Promise<string> {
	const result = await git.command({
		repository,
		argv,
		...(stdin === undefined ? {} : { stdin }),
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 64 * 1024,
	});
	if (!result.ok) throw new Error(result.error.message);
	return responseText(result.value);
}

interface Fixture {
	readonly root: string;
	readonly origin: string;
	readonly git: GitPort;
	readonly baseSha: string;
	readonly baseTree: string;
	readonly filesystem: ReturnType<typeof makeFileSystem>;
	readonly request: ReturnType<typeof approvalRequest>;
	close(): void;
}

function approvalRequest(input: {
	readonly origin: string;
	readonly baseSha: string;
	readonly baseTree: string;
	readonly filesystem: ReturnType<typeof makeFileSystem>;
	readonly git: Pick<GitPort, "command">;
	readonly by?: string;
}) {
	const approvalSha256 = hashApprovalBytes(INTENT, ACCEPTANCE);
	const preflight: ApprovalPreflightSuccess = {
		kind: "ready_to_approve",
		exitCode: 0,
		approvalSha256,
		intentSha256: hashIntentBytes(INTENT),
		checkedBaseTree: input.baseTree,
		checkBaseline: [
			{
				name: "lint",
				status: "green",
				exit_status: 0,
				findings: [],
			},
		],
		acceptanceChecks: [
			{
				name: "test",
				status: "green",
				exit_status: 0,
				timed_out: false,
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
			},
		],
		warnings: [],
		warningText: "",
		card: null,
		baselineCacheKey: null,
		baselineCacheHit: false,
		checkoutTree: input.baseTree,
		checkedInScratch: true,
	};
	return {
		origin: input.origin,
		checkout: CHECKOUT,
		slug: SLUG,
		intentPath: INTENT_PATH,
		acceptancePath: ACCEPTANCE_PATH,
		targetBranch: "main",
		baseSha: input.baseSha,
		givenHash: approvalSha256,
		...(input.by === undefined ? {} : { by: input.by }),
		preflight,
		protectedManifest: {
			[INTENT_PATH]: hashIntentBytes(INTENT),
			[ACCEPTANCE_PATH]: hashIntentBytes(ACCEPTANCE),
		},
		filesystem: input.filesystem,
		git: input.git,
		clock: { unixMilliseconds: () => 1_800_000_000_000 },
	};
}

async function createFixture(
	options: {
		readonly mutatePath?: string;
		readonly changedBytes?: Uint8Array;
		readonly by?: string;
		readonly objectFormat?: "sha1" | "sha256";
	} = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "kogen-approval-ref-"));
	const home = join(root, "home");
	const origin = join(root, "origin");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(origin, { mode: 0o700 });
	const processPort = makeProcessPort();
	const executable = Bun.which("git");
	if (executable === null) throw new Error("Git is unavailable");
	const git = createPublicGitPort(processPort, {
		executable,
		environment: testEnvironment(home),
	});
	await gitText(git, origin, [
		"init",
		"--initial-branch=main",
		...(options.objectFormat === undefined
			? []
			: [`--object-format=${options.objectFormat}`]),
		".",
	]);
	await gitText(git, origin, ["config", "user.name", "Kogen Test"]);
	await gitText(git, origin, ["config", "user.email", "test@kogen.invalid"]);
	await gitText(git, origin, ["config", "commit.gpgsign", "false"]);
	await gitText(git, origin, ["config", "core.hooksPath", "/dev/null"]);
	const baseBlob = await gitText(
		git,
		origin,
		["hash-object", "-w", "--stdin"],
		new TextEncoder().encode("base\n"),
	);
	const baseTree = await gitText(
		git,
		origin,
		["mktree"],
		new TextEncoder().encode(`100644 blob ${baseBlob.trim()}\tbase.txt\n`),
	);
	const baseSha = await gitText(
		git,
		origin,
		["commit-tree", baseTree.trim(), "-F", "-"],
		new TextEncoder().encode("base commit\n"),
	);
	await gitText(git, origin, ["update-ref", "refs/heads/main", baseSha.trim()]);
	const filesystem = makeFileSystem(options);
	filesystem.put(INTENT_PATH, INTENT);
	filesystem.put(ACCEPTANCE_PATH, ACCEPTANCE);
	const request = approvalRequest({
		origin,
		baseSha: baseSha.trim(),
		baseTree: baseTree.trim(),
		filesystem,
		git,
		...(options.by === undefined ? {} : { by: options.by }),
	});
	return {
		root,
		origin,
		git,
		baseSha: baseSha.trim(),
		baseTree: baseTree.trim(),
		filesystem,
		request,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("approval commit stores exact bytes, schema 2, manifest, and matching trailers", async () => {
	const fixture = await createFixture();
	try {
		const result = await commitApprovalPackage(fixture.request);
		if (!result.ok)
			throw new Error(`${result.error.code}: ${result.error.message}`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.retryCount).toBe(0);
		expect(result.value.parent).toBeNull();
		expect(
			await gitText(fixture.git, fixture.origin, [
				"ls-tree",
				"-r",
				"--name-only",
				result.value.approvalRef,
			]),
		).toBe(
			".kogen/acceptance/greet.t.sh\n" +
				".kogen/intents/greet/approval.json\n" +
				".kogen/intents/greet/intent.md\n",
		);
		const intent = await gitText(fixture.git, fixture.origin, [
			"cat-file",
			"blob",
			`${result.value.approvalRef}:${INTENT_PATH}`,
		]);
		expect(new TextEncoder().encode(intent)).toEqual(INTENT);
		const acceptance = await gitText(fixture.git, fixture.origin, [
			"cat-file",
			"blob",
			`${result.value.approvalRef}:${ACCEPTANCE_PATH}`,
		]);
		expect(new TextEncoder().encode(acceptance)).toEqual(ACCEPTANCE);
		const approvalBytes = await gitText(fixture.git, fixture.origin, [
			"cat-file",
			"blob",
			`${result.value.approvalRef}:.kogen/intents/greet/approval.json`,
		]);
		const approval = JSON.parse(approvalBytes) as Record<string, unknown>;
		expect(approval).toMatchObject({
			schema: 2,
			slug: SLUG,
			approval_sha256: hashApprovalBytes(INTENT, ACCEPTANCE),
			intent_sha256: hashIntentBytes(INTENT),
			target_branch: "main",
			base_sha: fixture.baseSha,
			domains: ["app"],
			acceptance_paths: [ACCEPTANCE_PATH],
			witness: null,
			by: "Kogen Test <test@kogen.invalid>",
		});
		expect(
			(approval.protected_manifest as Record<string, string>)[INTENT_PATH],
		).toBe(hashIntentBytes(INTENT));
		expect(approval.at).toBe(result.value.at);
		const message = await gitText(fixture.git, fixture.origin, [
			"log",
			"-1",
			"--format=%B",
			result.value.approvalRef,
		]);
		expect(message).toContain(`Kogen-Approval: ${SLUG}\n`);
		expect(message).toContain(`Kogen-Approved-By: ${approval.by}\n`);
		expect(message).toContain(
			`Kogen-Approved-Hash: ${approval.approval_sha256}\n`,
		);
		expect(message).toContain(`Kogen-Approved-At: ${approval.at}\n`);
	} finally {
		fixture.close();
	}
});

test("re-approval creates a new commit whose sole parent is the prior approval", async () => {
	const fixture = await createFixture({ by: "First reviewer" });
	try {
		const first = await commitApprovalPackage(fixture.request);
		if (!first.ok)
			throw new Error(`${first.error.code}: ${first.error.message}`);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = await commitApprovalPackage({
			...fixture.request,
			by: "Second reviewer",
		});
		if (!second.ok)
			throw new Error(`${second.error.code}: ${second.error.message}`);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.approvalCommit).not.toBe(first.value.approvalCommit);
		expect(second.value.parent).toBe(first.value.approvalCommit);
		expect(
			await gitText(fixture.git, fixture.origin, [
				"rev-list",
				"--count",
				second.value.approvalRef,
			]),
		).toBe("2\n");
	} finally {
		fixture.close();
	}
});

test("missing public Git identity refuses without creating an approval ref", async () => {
	const fixture = await createFixture();
	try {
		await gitText(fixture.git, fixture.origin, [
			"config",
			"--local",
			"--unset-all",
			"user.name",
		]);
		await gitText(fixture.git, fixture.origin, [
			"config",
			"--local",
			"--unset-all",
			"user.email",
		]);
		const result = await commitApprovalPackage(fixture.request);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("intent/approval_identity_unavailable");
		expect(result.error.exitCode).toBe(2);
		expect(
			await gitText(fixture.git, fixture.origin, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/kogen/intents/${SLUG}`,
			]),
		).toBe("");
	} finally {
		fixture.close();
	}
});

test("a preflight checked against another base tree cannot publish", async () => {
	const fixture = await createFixture();
	try {
		const request = {
			...fixture.request,
			preflight: {
				...fixture.request.preflight,
				checkedBaseTree: "f".repeat(40),
			},
		};
		const result = await commitApprovalPackage(request);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("environment/approval_commit_failed");
		expect(result.error.message).toContain("different base tree");
		expect(
			await gitText(fixture.git, fixture.origin, [
				"for-each-ref",
				"--format=%(refname)",
				`refs/kogen/intents/${SLUG}`,
			]),
		).toBe("");
	} finally {
		fixture.close();
	}
});

test("a present ledger is included and SHA-256 repositories keep 64-character ids", async () => {
	const fixture = await createFixture({ objectFormat: "sha256" });
	try {
		const ledgerPath = `.kogen/intents/${SLUG}/ledger.json`;
		const ledgerBytes = new TextEncoder().encode('{"schema":1,"items":[]}\n');
		fixture.filesystem.put(ledgerPath, ledgerBytes);
		const result = await commitApprovalPackage(fixture.request);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.approvalCommit).toHaveLength(64);
		expect(result.value.tree).toHaveLength(64);
		const files = await gitText(fixture.git, fixture.origin, [
			"ls-tree",
			"-r",
			"--name-only",
			result.value.approvalRef,
		]);
		expect(files).toContain(`${ledgerPath}\n`);
		const storedLedger = await gitText(fixture.git, fixture.origin, [
			"cat-file",
			"blob",
			`${result.value.approvalRef}:${ledgerPath}`,
		]);
		expect(new TextEncoder().encode(storedLedger)).toEqual(ledgerBytes);
	} finally {
		fixture.close();
	}
});

test.each([
	INTENT_PATH,
	ACCEPTANCE_PATH,
])("a late mutation of %s is refused without changing the approval ref", async (mutatePath) => {
	const changedBytes =
		mutatePath === INTENT_PATH
			? new TextEncoder().encode(
					`${new TextDecoder().decode(INTENT)}# late change\n`,
				)
			: new TextEncoder().encode(
					`${new TextDecoder().decode(ACCEPTANCE)}# late change\n`,
				);
	const fixture = await createFixture({ mutatePath, changedBytes });
	try {
		const result = await commitApprovalPackage(fixture.request);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("intent/hash_mismatch");
		const ref = await gitText(fixture.git, fixture.origin, [
			"for-each-ref",
			"--format=%(refname)",
			`refs/kogen/intents/${SLUG}`,
		]);
		expect(ref).toBe("");
	} finally {
		fixture.close();
	}
});

test("two concurrent approvers both publish in a parent chain after one CAS retry", async () => {
	const fixture = await createFixture();
	try {
		const approvalRef = `refs/kogen/intents/${SLUG}`;
		let arrivals = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const git: GitPort = {
			async command(request: GitRequest) {
				if (
					request.argv[0] === "update-ref" &&
					request.argv[1] === "--no-deref" &&
					request.argv[2] === approvalRef &&
					arrivals < 2
				) {
					arrivals += 1;
					if (arrivals === 2) release();
					await barrier;
				}
				return fixture.git.command(request);
			},
		};
		const firstRequest = approvalRequest({
			origin: fixture.origin,
			baseSha: fixture.baseSha,
			baseTree: fixture.baseTree,
			filesystem: fixture.filesystem,
			git,
			by: "first approver",
		});
		const secondRequest = approvalRequest({
			origin: fixture.origin,
			baseSha: fixture.baseSha,
			baseTree: fixture.baseTree,
			filesystem: fixture.filesystem,
			git,
			by: "second approver",
		});
		const [first, second] = await Promise.all([
			commitApprovalPackage(firstRequest),
			commitApprovalPackage(secondRequest),
		]);
		if (!first.ok)
			throw new Error(`${first.error.code}: ${first.error.message}`);
		if (!second.ok)
			throw new Error(`${second.error.code}: ${second.error.message}`);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect([first.value.retryCount, second.value.retryCount].sort()).toEqual([
			0, 1,
		]);
		const tip = await gitText(fixture.git, fixture.origin, [
			"rev-parse",
			approvalRef,
		]);
		const count = await gitText(fixture.git, fixture.origin, [
			"rev-list",
			"--count",
			approvalRef,
		]);
		expect(count).toBe("2\n");
		const parents = await gitText(fixture.git, fixture.origin, [
			"rev-parse",
			`${approvalRef}^`,
		]);
		expect([first.value.approvalCommit, second.value.approvalCommit]).toContain(
			parents.trim(),
		);
		expect([first.value.approvalCommit, second.value.approvalCommit]).toContain(
			tip.trim(),
		);
		const reviewers = await gitText(fixture.git, fixture.origin, [
			"log",
			"--format=%(trailers:key=Kogen-Approved-By,valueonly)",
			approvalRef,
		]);
		expect(reviewers).toContain("first approver");
		expect(reviewers).toContain("second approver");
	} finally {
		fixture.close();
	}
});

test("the production CAS transition allows one retry and then stops", () => {
	const retry: ApprovalCasDecision = approvalCasTransition({
		attempt: 0,
		expectedParent: null,
		observedParent: "a".repeat(40),
	});
	expect(retry).toEqual({
		kind: "retry",
		expectedParent: "a".repeat(40),
	});
	expect(
		approvalCasTransition({
			attempt: 1,
			expectedParent: "a".repeat(40),
			observedParent: "b".repeat(40),
		}),
	).toEqual({ kind: "exhausted", latestParent: "b".repeat(40) });
});
