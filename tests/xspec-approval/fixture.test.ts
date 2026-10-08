import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { IntentRemoveLifecycle } from "../../packages/core/src/approval/remove";
import { hashApprovalBytes } from "../../packages/core/src/intent/hash";
import {
	createApprovalFixtureDriver,
	fixtureAcceptanceBytes,
	fixtureIntentBytes,
	sourceHashes,
} from "../../packages/test-support/src/approval-fixture";
import {
	decodeProtocolRequest,
	XspecProtocolError,
} from "../../packages/xspec/src/protocol";
import { createApproveSlice } from "../../packages/xspec/src/slices/approve";
import { createIntentSlice } from "../../packages/xspec/src/slices/intent";

const UTF8 = new TextEncoder();
const LIFECYCLE: IntentRemoveLifecycle = {
	activeBuild: false,
	landed: false,
	buildDisposition: null,
};

async function gitBytes(
	driver: Awaited<ReturnType<typeof createApprovalFixtureDriver>>,
	argv: readonly string[],
): Promise<Uint8Array> {
	const result = await driver.git.command({
		repository: driver.origin,
		argv,
		timeoutMilliseconds: 30_000,
		outputLimitBytes: 64 * 1024,
	});
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.timedOut || result.value.exitCode !== 0)
		throw new Error(new TextDecoder().decode(result.value.stderr));
	return result.value.stdout;
}

test("xspec JSON-lines requests have strict reset/apply and fatal error decoding", () => {
	expect(decodeProtocolRequest('{"op":"reset"}')).toEqual({ op: "reset" });
	expect(
		decodeProtocolRequest('{"op":"apply","event":{"tag":"Shape"}}'),
	).toEqual({ op: "apply", event: { tag: "Shape" } });
	expect(() => decodeProtocolRequest("not json")).toThrow(XspecProtocolError);
	expect(() => decodeProtocolRequest('{"op":"reset","extra":true}')).toThrow(
		XspecProtocolError,
	);
	expect(() => decodeProtocolRequest('{"op":"unknown"}')).toThrow(
		XspecProtocolError,
	);
});

test("xspec main keeps one process across reset/apply and exits on a malformed line", () => {
	const executable = Bun.which("bun");
	if (executable === null) throw new Error("Bun is unavailable");
	const cardEvent = {
		tag: "Approve",
		value: {
			slug: "alpha",
			given: "",
			prefixOk: true,
			stableBeforeCas: true,
			newSha8: "bbbb2222",
			sha: "aaaa1111bbbb2222",
			sha8: "aaaa1111",
			by: "",
			byBad: false,
			ident: "Fixture <fixture@kogen.invalid>",
			parseErr: false,
			lintErr: false,
			lintWarn: false,
			missing: false,
			setup: "ok",
			baseTree: "tree-a",
			cacheKey: "fixture",
			baseline: "green",
			acceptance: "green",
			witnessMode: false,
			feas: "not checked",
			commit: "c1",
			baseSha: "b0",
		},
	};
	const result = spawnSync(
		executable,
		[
			"--no-install",
			resolve(process.cwd(), "packages/xspec/src/main.ts"),
			"approve",
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
			input: [
				JSON.stringify({ op: "reset" }),
				JSON.stringify({ op: "apply", event: cardEvent }),
				JSON.stringify({ op: "reset" }),
				"not json",
			].join("\n"),
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 64 * 1024,
		},
	);
	const output = result.stdout.toString().trim().split("\n");
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(70);
	expect(output).toHaveLength(3);
	expect(JSON.parse(output[0] ?? "{}").last).toBe("ok");
	expect(JSON.parse(output[1] ?? "{}").last).toBe("needs_decision");
	expect(JSON.parse(output[2] ?? "{}").approvals).toEqual({});
	expect(result.stderr.toString()).toContain("kogen-xspec invalid_json:");
});

