import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	type IntentRemoveLifecycle,
	removeIntent,
} from "../../packages/core/src/approval/remove";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import { createPublicGitPort } from "../../packages/core/src/git/command";

const SLUG = "greet";
const INTENT_PATH = `.kogen/intents/${SLUG}/intent.md`;
const ACCEPTANCE_PATH = `.kogen/acceptance/${SLUG}.t.sh`;
const ENCODER = new TextEncoder();
const INTENT = ENCODER.encode(
	"---\ntitle: Greet\nsize: small\ndomains: [app]\n---\nUpdate the greeting.\n",
);
const ACCEPTANCE = ENCODER.encode("t_A1() { test -f lib/greet.txt; }\n");

let scratch = "";

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function environment(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: scratch,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

function processPort(): ProcessPort {
	return {
		async run(request: ProcessRequest): Promise<Result<ProcessResult>> {
			const executable = request.argv[0];
			if (executable === undefined)
				return { ok: false, error: error("invalid_input", "empty argv") };
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
					error: error("unavailable", result.error.message),
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

function fileSystem(): Pick<FileSystemPort, "readFile"> {
	return {
		async readFile(request) {
			const root = resolve(request.root);
			const path = resolve(root, request.path);
			if (!path.startsWith(`${root}${sep}`))
				return {
					ok: false,
					error: error("invalid_input", "path escapes the fixture root"),
				};
			try {
				const bytes = readFileSync(path);
				if (bytes.byteLength > request.maxBytes)
					return {
						ok: false,
						error: error("invalid_input", "file exceeds requested size"),
					};
				return { ok: true, value: new Uint8Array(bytes) };
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException).code;
				return {
					ok: false,
					error:
						code === "ENOENT"
							? error("not_found", "file does not exist")
							: error("io", "fixture file read failed"),
				};
			}
		},
	};
}

function text(result: ProcessResult): string {
	if (result.timedOut || result.exitCode !== 0)
		throw new Error(
			`Git failed (${String(result.exitCode)}): ${new TextDecoder().decode(result.stderr)}`,
		);
	return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
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
	return text(result.value);
}

interface Fixture {
	readonly origin: string;
	readonly checkout: string;
	readonly home: string;
	readonly git: GitPort;
	readonly baseCommit: string;
	readonly lifecycleValue: IntentRemoveLifecycle;
	readonly request: ReturnType<typeof requestFor>;
	close(): void;
}

function requestFor(input: {
	readonly origin: string;
	readonly checkout: string;
	readonly home: string;
	readonly git: Pick<GitPort, "command">;
	readonly state?: Partial<IntentRemoveLifecycle>;
	readonly force?: boolean;
	readonly lifecycleInspect?: (
		slug: string,
		approvalCommit: string | null,
	) => Promise<Result<IntentRemoveLifecycle>>;
}) {
	const value: IntentRemoveLifecycle = {
		activeBuild: false,
		landed: false,
		buildDisposition: null,
		...input.state,
	};
	return {
		origin: input.origin,
		checkout: input.checkout,
		slug: SLUG,
		acceptancePath: ACCEPTANCE_PATH,
		force: input.force ?? false,
		filesystem: fileSystem(),
		git: input.git,
		lifecycle: {
			async inspect(slug: string, approvalCommit: string | null) {
				if (input.lifecycleInspect)
					return input.lifecycleInspect(slug, approvalCommit);
				return { ok: true as const, value };
			},
		},
	};
}

async function createFixture(
	options: {
		readonly withApproval?: boolean;
		readonly objectFormat?: "sha1" | "sha256";
		readonly state?: Partial<IntentRemoveLifecycle>;
		readonly force?: boolean;
		readonly lifecycleInspect?: (
			slug: string,
			approvalCommit: string | null,
		) => Promise<Result<IntentRemoveLifecycle>>;
	} = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(scratch, "remove-"));
	const home = join(root, "home");
	const checkout = join(root, "checkout");
	const origin = join(root, "origin.git");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(checkout, { mode: 0o700 });
	const gitPath = Bun.which("git");
	if (gitPath === null)
		throw new Error("Git is unavailable to remove fixtures");
	const env = environment(home);
	const git = createPublicGitPort(processPort(), {
		executable: gitPath,
		environment: env,
	});
	await gitText(git, checkout, [
		"init",
		"--initial-branch=main",
		...(options.objectFormat === undefined
			? []
			: [`--object-format=${options.objectFormat}`]),
		".",
	]);
	await gitText(git, checkout, ["config", "user.name", "Kogen Remove Fixture"]);
	await gitText(git, checkout, [
		"config",
		"user.email",
		"remove@example.invalid",
	]);
	await gitText(git, checkout, ["config", "commit.gpgsign", "false"]);
	await gitText(git, checkout, ["config", "core.hooksPath", "/dev/null"]);
	for (const [path, bytes] of [
		[INTENT_PATH, INTENT],
		[ACCEPTANCE_PATH, ACCEPTANCE],
		["lib/greet.txt", ENCODER.encode("Hello!\n")],
		["lib/other.txt", ENCODER.encode("base other\n")],
	] as const) {
		const absolute = join(checkout, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, bytes, { mode: 0o644 });
	}
	await gitText(git, checkout, ["add", "--all"]);
	await gitText(git, checkout, ["commit", "--message", "fixture base"]);
	const baseCommit = (
		await gitText(git, checkout, ["rev-parse", "HEAD"])
	).trim();
	await gitText(git, checkout, [
		"init",
		"--bare",
		"--initial-branch=main",
		origin,
	]);
	await gitText(git, origin, ["config", "user.name", "Kogen Remove Fixture"]);
	await gitText(git, origin, [
		"config",
		"user.email",
		"remove@example.invalid",
	]);
	await gitText(git, origin, ["config", "commit.gpgsign", "false"]);
	await gitText(git, checkout, ["remote", "add", "origin", origin]);
	await gitText(git, checkout, ["push", "origin", "main:main"]);
	if (options.withApproval)
		await gitText(git, origin, [
			"update-ref",
			`refs/kogen/intents/${SLUG}`,
			baseCommit,
		]);
	const lifecycleValue: IntentRemoveLifecycle = {
		activeBuild: false,
		landed: false,
		buildDisposition: null,
		...options.state,
	};
	return {
		origin,
		checkout,
		home,
		git,
		baseCommit,
		lifecycleValue,
		request: requestFor({
			origin,
			checkout,
			home,
			git,
			...(options.state === undefined ? {} : { state: options.state }),
			...(options.force === undefined ? {} : { force: options.force }),
			...(options.lifecycleInspect === undefined
				? {}
				: { lifecycleInspect: options.lifecycleInspect }),
		}),
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "kts-remove-tests-"));
});

