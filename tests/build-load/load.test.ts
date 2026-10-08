import { expect, test } from "bun:test";
import {
	buildToolAuthorization,
	buildToolSchemas,
	loadPublicBuildMachineConfig,
	readBuildGitText,
	resolvePublicBuildAccount,
} from "../../packages/cli/src/build-composition";
import { loadBuildApproval } from "../../packages/core/src/build/load";
import type { GitPort } from "../../packages/core/src/contracts/ports";
import { GIT_MAX_OUTPUT_LIMIT_BYTES } from "../../packages/core/src/git/command";

test("Build reads approval blobs within the supervised Git output bound", async () => {
	const commit = "a".repeat(40);
	const tree = "b".repeat(40);
	const seen: number[] = [];
	const git: GitPort = {
		async command(request) {
			seen.push(request.outputLimitBytes);
			if (request.outputLimitBytes > GIT_MAX_OUTPUT_LIMIT_BYTES)
				return {
					ok: false,
					error: {
						code: "invalid_input",
						message: "Git output limit exceeded",
						retryable: false,
					},
				};
			const command = request.argv[0];
			const output =
				command === "for-each-ref"
					? `refs/kogen/intents/greet\0${commit}\0\n`
					: command === "cat-file" && request.argv[1] === "-p"
						? `tree ${tree}\n\nApproval fixture\n`
						: "{}";
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new TextEncoder().encode(output),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	const result = await loadBuildApproval({
		git,
		origin: "/tmp/approval-fixture.git",
		slug: "greet",
	});
	expect(result).toMatchObject({
		ok: false,
		error: { code: "controller/approval_invalid" },
	});
	expect(seen.length).toBeGreaterThan(2);
	expect(Math.max(...seen)).toBeLessThanOrEqual(GIT_MAX_OUTPUT_LIMIT_BYTES);
});

test("Build base reads use a Git output bound accepted by the production port", async () => {
	const git: GitPort = {
		async command(request) {
			if (request.outputLimitBytes > GIT_MAX_OUTPUT_LIMIT_BYTES)
				return {
					ok: false,
					error: {
						code: "invalid_input",
						message: "Git output limit exceeded",
						retryable: false,
					},
				};
			return {
				ok: true,
				value: {
					exitCode: 0,
					signal: null,
					stdout: new TextEncoder().encode("abc123\n"),
					stderr: new Uint8Array(),
					timedOut: false,
				},
			};
		},
	};
	expect(
		await readBuildGitText(git, "/tmp/base-fixture.git", ["rev-parse", "HEAD"]),
	).toBe("abc123");
});

test("public shell Build sends the shell schema set and keeps planner tool calls disabled", () => {
	const schemas = buildToolSchemas("ladder");
	const names = schemas.map((schema) => schema.name);
	expect(names).toEqual(["shell", "finish", "tool_output"]);
	const authorization = buildToolAuthorization("ladder");
	expect(authorization.builder).toEqual(names);
	expect(authorization.planner).toEqual([]);
	expect(authorization.shaper).toEqual([]);
	expect(buildToolSchemas("direct")).toHaveLength(7);
});

test("public Build honors provider-use project selection and benchmark override", async () => {
	const filesystem = {
		async readFile() {
			return {
				ok: true as const,
				value: new TextEncoder().encode(
					'chatgpt:\n  default: personal\n  projects:\n    - path: "/work/project"\n      account: work\nselection:\n  default: chatgpt\n',
				),
			};
		},
	};
	const input = {
		filesystem,
		homeDirectory: "/home/test",
		checkout: "/work/project",
	};
	expect(await resolvePublicBuildAccount(input)).toEqual({
		ok: true,
		value: "work",
	});
	expect(
		await resolvePublicBuildAccount({
			...input,
			environment: { KOGEN_BENCH_ACCOUNT: "bench" },
		}),
	).toEqual({ ok: true, value: "bench" });
	expect(
		await resolvePublicBuildAccount({
			...input,
			environment: { KOGEN_BENCH_PROVIDER: "grok" },
		}),
	).toMatchObject({
		ok: false,
		error: { code: "environment/provider_unavailable" },
	});
});

test("public Build loads machine planner defaults for project role resolution", async () => {
	const loaded = await loadPublicBuildMachineConfig(
		{
			async readFile(request) {
				expect(request).toMatchObject({
					root: "/home/test/.kogen",
					path: "config.yaml",
				});
				return {
					ok: true,
					value: new TextEncoder().encode(
						"build:\n  roles:\n    builder: {model: machine-builder, effort: low}\n    planner: {model: machine-planner, effort: low}\n",
					),
				};
			},
		},
		"/home/test",
	);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) throw new Error(loaded.error.message);
	expect(loaded.value.build.roles?.get("builder")).toEqual({
		model: "machine-builder",
		effort: "low",
	});
	expect(loaded.value.build.roles?.get("planner")).toEqual({
		model: "machine-planner",
		effort: "low",
	});
});
