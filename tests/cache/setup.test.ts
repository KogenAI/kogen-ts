import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	fingerprintSetupInput,
	type SetupCacheKeyInput,
	type SetupInputFingerprint,
} from "../../packages/core/src/cache/keys";
import {
	canonicalizeSetupProducts,
	type LockedSetupCachePort,
	runSetupWithCache,
	type SetupCacheEntry,
	type SetupCacheIndexEntry,
	type SetupCacheStoragePort,
	type SetupProduct,
	type SetupWorkspacePort,
} from "../../packages/core/src/cache/setup";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type { CheckSpec } from "../../packages/core/src/project/schema";

const SETUP: readonly CheckSpec[] = [
	{ name: "install", argv: ["sh", "checks/setup.sh"], timeoutMs: 60_000 },
];
const BASE_TREE = "a".repeat(40);

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

function cloneProducts(
	products: readonly SetupProduct[],
): readonly SetupProduct[] {
	return products.map((product) => ({
		...product,
		bytes: product.bytes.slice(),
	}));
}

function productTree(value: string): readonly SetupProduct[] {
	const ready = bytes(value);
	const empty = new Uint8Array();
	return [
		{
			path: "build",
			kind: "directory",
			mode: 0o755,
			bytes: empty,
			sha256: createHash("sha256").update(empty).digest("hex"),
		},
		{
			path: "build/ready",
			kind: "file",
			mode: 0o644,
			bytes: ready,
			sha256: createHash("sha256").update(ready).digest("hex"),
		},
	];
}

class MemorySetupCache implements SetupCacheStoragePort, LockedSetupCachePort {
	readonly entries = new Map<string, SetupCacheEntry>();
	publishFails = false;

	async withExclusiveLock<Value>(
		operation: (locked: LockedSetupCachePort) => Promise<Result<Value>>,
	): Promise<Result<Value>> {
		return operation(this);
	}

	async listComplete(): Promise<Result<readonly SetupCacheIndexEntry[]>> {
		return {
			ok: true,
			value: [...this.entries.values()].map(({ key, last_used_ms }) => ({
				key,
				last_used_ms,
			})),
		};
	}

	async readComplete(key: string): Promise<Result<SetupCacheEntry | null>> {
		const entry = this.entries.get(key);
		return { ok: true, value: entry === undefined ? null : this.clone(entry) };
	}

	async publishComplete(entry: SetupCacheEntry): Promise<Result<void>> {
		if (this.publishFails)
			return {
				ok: false,
				error: error("io", "simulated atomic publication failure"),
			};
		this.entries.set(entry.key, this.clone(entry));
		return { ok: true, value: undefined };
	}

	async touchComplete(key: string, lastUsedMs: number): Promise<Result<void>> {
		const entry = this.entries.get(key);
		if (entry === undefined)
			return { ok: false, error: error("not_found", "cache entry missing") };
		this.entries.set(key, { ...entry, last_used_ms: lastUsedMs });
		return { ok: true, value: undefined };
	}

	async removeEntry(key: string): Promise<Result<void>> {
		this.entries.delete(key);
		return { ok: true, value: undefined };
	}

	private clone(entry: SetupCacheEntry): SetupCacheEntry {
		return { ...entry, outputs: cloneProducts(entry.outputs) };
	}
}

class MemoryWorkspace implements SetupWorkspacePort {
	products: readonly SetupProduct[] = productTree("before");
	inputFingerprints: readonly SetupInputFingerprint[] | null = null;
	captureCount = 0;
	restoreCount = 0;
	failRestore = false;

	async captureSetupInputs(): Promise<
		Result<readonly SetupInputFingerprint[]>
	> {
		return {
			ok: true,
			value: this.inputFingerprints?.map((input) => ({ ...input })) ?? [],
		};
	}

	async captureOutputs(): Promise<Result<readonly SetupProduct[]>> {
		this.captureCount += 1;
		return { ok: true, value: cloneProducts(this.products) };
	}

	async restoreOutputsCopyOnWrite(
		products: readonly SetupProduct[],
	): Promise<Result<void>> {
		this.restoreCount += 1;
		if (this.failRestore)
			return { ok: false, error: error("io", "simulated CoW restore failure") };
		this.products = cloneProducts(products);
		return { ok: true, value: undefined };
	}
}

function keyInput(
	baseTree = BASE_TREE,
	overrides: Partial<SetupCacheKeyInput> = {},
): SetupCacheKeyInput {
	const fingerprint = fingerprintSetupInput(
		"lockfile",
		0o644,
		bytes("deps-v1\n"),
	);
	if (fingerprint === null) throw new Error("fixture fingerprint invalid");
	return {
		baseTree,
		setup: SETUP,
		setupOutputs: ["build"],
		setupInputs: ["lockfile"],
		inputs: [fingerprint],
		childEnv: { PATH: "/usr/bin", TMPDIR: "/tmp/run-a" },
		os: "darwin",
		arch: "arm64",
		elixir: "1.18.4",
		otp: "27.3.4",
		...overrides,
	};
}

