import { expect, test } from "bun:test";
import { parseArgv } from "../../packages/cli/src/argv";
import type { ControllerRuntime } from "../../packages/cli/src/composition";
import { runI2ProviderCommand } from "../../packages/cli/src/i2-auth";

test("provider use refuses an account without a saved login before writing selection", async () => {
	const parsed = parseArgv(["provider", "use", "chatgpt", "--as", "absent"]);
	if (parsed.kind !== "command" || parsed.command.name !== "provider use")
		throw new Error("Provider use command did not parse.");
	const reads: string[] = [];
	let writes = 0;
	const runtime = {
		filesystem: {
			async readFile(request: { path: string }) {
				reads.push(request.path);
				return {
					ok: false as const,
					error: {
						code: "not_found" as const,
						message: "File is absent.",
						retryable: false,
					},
				};
			},
			async writeFileAtomically() {
				writes += 1;
				return { ok: true as const, value: undefined };
			},
		},
	} as unknown as ControllerRuntime;
	const result = await runI2ProviderCommand(parsed.command, runtime);
	expect(result.exitCode).toBe(4);
	expect(result.stdout).toContain("Selected account absent has no saved login");
	expect(reads).toEqual(["accounts.yaml", "profiles.json"]);
	expect(writes).toBe(0);
});
