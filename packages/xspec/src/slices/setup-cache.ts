import { createHash } from "node:crypto";
import {
	fingerprintSetupInput,
	type SetupCacheKeyInput,
	type SetupInputFingerprint,
} from "../../../core/src/cache/keys";
import {
	type LockedSetupCachePort,
	runSetupWithCache,
	type SetupCacheEntry,
	type SetupCacheStoragePort,
	type SetupWorkspacePort,
} from "../../../core/src/cache/setup";
import type { CheckSpec } from "../../../core/src/project/schema";
import {
	decodeSliceEvent,
	XspecProtocolError,
	type XspecSlice,
} from "../protocol";

interface RunInput {
	readonly base: string;
	readonly variant: string;
	readonly tracked: boolean;
	readonly input: string;
	readonly enabled: boolean;
	readonly stable: boolean;
	readonly ok: boolean;
	readonly payload: string;
}

interface State {
	readonly entries: Map<string, SetupCacheEntry>;
	readonly encoder: TextEncoder;
	readonly decoder: TextDecoder;
	readonly outputs: readonly string[];
	workspace: SetupWorkspacePort;
	cache: SetupCacheStoragePort;
	work: string;
	present: boolean;
	reused: boolean;
	setupRuns: number;
	last: string;
	now: number;
	inputBytes: Uint8Array;
	inputFingerprints: readonly SetupInputFingerprint[] | null;
	allowPublication: boolean;
}

function fail(message: string): never {
	throw new XspecProtocolError("invalid_event", message);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail("Run event does not match the frozen field schema");
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") fail(`Run.${key} must be a string`);
	return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
	const field = value[key];
	if (typeof field !== "boolean") fail(`Run.${key} must be a boolean`);
	return field;
}

function invalid(message: string): {
	ok: false;
	error: { code: "io"; message: string; retryable: false };
} {
	return {
		ok: false,
		error: { code: "io", message, retryable: false },
	};
}