async function run(
	cache: MemorySetupCache,
	workspace: MemoryWorkspace,
	input: SetupCacheKeyInput,
	options: {
		readonly nowMs: number;
		readonly setupResult?: Result<{ readonly setupWallMs: number }, string>;
		readonly value?: string;
		readonly setupCounter?: { value: number };
		readonly currentInputs?: readonly SetupInputFingerprint[];
		readonly inputsAfterSetup?: readonly SetupInputFingerprint[];
	},
) {
	if (workspace.inputFingerprints === null)
		workspace.inputFingerprints = options.currentInputs ?? input.inputs ?? [];
	return runSetupWithCache({
		cache,
		workspace,
		keyInput: input,
		outputs: ["build"],
		nowMs: () => options.nowMs,
		runSetup: async () => {
			if (options.setupCounter !== undefined) options.setupCounter.value += 1;
			if (options.setupResult !== undefined) return options.setupResult;
			workspace.products = productTree(options.value ?? "built");
			if (options.inputsAfterSetup !== undefined)
				workspace.inputFingerprints = options.inputsAfterSetup;
			return { ok: true, value: { setupWallMs: 17 } };
		},
	});
}

test("setup snapshot is canonical, lossless, and confined to declared outputs", () => {
	const products = [...productTree("ready")].reverse();
	const canonical = canonicalizeSetupProducts(["build"], products);
	expect(canonical.ok).toBe(true);
	if (!canonical.ok) return;
	const firstProduct = products[0];
	if (firstProduct === undefined)
		throw new Error("setup product fixture missing");
	expect(canonical.value.map((product) => product.path)).toEqual([
		"build",
		"build/ready",
	]);
	expect(canonical.value[1]?.mode).toBe(0o644);
	expect(canonical.value[1]?.bytes).toEqual(bytes("ready"));
	expect(canonicalizeSetupProducts(["build"], [firstProduct]).ok).toBe(false);
	expect(
		canonicalizeSetupProducts(
			["build"],
			[{ ...firstProduct, path: "outside/file" }],
		),
	).toEqual({
		ok: false,
		error: error(
			"invalid_input",
			"Setup output snapshot is incomplete or inconsistent.",
		),
	});
});

test("successful setup publishes a complete entry and restores it copy-on-write", async () => {
	const cache = new MemorySetupCache();
	const workspace = new MemoryWorkspace();
	const firstRun = { value: 0 };
	const first = await run(cache, workspace, keyInput(), {
		nowMs: 100,
		value: "built once",
		setupCounter: firstRun,
	});
	const firstKey = [...cache.entries.keys()][0];
	if (firstKey === undefined)
		throw new Error("setup cache entry was not published");
	expect(first).toEqual({
		ok: true,
		value: {
			setupKey: firstKey,
			reused: false,
			setupWallMs: 17,
		},
	});
	expect(firstRun.value).toBe(1);
	expect(cache.entries.size).toBe(1);
	expect([...cache.entries.values()][0]).toMatchObject({
		v: 2,
		key: firstKey,
		setup_wall_ms: 17,
		last_used_ms: 100,
	});

	const secondRun = { value: 0 };
	workspace.products = productTree("dirty workspace product");
	const second = await run(cache, workspace, keyInput("c".repeat(40)), {
		nowMs: 200,
		setupCounter: secondRun,
	});
	expect(second.ok && second.value.reused).toBe(true);
	expect(second.ok && second.value.setupWallMs).toBe(17);
	expect(secondRun.value).toBe(0);
	expect(workspace.products[1]?.bytes).toEqual(bytes("built once"));
	if (second.ok && second.value.setupKey !== null) {
		const cached = cache.entries.get(second.value.setupKey);
		if (cached === undefined) throw new Error("cache entry disappeared");
		const restoredProduct = workspace.products[1];
		if (restoredProduct === undefined)
			throw new Error("restored product fixture missing");
		restoredProduct.bytes[0] = 0;
		expect(cached.outputs[1]?.bytes).toEqual(bytes("built once"));
	}
});

