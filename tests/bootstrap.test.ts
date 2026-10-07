import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
test("isolated checks never inherit user Git signing or identity", () => {
	expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	expect(process.env.KOGEN_CREDENTIAL_STORE).toBe("file");
	const result = spawnSync("git", ["config", "--get", "commit.gpgsign"], {
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("false");
	expect(process.env.OPENAI_API_KEY).toBeUndefined();
});
test("frozen source bytes still match their receipt", async () => {
	const manifest: { files_sha256: Record<string, string> } = await Bun.file(
		join(root, "spec-lock/manifest.json"),
	).json();
	for (const [path, digest] of Object.entries(manifest.files_sha256)) {
		expect(
			createHash("sha256")
				.update(readFileSync(join(root, "spec-lock", path)))
				.digest("hex"),
		).toBe(digest);
	}
});
