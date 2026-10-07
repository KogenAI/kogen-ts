import { expect, test } from "bun:test";
import type { ApprovalBaselineCacheEntry } from "../../packages/core/src/approval/preflight";
import {
	APPROVAL_BASELINE_CACHE_DIRECTORY,
	APPROVAL_BASELINE_CACHE_MODE,
	createApprovalBaselineCache,
} from "../../packages/core/src/cache/baseline";
import type {
	PortError,
	Result,
} from "../../packages/core/src/contracts/errors";
import type { FileSystemPort } from "../../packages/core/src/contracts/ports";

const ROOT = "/tmp/kogen-state";
const KEY = "b".repeat(64);
const BASE_TREE = "a".repeat(40);

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: false };
}

class MemoryFileSystem
	implements Pick<FileSystemPort, "readFile" | "writeFileAtomically">
{
	readonly files = new Map<string, Uint8Array>();
	readonly writes: { path: string; mode: number; bytes: Uint8Array }[] = [];
	failWrites = false;

	private key(root: string, path: string): string {
		return `${root}\0${path}`;
	}

	async readFile(request: {
		readonly root: string;
		readonly path: string;
		readonly maxBytes: number;
	}): Promise<Result<Uint8Array>> {
		const value = this.files.get(this.key(request.root, request.path));
		if (value === undefined)
			return { ok: false, error: error("not_found", "file does not exist") };
		if (value.byteLength > request.maxBytes)
			return { ok: false, error: error("invalid_input", "file exceeds limit") };
		return { ok: true, value: value.slice() };
	}

	async writeFileAtomically(request: {
		readonly root: string;
		readonly path: string;
		readonly bytes: Uint8Array;
		readonly mode: number;
	}): Promise<Result<void>> {
		if (this.failWrites)
			return {
				ok: false,
				error: error("io", "simulated atomic write failure"),
			};
		const bytes = request.bytes.slice();
		this.files.set(this.key(request.root, request.path), bytes);
		this.writes.push({ path: request.path, mode: request.mode, bytes });
		return { ok: true, value: undefined };
	}

	put(path: string, bytes: Uint8Array): void {
		this.files.set(this.key(ROOT, path), bytes.slice());
	}

	get(path: string): Uint8Array | undefined {
		return this.files.get(this.key(ROOT, path))?.slice();
	}
}

const row = {
	name: "lint",
	status: "red",
	exit_status: 1,
	findings: [
		{
			path: "lib/a.txt",
			rule: "lint/todo",
			symbol: "TODO",
			message: "TODO remains",
			line: 2,
		},
	],
} as const;

function entry(
	overrides: Partial<ApprovalBaselineCacheEntry> = {},
): ApprovalBaselineCacheEntry {
	return {
		key: KEY,
		checkedBaseTree: BASE_TREE,
		checks: [row],
		...overrides,
	};
}

test("baseline cache writes one atomic v3 entry at the checked-tree key", async () => {
	const filesystem = new MemoryFileSystem();
	const cache = createApprovalBaselineCache(filesystem, ROOT);
	const put = await cache.put(entry());
	expect(put.ok).toBe(true);
	expect(filesystem.writes).toHaveLength(1);
	expect(filesystem.writes[0]).toMatchObject({
		path: `${APPROVAL_BASELINE_CACHE_DIRECTORY}/${KEY}.json`,
		mode: APPROVAL_BASELINE_CACHE_MODE,
	});
	const disk = JSON.parse(
		new TextDecoder().decode(
			filesystem.get(`${APPROVAL_BASELINE_CACHE_DIRECTORY}/${KEY}.json`),
		),
	);
	expect(disk).toMatchObject({ v: 3, key: KEY, checked_base_tree: BASE_TREE });
	expect(disk.checks).toEqual([row]);
	const hit = await cache.get({ key: KEY, checkedBaseTree: BASE_TREE });
	expect(hit).toEqual({ ok: true, value: entry() });
});

test("different checked tree, legacy version, and malformed data are misses", async () => {
	const filesystem = new MemoryFileSystem();
	const cache = createApprovalBaselineCache(filesystem, ROOT);
	await cache.put(entry());
	const changedTree = await cache.get({
		key: KEY,
		checkedBaseTree: "c".repeat(40),
	});
	expect(changedTree).toEqual({ ok: true, value: null });

	filesystem.put(
		`${APPROVAL_BASELINE_CACHE_DIRECTORY}/${KEY}.json`,
		new TextEncoder().encode(
			JSON.stringify({
				v: 2,
				key: KEY,
				checked_base_tree: BASE_TREE,
				checks: [row],
			}),
		),
	);
	expect(await cache.get({ key: KEY, checkedBaseTree: BASE_TREE })).toEqual({
		ok: true,
		value: null,
	});

	filesystem.put(
		`${APPROVAL_BASELINE_CACHE_DIRECTORY}/${KEY}.json`,
		new TextEncoder().encode("{broken"),
	);
	expect(await cache.get({ key: KEY, checkedBaseTree: BASE_TREE })).toEqual({
		ok: true,
		value: null,
	});
});

test("invalid rows and failed atomic writes cannot create a cache hit", async () => {
	const filesystem = new MemoryFileSystem();
	const cache = createApprovalBaselineCache(filesystem, ROOT);
	const invalid = {
		...entry(),
		checks: [{ ...row, status: "unknown" }],
	} as unknown as ApprovalBaselineCacheEntry;
	expect(await cache.put(invalid)).toMatchObject({ ok: false });
	expect(filesystem.files.size).toBe(0);

	filesystem.failWrites = true;
	expect(await cache.put(entry())).toMatchObject({ ok: false });
	filesystem.failWrites = false;
	expect(await cache.get({ key: KEY, checkedBaseTree: BASE_TREE })).toEqual({
		ok: true,
		value: null,
	});
});