test("failed setup and failed atomic publication never create reusable hits", async () => {
	const cache = new MemorySetupCache();
	const workspace = new MemoryWorkspace();
	const failed = await run(cache, workspace, keyInput(), {
		nowMs: 100,
		setupResult: { ok: false, error: "setup failed" },
	});
	expect(failed).toEqual({ ok: false, error: "setup failed" });
	expect(cache.entries.size).toBe(0);
	expect(workspace.captureCount).toBe(0);

	cache.publishFails = true;
	const uncached = await run(cache, workspace, keyInput(), { nowMs: 200 });
	expect(uncached.ok && uncached.value.reused).toBe(false);
	expect(cache.entries.size).toBe(0);
	cache.publishFails = false;
	const retried = { value: 0 };
	const next = await run(cache, workspace, keyInput(), {
		nowMs: 300,
		setupCounter: retried,
	});
	expect(next.ok && next.value.reused).toBe(false);
	expect(retried.value).toBe(1);
});

test("setup input changes during the run prevent cache publication and reuse", async () => {
	const cache = new MemorySetupCache();
	const workspace = new MemoryWorkspace();
	const original = keyInput().inputs;
	const changed = fingerprintSetupInput(
		"lockfile",
		0o644,
		bytes("deps-changed\n"),
	);
	if (original === null || changed === null)
		throw new Error("setup input fixture invalid");
	const first = await run(cache, workspace, keyInput(), {
		nowMs: 100,
		currentInputs: original,
		inputsAfterSetup: [changed],
	});
	expect(first.ok && first.value.reused).toBe(false);
	expect(cache.entries.size).toBe(0);

	const secondCounter = { value: 0 };
	const second = await run(cache, workspace, keyInput(), {
		nowMs: 200,
		setupCounter: secondCounter,
	});
	expect(second.ok && second.value.reused).toBe(false);
	expect(secondCounter.value).toBe(1);
	expect(cache.entries.size).toBe(0);
});

test("incomplete, old-version, and corrupt product entries miss", async () => {
	const cache = new MemorySetupCache();
	const workspace = new MemoryWorkspace();
	const key = (await run(cache, workspace, keyInput(), { nowMs: 1 })).ok
		? [...cache.entries.keys()][0]
		: undefined;
	if (key === undefined) throw new Error("setup cache was not seeded");
	const complete = cache.entries.get(key);
	if (complete === undefined) throw new Error("setup entry missing");
	cache.entries.set(key, { ...complete, v: 1 } as unknown as SetupCacheEntry);
	const oldCounter = { value: 0 };
	const oldVersion = await run(cache, workspace, keyInput(), {
		nowMs: 2,
		setupCounter: oldCounter,
	});
	expect(oldVersion.ok && oldVersion.value.reused).toBe(false);
	expect(oldCounter.value).toBe(1);

	const currentKey = [...cache.entries.keys()][0];
	if (currentKey === undefined) throw new Error("replacement entry missing");
	const current = cache.entries.get(currentKey);
	if (current === undefined) throw new Error("replacement entry missing");
	const rootProduct = current.outputs[0];
	const fileProduct = current.outputs[1];
	if (rootProduct === undefined || fileProduct === undefined)
		throw new Error("replacement output snapshot missing");
	const corruptProduct = { ...fileProduct, sha256: "0".repeat(64) };
	cache.entries.set(currentKey, {
		...current,
		outputs: [rootProduct, corruptProduct],
	});
	const corruptCounter = { value: 0 };
	const corrupt = await run(cache, workspace, keyInput(), {
		nowMs: 3,
		setupCounter: corruptCounter,
	});
	expect(corrupt.ok && corrupt.value.reused).toBe(false);
	expect(corruptCounter.value).toBe(1);
});

test("setup cache retains only the three most-recent complete entries", async () => {
	const cache = new MemorySetupCache();
	const workspace = new MemoryWorkspace();
	for (let index = 0; index < 4; index += 1) {
		const tree = String(index + 1).repeat(40);
		const result = await run(
			cache,
			workspace,
			keyInput(tree, { setupInputs: [], inputs: null }),
			{
				nowMs: index + 1,
				value: `entry-${index + 1}`,
			},
		);
		expect(result.ok).toBe(true);
		expect(cache.entries.size).toBeLessThanOrEqual(3);
	}
	const keys = [...cache.entries.keys()];
	expect(keys).toHaveLength(3);

	const hit = await run(
		cache,
		workspace,
		keyInput("2".repeat(40), { setupInputs: [], inputs: null }),
		{ nowMs: 10 },
	);
	expect(hit.ok && hit.value.reused).toBe(true);
	const hitKey = hit.ok ? hit.value.setupKey : null;
	const secondKey = keys[1];
	if (secondKey === undefined) throw new Error("expected LRU entry missing");
	await run(
		cache,
		workspace,
		keyInput("5".repeat(40), { setupInputs: [], inputs: null }),
		{ nowMs: 11 },
	);
	expect(cache.entries.size).toBe(3);
	expect(hitKey !== null && cache.entries.has(hitKey)).toBe(true);
	expect(cache.entries.has(secondKey)).toBe(false);
});
