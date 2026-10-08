import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileChatGptRefreshLocks } from "../../packages/cli/src/refresh-lock";

test("file refresh lock excludes another process identity and releases only its owner", async () => {
	const root = mkdtempSync(join(tmpdir(), "kogen-refresh-lock-"));
	const first = new FileChatGptRefreshLocks();
	const second = new FileChatGptRefreshLocks();
	const path = "locks/chatgpt-default.lock";
	const owner = new TextEncoder().encode("owner-a");
	const other = new TextEncoder().encode("owner-b");
	try {
		expect(await first.tryCreateDirectory(root, path)).toEqual({
			ok: true,
			value: "created",
		});
		expect(await first.writeOwner(root, path, owner)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await second.tryCreateDirectory(root, path)).toEqual({
			ok: true,
			value: "exists",
		});
		const observed = await second.observe(root, path);
		expect(observed.ok).toBe(true);
		if (!observed.ok) return;
		expect(observed.value.ownerBytes).toEqual(owner);
		expect(
			Number.isSafeInteger(observed.value.directoryModifiedAtUnixMilliseconds),
		).toBe(true);
		expect(await second.releaseIfOwner(root, path, other)).toEqual({
			ok: true,
			value: false,
		});
		expect(await first.releaseIfOwner(root, path, owner)).toEqual({
			ok: true,
			value: true,
		});
		expect(await second.tryCreateDirectory(root, path)).toEqual({
			ok: true,
			value: "created",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
