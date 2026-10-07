import { expect, test } from "bun:test";
import type {
	GitPort,
	GitRequest,
	ProcessResult,
} from "../../packages/core/src/contracts/ports";
import type { ProjectResolutionHost } from "../../packages/core/src/project/resolve";
import {
	projectStateRootKey,
	projectStateRootPath,
	resolveProject,
} from "../../packages/core/src/project/resolve";

interface FakeRepository {
	readonly topLevel: string;
	readonly gitDirectory: string;
	readonly remoteUrl?: string;
	readonly symbolicRefs?: ReadonlyMap<string, string>;
	readonly objectIds?: ReadonlyMap<string, string>;
}

function processResult(exitCode: number, output = ""): ProcessResult {
	return {
		exitCode,
		signal: null,
		stdout: new TextEncoder().encode(output),
		stderr: new Uint8Array(),
		timedOut: false,
	};
}

function gitPort(repositories: ReadonlyMap<string, FakeRepository>): GitPort {
	return {
		async command(request: GitRequest) {
			const repo =
				repositories.get(request.repository) ??
				[...repositories.entries()]
					.sort(([left], [right]) => right.length - left.length)
					.find(([path]) => request.repository.startsWith(`${path}/`))?.[1];
			if (repo === undefined) return { ok: true, value: processResult(128) };
			const args = request.argv;
			if (args.join(" ") === "rev-parse --show-toplevel") {
				return { ok: true, value: processResult(0, `${repo.topLevel}\n`) };
			}
			if (args.join(" ") === "rev-parse --git-dir") {
				return { ok: true, value: processResult(0, `${repo.gitDirectory}\n`) };
			}
			if (args.join(" ") === "config --local --null --get remote.origin.url") {
				return repo.remoteUrl === undefined
					? { ok: true, value: processResult(1) }
					: { ok: true, value: processResult(0, `${repo.remoteUrl}\0`) };
			}
			if (args[0] === "symbolic-ref") {
				const ref = args.at(-1);
				const symbolic =
					ref === undefined ? undefined : repo.symbolicRefs?.get(ref);
				return symbolic === undefined
					? { ok: true, value: processResult(1) }
					: { ok: true, value: processResult(0, `${symbolic}\n`) };
			}
			if (
				args.slice(0, 4).join(" ") ===
				"rev-parse --verify --quiet --end-of-options"
			) {
				const expression = args[4];
				const ref = expression?.endsWith("^{commit}")
					? expression.slice(0, -"^{commit}".length)
					: undefined;
				const objectId =
					ref === undefined ? undefined : repo.objectIds?.get(ref);
				return objectId === undefined
					? { ok: true, value: processResult(1) }
					: { ok: true, value: processResult(0, `${objectId}\n`) };
			}
			return { ok: true, value: processResult(1) };
		},
	};
}

function host(
	repositories: ReadonlyMap<string, FakeRepository>,
	aliases: ReadonlyMap<string, string> = new Map(),
): ProjectResolutionHost {
	const directories = new Set(
		[...repositories.keys(), ...repositories.values()].map((repoOrPath) =>
			typeof repoOrPath === "string" ? repoOrPath : repoOrPath.topLevel,
		),
	);
	for (const repoPath of repositories.keys()) directories.add(repoPath);
	for (const canonical of aliases.values()) directories.add(canonical);
	return {
		git: gitPort(repositories),
		paths: {
			async realpath(path) {
				const canonical = aliases.get(path) ?? path;
				if (!directories.has(canonical)) throw new Error("not found");
				return canonical;
			},
			async isDirectory(path) {
				return directories.has(path);
			},
		},
	};
}

const PROJECT_SHA = "1".repeat(40);
const ORIGIN_SHA = "2".repeat(40);

test("relative project paths resolve to the canonical checkout and local current base", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repos/project",
			{
				topLevel: "/repos/project",
				gitDirectory: ".git",
				remoteUrl: "https://example.invalid/project.git",
				symbolicRefs: new Map([["HEAD", "feature/work"]]),
				objectIds: new Map([["refs/heads/feature/work", PROJECT_SHA]]),
			},
		],
	]);
	const result = await resolveProject(
		{
			cwd: "/work",
			project: "checkout/subdir",
		},
		host(
			repositories,
			new Map([["/work/checkout/subdir", "/repos/project/subdir"]]),
		),
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value).toEqual({
		checkout: "/repos/project",
		origin: "/repos/project",
		originIsCheckout: true,
		base: "feature/work",
		baseRef: "refs/heads/feature/work",
		baseSha: PROJECT_SHA,
	});
	expect(projectStateRootKey(result.value.checkout)).toMatch(
		/^project-[0-9a-f]{10}$/u,
	);
	expect(projectStateRootPath("/Users/test", result.value.checkout)).toBe(
		`/Users/test/.kogen/workspaces/${projectStateRootKey("/repos/project")}`,
	);
});

