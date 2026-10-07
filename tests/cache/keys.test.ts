import { expect, test } from "bun:test";
import { approvalBaselineCacheKey } from "../../packages/core/src/approval/preflight";
import {
	type ApprovalBaselineKeyInput,
	approvalBaselineCacheKeyV3,
	canonicalCacheJson,
	fingerprintSetupInput,
	type SetupCacheKeyInput,
	setupCacheKey,
} from "../../packages/core/src/cache/keys";
import type { CheckSpec } from "../../packages/core/src/project/schema";

const BASE_TREE = "a".repeat(40);
const SETUP: readonly CheckSpec[] = [
	{ name: "install", argv: ["sh", "checks/setup.sh"], timeoutMs: 60_000 },
];
const CHECK: CheckSpec = {
	name: "lint",
	argv: ["sh", "checks/lint.sh"],
	timeoutMs: 60_000,
};
const CHECKS: readonly CheckSpec[] = [CHECK];

function setupInput(
	overrides: Partial<SetupCacheKeyInput> = {},
): SetupCacheKeyInput {
	return {
		baseTree: BASE_TREE,
		setup: SETUP,
		setupOutputs: ["build"],
		setupInputs: [],
		inputs: null,
		childEnv: {
			PATH: "/usr/bin",
			MISE_CONFORMANCE_FLAVOUR: "stable",
			TMPDIR: "/tmp/first",
			MISE_STATE_DIR: "/state/first",
		},
		os: "darwin",
		arch: "arm64",
		elixir: "1.18.4",
		otp: "27.3.4",
		...overrides,
	};
}

function baselineInput(
	overrides: Partial<ApprovalBaselineKeyInput> = {},
): ApprovalBaselineKeyInput {
	return {
		checkedBaseTree: BASE_TREE,
		setupKey: "b".repeat(64),
		checks: CHECKS,
		childEnv: { PATH: "/usr/bin" },
		toolchain: { shell: "bash-5.2" },
		os: "darwin",
		arch: "arm64",
		adapterVersion: "command-v1",
		...overrides,
	};
}

function inputFingerprint(path: string, mode: number, content: string) {
	const value = fingerprintSetupInput(
		path,
		mode,
		new TextEncoder().encode(content),
	);
	if (value === null) throw new Error("fixture input fingerprint invalid");
	return value;
}

test("canonical cache JSON sorts object keys by UTF-8 bytes and preserves arrays", () => {
	expect(canonicalCacheJson({ z: 1, a: ["second", "first"] })).toBe(
		'{"a":["second","first"],"z":1}',
	);
});

test("setup v2 key ignores ephemeral directories and binds effective environment", () => {
	const first = setupCacheKey(setupInput());
	const relocated = setupCacheKey(
		setupInput({
			childEnv: {
				MISE_STATE_DIR: "/state/elsewhere",
				TMPDIR: "/tmp/second",
				PATH: "/usr/bin",
				MISE_CONFORMANCE_FLAVOUR: "stable",
			},
		}),
	);
	const changed = setupCacheKey(
		setupInput({
			childEnv: {
				PATH: "/usr/bin",
				MISE_CONFORMANCE_FLAVOUR: "different",
			},
		}),
	);
	expect(first).toMatch(/^[0-9a-f]{64}$/u);
	expect(relocated).toBe(first);
	expect(changed).not.toBe(first);
	expect(setupCacheKey(setupInput({ baseTree: "c".repeat(40) }))).not.toBe(
		first,
	);
});

test("setup_inputs replace whole-tree identity but bind each selected file byte and mode", () => {
	const lock = fingerprintSetupInput(
		"lockfile",
		0o644,
		new TextEncoder().encode("deps-a\n"),
	);
	if (lock === null) throw new Error("valid input fingerprint was rejected");
	const narrowed = setupInput({ setupInputs: ["lockfile"], inputs: [lock] });
	const first = setupCacheKey(narrowed);
	const sourceOnlyChange = setupCacheKey({
		...narrowed,
		baseTree: "c".repeat(40),
	});
	const contentChange = setupCacheKey({
		...narrowed,
		inputs: [inputFingerprint("lockfile", 0o644, "deps-b\n")],
	});
	const modeChange = setupCacheKey({
		...narrowed,
		inputs: [inputFingerprint("lockfile", 0o755, "deps-a\n")],
	});
	expect(sourceOnlyChange).toBe(first);
	expect(contentChange).not.toBe(first);
	expect(modeChange).not.toBe(first);
	expect(
		setupCacheKey({ ...narrowed, inputs: [{ ...lock, path: "other" }] }),
	).toBeNull();
	expect(setupCacheKey({ ...narrowed, inputs: null })).toBeNull();
	expect(
		fingerprintSetupInput("../lockfile", 0o644, new Uint8Array()),
	).toBeNull();
});

test("unknown setup identity and unsafe outputs disable reuse", () => {
	expect(setupCacheKey(setupInput({ otp: null }))).toBeNull();
	expect(setupCacheKey(setupInput({ childEnv: null }))).toBeNull();
	expect(setupCacheKey(setupInput({ setupOutputs: ["../build"] }))).toBeNull();
	expect(
		setupCacheKey(setupInput({ setupOutputs: ["build", "build/cache"] })),
	).toBeNull();
});

test("v3 baseline identity always binds checked tree and all effective check identities", () => {
	const material = baselineInput();
	const first = approvalBaselineCacheKeyV3(material);
	expect(first).toMatch(/^[0-9a-f]{64}$/u);
	expect(first).toBe(approvalBaselineCacheKey(material));
	expect(
		approvalBaselineCacheKeyV3(
			baselineInput({ checkedBaseTree: "c".repeat(40) }),
		),
	).not.toBe(first);
	expect(
		approvalBaselineCacheKeyV3(
			baselineInput({
				checks: [{ ...CHECK, timeoutMs: 60_001 }],
			}),
		),
	).not.toBe(first);
	expect(
		approvalBaselineCacheKeyV3(
			baselineInput({ childEnv: { PATH: "/usr/local/bin" } }),
		),
	).not.toBe(first);
	expect(
		approvalBaselineCacheKeyV3(
			baselineInput({ toolchain: { shell: "bash-5.3" } }),
		),
	).not.toBe(first);
	expect(
		approvalBaselineCacheKeyV3(baselineInput({ setupKey: null })),
	).toBeNull();
	expect(
		approvalBaselineCacheKeyV3(baselineInput({ toolchain: null })),
	).toBeNull();
	expect(approvalBaselineCacheKeyV3(baselineInput({ os: null }))).toBeNull();
});