test("fixture hashes exact bytes and publishes a real approval CAS commit", async () => {
	const driver = await createApprovalFixtureDriver();
	try {
		const intent = new Uint8Array([
			...fixtureIntentBytes("alpha", "raw-byte-identity"),
			0xff,
			0x00,
		]);
		const acceptance = UTF8.encode("# exact CRLF\r\nt_A1() { true; }\r\n");
		const source = { intent, acceptance };
		driver.writeSources("alpha", source);
		const hashes = sourceHashes(source);
		expect(hashes.approvalSha256).toBe(hashApprovalBytes(intent, acceptance));
		const result = await driver.approve({
			slug: "alpha",
			givenHash: hashes.approvalSha256.slice(0, 8),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ref = await driver.approvalRef("alpha");
		expect(ref).toMatchObject({
			commit: result.value.approvalCommit,
			approvalSha256: hashes.approvalSha256,
			parent: null,
		});
		expect(
			await gitBytes(driver, [
				"cat-file",
				"blob",
				`${result.value.approvalCommit}:.kogen/intents/alpha/intent.md`,
			]),
		).toEqual(intent);
		expect(
			await gitBytes(driver, [
				"cat-file",
				"blob",
				`${result.value.approvalCommit}:.kogen/acceptance/alpha.t.sh`,
			]),
		).toEqual(acceptance);
		const approvalJson = JSON.parse(
			new TextDecoder().decode(
				await gitBytes(driver, [
					"cat-file",
					"blob",
					`${result.value.approvalCommit}:.kogen/intents/alpha/approval.json`,
				]),
			),
		) as { approval_sha256: string };
		expect(approvalJson.approval_sha256).toBe(hashes.approvalSha256);
	} finally {
		driver.close();
	}
});

test("late Intent and test mutations refuse before moving the real approval ref", async () => {
	const driver = await createApprovalFixtureDriver();
	try {
		for (const sourceName of ["intent", "acceptance"] as const) {
			await driver.reset();
			const source = driver.readSources("alpha");
			const originalHash = hashApprovalBytes(source.intent, source.acceptance);
			const changed =
				sourceName === "intent"
					? fixtureIntentBytes("alpha", "changed-at-second-read")
					: fixtureAcceptanceBytes("alpha", "changed-at-second-read");
			const result = await driver.approve({
				slug: "alpha",
				givenHash: originalHash.slice(0, 8),
				lateMutation: { source: sourceName, bytes: changed },
			});
			expect(result).toMatchObject({
				ok: false,
				error: { code: "intent/hash_mismatch", exitCode: 1 },
			});
			expect(await driver.approvalRef("alpha")).toBeNull();
			const after = driver.readSources("alpha");
			expect(after[sourceName]).toEqual(changed);
		}
	} finally {
		driver.close();
	}
});

test("real Git CAS retries once and leaves the prior approval on a second loss", async () => {
	const driver = await createApprovalFixtureDriver();
	try {
		const firstSource = driver.readSources("alpha");
		const firstHash = hashApprovalBytes(
			firstSource.intent,
			firstSource.acceptance,
		);
		const first = await driver.approve({
			slug: "alpha",
			givenHash: firstHash.slice(0, 8),
			casRace: 1,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.retryCount).toBe(1);
		const firstRef = await driver.approvalRef("alpha");
		expect(firstRef?.commit).toBe(first.value.approvalCommit);

		const revised = {
			intent: fixtureIntentBytes("alpha", "second-approval"),
			acceptance: fixtureAcceptanceBytes("alpha", "second-approval"),
		};
		driver.writeSources("alpha", revised);
		const revisedHash = hashApprovalBytes(revised.intent, revised.acceptance);
		const lost = await driver.approve({
			slug: "alpha",
			givenHash: revisedHash.slice(0, 8),
			casRace: 2,
		});
		expect(lost).toMatchObject({
			ok: false,
			error: { code: "environment/approval_cas_failed", exitCode: 3 },
		});
		expect(await driver.approvalRef("alpha")).toEqual(firstRef);
	} finally {
		driver.close();
	}
});

test("real Intent removal commits tracked deletions and compare-deletes the approval ref", async () => {
	const driver = await createApprovalFixtureDriver();
	try {
		const source = driver.readSources("alpha");
		const hash = hashApprovalBytes(source.intent, source.acceptance);
		const approved = await driver.approve({
			slug: "alpha",
			givenHash: hash.slice(0, 8),
		});
		expect(approved.ok).toBe(true);
		const removed = await driver.remove({
			slug: "alpha",
			force: true,
			lifecycle: LIFECYCLE,
		});
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.value.deletedApprovalRef).toBe(true);
		expect(await driver.approvalRef("alpha")).toBeNull();
		const tracked = await driver.git.command({
			repository: driver.checkout,
			argv: ["ls-files", "--error-unmatch", ".kogen/intents/alpha/intent.md"],
			timeoutMilliseconds: 30_000,
			outputLimitBytes: 4096,
		});
		expect(tracked.ok && tracked.value.exitCode).not.toBe(0);
	} finally {
		driver.close();
	}
});

test("Intent adapter keeps the full observation across reset and apply", async () => {
	const slice = await createIntentSlice();
	try {
		expect(await slice.reset()).toEqual({
			last: "ok",
			exit: 0,
			did: "",
			shown: "",
			casTries: 0,
			life: {},
			refs: {},
		});
		const shaped = await slice.apply({
			tag: "Shape",
			value: { slug: "alpha", result: "valid" },
		});
		expect(shaped).toMatchObject({
			last: "ok",
			exit: 0,
			did: "shaped",
			life: { alpha: "shaped" },
			refs: {},
		});
		expect(await slice.reset()).toMatchObject({
			life: {},
			refs: {},
			casTries: 0,
		});
	} finally {
		await slice.close?.();
	}
});

test("approve adapter keeps a hermetic Git author when --by supplies the approver", async () => {
	const slice = await createApproveSlice();
	try {
		await slice.reset();
		const observation = await slice.apply({
			tag: "Approve",
			value: {
				slug: "alpha",
				given: "aaaa1111",
				prefixOk: true,
				stableBeforeCas: true,
				newSha8: "bbbb2222",
				sha: "aaaa1111bbbb2222",
				sha8: "aaaa1111",
				by: "ci-bot",
				byBad: false,
				ident: "",
				parseErr: false,
				lintErr: false,
				lintWarn: false,
				missing: false,
				setup: "ok",
				baseTree: "tree-a",
				cacheKey: "fixture",
				baseline: "green",
				acceptance: "green",
				witnessMode: false,
				feas: "not checked",
				commit: "c1",
				baseSha: "b0",
			},
		});
		expect(observation).toMatchObject({
			last: "ok",
			exit: 0,
			approver: "ci-bot",
			approvals: { alpha: { by: "ci-bot", sha: "aaaa1111bbbb2222" } },
		});
	} finally {
		await slice.close?.();
	}
});