test("a symlinked checkout uses the canonical path for its single state root", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/work/checkout",
			{
				topLevel: "/work/checkout",
				gitDirectory: ".git",
				symbolicRefs: new Map([["HEAD", "main"]]),
				objectIds: new Map([["refs/heads/main", PROJECT_SHA]]),
			},
		],
	]);
	const dependencies = host(
		repositories,
		new Map([["/case/link to checkout", "/work/checkout"]]),
	);
	const throughLink = await resolveProject(
		{ cwd: "/case", project: "link to checkout" },
		dependencies,
	);
	const direct = await resolveProject({ cwd: "/work/checkout" }, dependencies);

	expect(throughLink.ok).toBe(true);
	expect(direct.ok).toBe(true);
	if (!throughLink.ok || !direct.ok) return;
	expect(throughLink.value.checkout).toBe("/work/checkout");
	expect(projectStateRootKey(throughLink.value.checkout)).toBe(
		projectStateRootKey(direct.value.checkout),
	);
	expect(projectStateRootKey(throughLink.value.checkout)).toMatch(
		/^checkout-[0-9a-f]{10}$/u,
	);
});

test("local relative remote origin and its HEAD take precedence over checkout branch", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repos/project",
			{
				topLevel: "/repos/project",
				gitDirectory: ".git",
				remoteUrl: "../origin.git",
				symbolicRefs: new Map([["HEAD", "refs/heads/topic"]]),
			},
		],
		[
			"/repos/origin.git",
			{
				topLevel: "/repos/origin.git",
				gitDirectory: ".",
				symbolicRefs: new Map([["HEAD", "refs/heads/main"]]),
				objectIds: new Map([["refs/heads/main", ORIGIN_SHA]]),
			},
		],
	]);
	const result = await resolveProject(
		{ cwd: "/repos/project" },
		host(repositories),
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value).toMatchObject({
		checkout: "/repos/project",
		origin: "/repos/origin.git",
		originIsCheckout: false,
		base: "main",
		baseRef: "refs/heads/main",
		baseSha: ORIGIN_SHA,
	});
});

test("tilde and file URL remotes resolve as local repositories", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repo",
			{
				topLevel: "/repo",
				gitDirectory: ".git",
				remoteUrl: "~/origin.git",
			},
		],
		[
			"/Users/test/origin.git",
			{
				topLevel: "/Users/test/origin.git",
				gitDirectory: ".",
				symbolicRefs: new Map([["HEAD", "refs/heads/main"]]),
				objectIds: new Map([["refs/heads/main", ORIGIN_SHA]]),
			},
		],
	]);
	const result = await resolveProject(
		{ cwd: "/repo", home: "/Users/test" },
		host(repositories),
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value).toMatchObject({
		origin: "/Users/test/origin.git",
		base: "main",
		baseSha: ORIGIN_SHA,
	});
});

test("explicit origin and base take precedence over config and remote HEAD", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repo",
			{
				topLevel: "/repo",
				gitDirectory: ".git",
				remoteUrl: "../default.git",
			},
		],
		[
			"/chosen.git",
			{
				topLevel: "/chosen.git",
				gitDirectory: ".",
				objectIds: new Map([["refs/heads/release", ORIGIN_SHA]]),
			},
		],
	]);
	const result = await resolveProject(
		{
			cwd: "/repo",
			origin: "/chosen.git",
			base: "release",
			configuredBase: "ignored-config-base",
		},
		host(repositories),
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value).toMatchObject({
		origin: "/chosen.git",
		base: "release",
		baseRef: "refs/heads/release",
		baseSha: ORIGIN_SHA,
	});
});

test("checkout remote-tracking HEAD beats its current branch", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repo",
			{
				topLevel: "/repo",
				gitDirectory: ".git",
				remoteUrl: "ssh://example.invalid/project.git",
				symbolicRefs: new Map([
					["refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
					["HEAD", "refs/heads/topic"],
				]),
				objectIds: new Map([["refs/remotes/origin/main", PROJECT_SHA]]),
			},
		],
	]);
	const result = await resolveProject({ cwd: "/repo" }, host(repositories));
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value).toMatchObject({
		base: "main",
		baseRef: "refs/remotes/origin/main",
	});
});

test("detached checkout with no project or remote HEAD has no base", async () => {
	const repositories = new Map<string, FakeRepository>([
		[
			"/repo",
			{
				topLevel: "/repo",
				gitDirectory: ".git",
				symbolicRefs: new Map(),
			},
		],
	]);
	const result = await resolveProject({ cwd: "/repo" }, host(repositories));
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error).toMatchObject({ code: "base_unavailable" });
});

test("missing project and invalid explicit origin are distinguished", async () => {
	const repositories = new Map<string, FakeRepository>();
	const missing = await resolveProject({ cwd: "/missing" }, host(repositories));
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.error.code).toBe("project_unavailable");

	const invalidOriginRepos = new Map<string, FakeRepository>([
		["/repo", { topLevel: "/repo", gitDirectory: ".git" }],
	]);
	const invalidOrigin = await resolveProject(
		{ cwd: "/repo", origin: "/not-a-repository" },
		host(invalidOriginRepos),
	);
	expect(invalidOrigin.ok).toBe(false);
	if (!invalidOrigin.ok)
		expect(invalidOrigin.error.code).toBe("origin_unavailable");
});