afterAll(() => {
	if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

test("draft removal commits only Intent paths and preserves unrelated user changes", async () => {
	const fixture = await createFixture();
	try {
		writeFileSync(
			join(fixture.checkout, "lib/other.txt"),
			"staged elsewhere\n",
		);
		await gitText(fixture.git, fixture.checkout, ["add", "lib/other.txt"]);
		writeFileSync(join(fixture.checkout, "notes.txt"), "untracked elsewhere\n");

		const removed = await removeIntent(fixture.request);
		expect(removed).toMatchObject({ ok: true, value: { slug: SLUG } });
		if (!removed.ok) throw new Error(removed.error.message);
		expect(removed.value.commit).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
		expect(
			await gitText(fixture.git, fixture.checkout, [
				"show",
				"--name-only",
				"--format=",
				"HEAD",
			]),
		).toBe(`${ACCEPTANCE_PATH}\n${INTENT_PATH}\n`);
		expect(
			await gitText(fixture.git, fixture.checkout, [
				"diff",
				"--cached",
				"--name-only",
			]),
		).toBe("lib/other.txt\n");
		expect(readFileSync(join(fixture.checkout, "lib/other.txt"), "utf8")).toBe(
			"staged elsewhere\n",
		);
		expect(readFileSync(join(fixture.checkout, "notes.txt"), "utf8")).toBe(
			"untracked elsewhere\n",
		);
		expect(
			await gitText(fixture.git, fixture.checkout, [
				"show",
				"-s",
				"--format=%an <%ae>",
				"HEAD",
			]),
		).toBe("Kogen Remove Fixture <remove@example.invalid>\n");
		expect(
			await gitText(fixture.git, fixture.checkout, [
				"show",
				"-s",
				"--format=%s",
				"HEAD",
			]),
		).toBe("Remove Intent greet\n");
	} finally {
		fixture.close();
	}
});

test("approved Intent requires force, then removes its ref with compare-and-delete", async () => {
	const fixture = await createFixture({ withApproval: true });
	try {
		const refused = await removeIntent(fixture.request);
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "intent/remove_requires_force",
				exitCode: 2,
				message:
					"Intent approved or queued; pass --force to discard the approval and remove its files",
			},
		});
		expect(
			await gitText(fixture.git, fixture.checkout, ["rev-parse", "HEAD"]),
		).toBe(`${fixture.baseCommit}\n`);

		const forced = await removeIntent({ ...fixture.request, force: true });
		expect(forced).toMatchObject({
			ok: true,
			value: { slug: SLUG, deletedApprovalRef: true },
		});
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show-ref",
				"--verify",
				`refs/kogen/intents/${SLUG}`,
			]).catch((cause: unknown) => String(cause)),
		).not.toContain(fixture.baseCommit);
	} finally {
		fixture.close();
	}
});

test("failed, parked, and interrupted approvals retain their exact force reasons", async () => {
	for (const [disposition, message] of [
		[
			"failed",
			"Intent still has a failed Build approval; pass --force to discard the approval and remove its files",
		],
		[
			"parked",
			"Intent still has a parked Build approval; pass --force to discard the approval and remove its files",
		],
		[
			"interrupted",
			"Intent still has an approval ref; pass --force to discard the approval and remove its files",
		],
	] as const) {
		const fixture = await createFixture({
			withApproval: true,
			state: { buildDisposition: disposition },
		});
		try {
			const refused = await removeIntent(fixture.request);
			expect(refused).toMatchObject({
				ok: false,
				error: { code: "intent/remove_requires_force", message },
			});
		} finally {
			fixture.close();
		}
	}
});

