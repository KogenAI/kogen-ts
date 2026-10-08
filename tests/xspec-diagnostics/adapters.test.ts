import { expect, test } from "bun:test";
import { XspecProtocolError } from "../../packages/xspec/src/protocol";
import { createAccountsSlice } from "../../packages/xspec/src/slices/accounts";
import { createGateSlice } from "../../packages/xspec/src/slices/gate";
import { createSetupCacheSlice } from "../../packages/xspec/src/slices/setup-cache";

test("accounts diagnostic resolves provider and account through production selection", async () => {
	const slice = createAccountsSlice();
	await slice.reset();
	await slice.apply({
		tag: "Seed",
		value: {
			provider: "grok",
			label: "work",
			present: true,
			saved: true,
			signedIn: true,
			email: "work@example.test",
			expires: 300,
			hasExpiry: true,
			notice: false,
			remoteRevoked: false,
		},
	});
	await slice.apply({
		tag: "Project",
		value: {
			name: "alpha",
			exists: true,
			provider: "grok",
			account: "default",
		},
	});
	await slice.apply({
		tag: "Use",
		value: {
			provider: "grok",
			label: "work",
			project: "alpha",
			projectExists: true,
		},
	});
	const observation = await slice.apply({
		tag: "Resolve",
		value: { project: "alpha" },
	});
	expect(observation).toMatchObject({
		last: "ok",
		operation: "resolve",
		resolvedProvider: "grok",
		resolvedLabel: "work",
		resolvedSaved: true,
		providerAlpha: "grok",
		grokAlpha: "work",
	});
});

test("accounts diagnostic rejects unsupported fields instead of projecting them away", async () => {
	const slice = createAccountsSlice();
	await slice.reset();
	await expect(
		slice.apply({
			tag: "Environment",
			value: { provider: "chatgpt", account: "default", ignored: true },
		}),
	).rejects.toBeInstanceOf(XspecProtocolError);
});

test("gate diagnostic keeps auditor advice observational and ranks actual gate candidates", async () => {
	const slice = createGateSlice();
	await slice.reset();
	await slice.apply({
		tag: "Rows",
		value: {
			id: "A1",
			kind: "change",
			report: "ok",
			runnerDown: false,
			exit0: true,
			mutated: false,
			failed: 0,
			rows: 1,
		},
	});
	await slice.apply({
		tag: "Rows",
		value: {
			id: "A2",
			kind: "change",
			report: "ok",
			runnerDown: false,
			exit0: true,
			mutated: false,
			failed: 1,
			rows: 1,
		},
	});
	await slice.apply({
		tag: "Score",
		value: { policy: "green-or-advisory" },
	});
	const advised = await slice.apply({
		tag: "Demote",
		value: { id: "A2", verdict: "over_strict" },
	});
	expect(advised).toMatchObject({
		verdict: "unverified",
		landable: false,
		items: {
			A1: { passed: true, demoted: false },
			A2: { passed: false, demoted: false },
		},
	});
	await slice.apply({
		tag: "Offer",
		value: { rung: "1", passed: 1, blocking: 1, diff: 3 },
	});
	await slice.apply({
		tag: "Offer",
		value: { rung: "2", passed: 1, blocking: 0, diff: 2 },
	});
	expect(await slice.apply({ tag: "Pick" })).toMatchObject({
		winner: "2",
		landable: false,
	});
});

test("gate diagnostic fails on unsupported event fields", async () => {
	const slice = createGateSlice();
	await slice.reset();
	await expect(
		slice.apply({ tag: "Pick", value: { override: true } }),
	).rejects.toBeInstanceOf(XspecProtocolError);
	await expect(
		slice.apply({
			tag: "Offer",
			value: {
				rung: "1",
				passed: 0,
				blocking: 0,
				diff: Number.MAX_SAFE_INTEGER,
			},
		}),
	).rejects.toBeInstanceOf(XspecProtocolError);
});

test("setup-cache diagnostic delegates hits and copy-on-write restores to production cache policy", async () => {
	const slice = createSetupCacheSlice();
	await slice.reset();
	const run = (payload: string) =>
		slice.apply({
			tag: "Run",
			value: {
				base: "a",
				variant: "",
				tracked: false,
				input: "",
				enabled: true,
				stable: true,
				ok: true,
				payload,
			},
		});
	await run("seed-a");
	expect(await run("ignored")).toMatchObject({
		entryCount: 1,
		last: "hit",
		work: "seed-a",
		setupRuns: 1,
	});
	await slice.apply({ tag: "Mutate", value: { payload: "candidate-edit" } });
	expect(await run("ignored-again")).toMatchObject({
		entryCount: 1,
		last: "hit",
		work: "seed-a",
		setupRuns: 1,
	});
});

test("setup-cache diagnostic does not publish failed setup output and rejects unsupported fields", async () => {
	const slice = createSetupCacheSlice();
	await slice.reset();
	const failed = await slice.apply({
		tag: "Run",
		value: {
			base: "a",
			variant: "",
			tracked: false,
			input: "",
			enabled: true,
			stable: true,
			ok: false,
			payload: "failed",
		},
	});
	expect(failed).toMatchObject({
		entryCount: 0,
		present: false,
		last: "failed",
		setupRuns: 1,
	});
	await expect(
		slice.apply({ tag: "Mutate", value: { payload: "x", extra: true } }),
	).rejects.toBeInstanceOf(XspecProtocolError);
});