function emptyState(): State {
	const entries = new Map<string, SetupCacheEntry>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const outputs = ["setup-output.txt"];
	const state: State = {
		entries,
		encoder,
		decoder,
		outputs,
		workspace: null as unknown as SetupWorkspacePort,
		cache: null as unknown as SetupCacheStoragePort,
		work: "",
		present: false,
		reused: false,
		setupRuns: 0,
		last: "ok",
		now: 1,
		inputBytes: new Uint8Array(),
		inputFingerprints: null,
		allowPublication: true,
	};

	const locked: LockedSetupCachePort = {
		async listComplete() {
			return {
				ok: true,
				value: [...entries.values()].map((entry) => ({
					key: entry.key,
					last_used_ms: entry.last_used_ms,
				})),
			};
		},
		async readComplete(key) {
			const entry = entries.get(key);
			return { ok: true, value: entry ?? null };
		},
		async publishComplete(entry) {
			if (!state.allowPublication)
				return invalid("Injected setup output was not stable");
			entries.set(entry.key, entry);
			return { ok: true, value: undefined };
		},
		async touchComplete(key, lastUsedMs) {
			const entry = entries.get(key);
			if (entry !== undefined)
				entries.set(key, { ...entry, last_used_ms: lastUsedMs });
			return { ok: true, value: undefined };
		},
		async removeEntry(key) {
			entries.delete(key);
			return { ok: true, value: undefined };
		},
	};
	state.cache = {
		async withExclusiveLock(operation) {
			return operation(locked);
		},
	};
	state.workspace = {
		async captureSetupInputs(paths) {
			const fingerprints: SetupInputFingerprint[] = [];
			for (const path of paths) {
				if (path !== "source.txt")
					return invalid("Unsupported setup input path");
				const fingerprint = fingerprintSetupInput(
					path,
					0o644,
					state.inputBytes,
				);
				if (fingerprint === null) return invalid("Invalid setup input fixture");
				fingerprints.push(fingerprint);
			}
			return { ok: true, value: fingerprints };
		},
		async captureOutputs(paths) {
			if (paths.length !== outputs.length || paths[0] !== outputs[0])
				return invalid("Unsupported setup output path");
			const bytes = encoder.encode(state.work);
			return {
				ok: true,
				value: [
					{
						path: outputs[0] as string,
						kind: "file",
						mode: 0o644,
						bytes,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				],
			};
		},
		async restoreOutputsCopyOnWrite(products) {
			const output = products.find((product) => product.path === outputs[0]);
			if (output === undefined || output.kind !== "file")
				return invalid("Cached setup output is unavailable");
			try {
				state.work = decoder.decode(output.bytes.slice());
				state.present = true;
				return { ok: true, value: undefined };
			} catch {
				return invalid("Cached setup output is not UTF-8");
			}
		},
	};
	return state;
}

function observe(state: State) {
	return {
		entryCount: state.entries.size,
		work: state.work,
		present: state.present,
		reused: state.reused,
		setupRuns: state.setupRuns,
		last: state.last,
	};
}

function treeIdentity(base: string): string {
	return createHash("sha1").update(`xspec-setup-base:${base}`).digest("hex");
}

function runInput(event: unknown): RunInput {
	const decoded = decodeSliceEvent(event);
	if (decoded.tag !== "Run" || decoded.value === undefined)
		fail("setup-cache slice accepts only Run and Mutate events");
	const value = decoded.value;
	exact(value, [
		"base",
		"variant",
		"tracked",
		"input",
		"enabled",
		"stable",
		"ok",
		"payload",
	]);
	return {
		base: stringField(value, "base"),
		variant: stringField(value, "variant"),
		tracked: booleanField(value, "tracked"),
		input: stringField(value, "input"),
		enabled: booleanField(value, "enabled"),
		stable: booleanField(value, "stable"),
		ok: booleanField(value, "ok"),
		payload: stringField(value, "payload"),
	};
}

async function applyRun(state: State, input: RunInput): Promise<void> {
	if (
		!/^[a-d]$/u.test(input.base) ||
		!["", "env1", "env2"].includes(input.variant) ||
		!["", "one", "two"].includes(input.input)
	)
		fail(
			`Run uses an identity outside the frozen diagnostic model: ${JSON.stringify(input)}`,
		);
	state.inputBytes = state.encoder.encode(input.input);
	state.inputFingerprints = input.tracked
		? [
				fingerprintSetupInput(
					"source.txt",
					0o644,
					state.inputBytes,
				) as SetupInputFingerprint,
			]
		: null;
	state.allowPublication = input.stable;
	state.present = false;
	state.reused = false;
	const check: CheckSpec = {
		name: "xspec-setup",
		argv: ["fixture-setup", ...(input.variant === "" ? [] : [input.variant])],
		timeoutMs: 1_000,
	};
	const outputs = input.enabled ? state.outputs : [];
	const keyInput: SetupCacheKeyInput = {
		baseTree: treeIdentity(input.base),
		setup: [check],
		setupOutputs: outputs,
		setupInputs: input.tracked ? ["source.txt"] : [],
		inputs: input.tracked ? state.inputFingerprints : null,
		childEnv: { XSPEC_VARIANT: input.variant },
		os: "xspec",
		arch: "xspec",
		elixir: "fixture",
		otp: "fixture",
	};
	const result = await runSetupWithCache<string>({
		cache: state.cache,
		workspace: state.workspace,
		keyInput,
		outputs,
		nowMs: () => state.now++,
		runSetup: async () => {
			state.setupRuns += 1;
			if (!input.ok) {
				state.work = "";
				state.present = false;
				return { ok: false, error: "fixture setup failed" };
			}
			state.work = input.payload;
			state.present = true;
			return { ok: true, value: { setupWallMs: 1 } };
		},
	});
	if (!result.ok) {
		state.work = "";
		state.present = false;
		state.reused = false;
		state.last = "failed";
		return;
	}
	state.reused = result.value.reused;
	state.present = true;
	state.last = result.value.reused ? "hit" : "miss";
}

export function createSetupCacheSlice(): XspecSlice {
	let state = emptyState();
	return {
		async reset() {
			state = emptyState();
			return observe(state);
		},
		async apply(event) {
			const decoded = decodeSliceEvent(event);
			if (decoded.tag === "Init") {
				if (decoded.value !== undefined) fail("Init accepts no value");
				state = emptyState();
				return observe(state);
			}
			if (decoded.tag === "Run") {
				await applyRun(state, runInput(event));
				return observe(state);
			}
			if (decoded.tag === "Mutate") {
				if (decoded.value === undefined)
					fail("Mutate requires its value object");
				exact(decoded.value, ["payload"]);
				if (!state.present) {
					state.last = "no_output";
					return observe(state);
				}
				state.work = stringField(decoded.value, "payload");
				state.last = "ok";
				return observe(state);
			}
			fail(`Unsupported setup-cache event ${decoded.tag}`);
		},
	};
}