test("active Build blocks removal even with force", async () => {
	const fixture = await createFixture({
		withApproval: true,
		force: true,
		state: { activeBuild: true },
	});
	try {
		const refused = await removeIntent(fixture.request);
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "intent/remove_blocked",
				exitCode: 2,
				message: "Intent is in an active Build and cannot be removed",
			},
		});
		expect(
			await gitText(fixture.git, fixture.checkout, ["rev-parse", "HEAD"]),
		).toBe(`${fixture.baseCommit}\n`);
	} finally {
		fixture.close();
	}
});

test("untracked Intent is retained and refused even when force is supplied", async () => {
	const fixture = await createFixture();
	try {
		await gitText(fixture.git, fixture.checkout, [
			"rm",
			"-r",
			"--cached",
			"--",
			INTENT_PATH,
			ACCEPTANCE_PATH,
		]);
		await gitText(fixture.git, fixture.checkout, [
			"commit",
			"--message",
			"untrack Intent",
		]);
		writeFileSync(join(fixture.checkout, INTENT_PATH), INTENT);
		writeFileSync(join(fixture.checkout, ACCEPTANCE_PATH), ACCEPTANCE);
		const head = (
			await gitText(fixture.git, fixture.checkout, ["rev-parse", "HEAD"])
		).trim();
		const refused = await removeIntent({ ...fixture.request, force: true });
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "intent/remove_requires_commit",
				exitCode: 2,
				message: "Intent files must be tracked to record their removal",
			},
		});
		expect(
			await gitText(fixture.git, fixture.checkout, ["rev-parse", "HEAD"]),
		).toBe(`${head}\n`);
		expect(readFileSync(join(fixture.checkout, INTENT_PATH), "utf8")).toBe(
			new TextDecoder().decode(INTENT),
		);
	} finally {
		fixture.close();
	}
});

test("landed Intent needs no force but still removes a stale approval ref", async () => {
	const fixture = await createFixture({
		withApproval: true,
		state: { landed: true },
	});
	try {
		const removed = await removeIntent(fixture.request);
		expect(removed).toMatchObject({
			ok: true,
			value: { slug: SLUG, deletedApprovalRef: true },
		});
	} finally {
		fixture.close();
	}
});

test("approval ref race does not delete the newer approval", async () => {
	const fixture = await createFixture({ withApproval: true, force: true });
	try {
		let raced = false;
		let newerApproval = "";
		const racingGit: GitPort = {
			async command(request) {
				if (
					!raced &&
					request.repository === fixture.origin &&
					request.argv[0] === "update-ref" &&
					request.argv.includes("-d")
				) {
					raced = true;
					const tree = (
						await gitText(fixture.git, fixture.origin, [
							"rev-parse",
							`${fixture.baseCommit}^{tree}`,
						])
					).trim();
					newerApproval = (
						await gitText(
							fixture.git,
							fixture.origin,
							["commit-tree", tree, "-p", fixture.baseCommit],
							ENCODER.encode("new approval snapshot\n"),
						)
					).trim();
					const changed = await fixture.git.command({
						repository: fixture.origin,
						argv: [
							"update-ref",
							`refs/kogen/intents/${SLUG}`,
							newerApproval,
							fixture.baseCommit,
						],
						timeoutMilliseconds: 30_000,
						outputLimitBytes: 4096,
					});
					if (!changed.ok || changed.value.exitCode !== 0)
						throw new Error("could not arrange the approval ref race");
				}
				return fixture.git.command(request);
			},
		};
		const refused = await removeIntent({ ...fixture.request, git: racingGit });
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "environment/approval_ref_changed",
				message:
					"approval ref changed while removing the Intent; review the ref before retrying",
			},
		});
		expect(
			await gitText(fixture.git, fixture.origin, [
				"show-ref",
				"--verify",
				"--hash",
				`refs/kogen/intents/${SLUG}`,
			]),
		).toBe(`${newerApproval}\n`);
	} finally {
		fixture.close();
	}
});

test("a Build that starts during preflight blocks before checkout mutation", async () => {
	const fixture = await createFixture();
	try {
		let inspections = 0;
		const request = requestFor({
			origin: fixture.origin,
			checkout: fixture.checkout,
			home: fixture.home,
			git: fixture.git,
			lifecycleInspect: async () => {
				inspections += 1;
				return {
					ok: true,
					value: {
						activeBuild: inspections === 2,
						landed: false,
						buildDisposition: null,
					},
				};
			},
		});
		const refused = await removeIntent(request);
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "intent/remove_blocked" },
		});
		expect(inspections).toBe(2);
		expect(
			await gitText(fixture.git, fixture.checkout, ["rev-parse", "HEAD"]),
		).toBe(`${fixture.baseCommit}\n`);
	} finally {
		fixture.close();
	}
});
