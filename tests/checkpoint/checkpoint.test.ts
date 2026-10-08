import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	acceptBuildCheckpointItem,
	BUILD_CONTEXT_CONTINUATION_MARKER,
	BUILD_CONTEXT_MINIMUM_BYTES,
	type BuildCheckpointRetainedState,
	buildCheckpointIsDue,
	checkpointBuildContext,
	serializedBuildHistoryBytes,
} from "../../packages/core/src/build/checkpoint";
import type {
	BuildDeveloperPort,
	BuildDeveloperTurn,
} from "../../packages/core/src/build/develop";
import { createBuilderSession } from "../../packages/core/src/build/develop";
import { resolveRoles } from "../../packages/core/src/project/roles";
import { userMessageBytes } from "../../packages/core/src/provider/session/history";
import { canonicalJsonBytes } from "../../packages/core/src/provider/session/prefix";
import {
	type SessionState,
	stepSession,
} from "../../packages/core/src/provider/session/transition";
import { encodeSessionRequest } from "../../packages/core/src/provider/session/wire";

const encoder = new TextEncoder();
const CONTEXT_BYTES = BUILD_CONTEXT_MINIMUM_BYTES;
const rolesResult = resolveRoles({ provider: "chatgpt" });
const roles = rolesResult.ok
	? rolesResult.value
	: (() => {
			throw new Error("Test roles should resolve.");
		})();

function session(): SessionState {
	return createBuilderSession({
		runDirectory: "/tmp/kogen-checkpoint-run",
		provider: "chatgpt",
		role: roles.roles.builder,
		authMode: "injected",
		recipe: "ladder",
		attempt: "builder",
		rung: "R1",
		promptVersion: "build-prompt-v1",
		adapterVersion: "responses-v1",
		intentBytes: encoder.encode("---\ntitle: Demo\n---\nApproved request.\n"),
		acceptance: [],
		plan: "Preserve this plan verbatim.",
		repairsLeft: 6,
	});
}

function largeSession(base = session()): SessionState {
	return stepSession(base, {
		type: "append_items",
		items: [
			{
				bytes: userMessageBytes(`Earlier work.\n${"x".repeat(CONTEXT_BYTES)}`),
				kind: "user_note",
			},
		],
	});
}

function retained(): BuildCheckpointRetainedState<
	{ readonly intentBytes: Uint8Array; readonly acceptanceBytes: Uint8Array },
	{ readonly text: string },
	{ readonly id: string; readonly root: string },
	{
		readonly turnLimit: number;
		readonly wallMilliseconds: number;
		readonly repairCount: number;
		readonly repairLimit: number;
	}
> {
	return Object.freeze({
		approval: Object.freeze({
			intentBytes: encoder.encode("approved bytes"),
			acceptanceBytes: encoder.encode("acceptance bytes"),
		}),
		plan: Object.freeze({ text: "original plan" }),
		workspace: Object.freeze({ id: "R1", root: "/tmp/worktree" }),
		caps: Object.freeze({
			turnLimit: 60,
			wallMilliseconds: 1_800_000,
			repairCount: 2,
			repairLimit: 6,
		}),
		turnsUsed: 11,
		continuations: 2,
	});
}

function completedTurn(
	summarizerSession: SessionState,
	text: string,
	options: {
		readonly rawItemJson?: string;
		readonly toolCalls?: readonly {
			readonly id: string;
			readonly name: string;
			readonly arguments: Record<string, unknown>;
		}[];
	} = {},
): BuildDeveloperTurn {
	const item = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
		status: "completed",
	};
	return {
		kind: "completed",
		response: {
			ok: true,
			id: "response_checkpoint",
			text,
			tool_calls: options.toolCalls ?? [],
			usage: null,
			raw_items: [item],
			raw_item_json: [options.rawItemJson ?? JSON.stringify(item)],
		},
		session: summarizerSession,
		attempts: 1,
	};
}

function fakeDeveloper(
	complete: BuildDeveloperPort["complete"],
): Pick<BuildDeveloperPort, "complete"> {
	return { complete };
}

function dueRequest(
	current: SessionState,
	developer: Pick<BuildDeveloperPort, "complete">,
	options: { readonly contextBytes?: number } = {},
) {
	return {
		session: current,
		retained: retained(),
		contextBytes: options.contextBytes ?? CONTEXT_BYTES,
		turn: 12,
		remainingBuildBudgetMilliseconds: 91_000,
		remainingRungWallMilliseconds: 22_000,
		developer,
	};
}

test("P13: context_bytes is opt-in and uses serialized history bytes", () => {
	const initial = session();
	expect(serializedBuildHistoryBytes(initial)).toBeLessThan(CONTEXT_BYTES);
	expect(buildCheckpointIsDue(initial, undefined)).toBe(false);
	expect(buildCheckpointIsDue(initial, CONTEXT_BYTES)).toBe(false);

	const atLimit = stepSession(initial, {
		type: "append_items",
		items: [
			{
				bytes: userMessageBytes("x".repeat(CONTEXT_BYTES)),
				kind: "user_note",
			},
		],
	});
	expect(serializedBuildHistoryBytes(atLimit)).toBeGreaterThanOrEqual(
		CONTEXT_BYTES,
	);
	expect(buildCheckpointIsDue(atLimit, CONTEXT_BYTES)).toBe(true);
	expect(() => buildCheckpointIsDue(initial, CONTEXT_BYTES - 1)).toThrow(
		"at least 16000",
	);
});

test("P13: same builder summarizes with no tools, then keeps approval, plan, workspace, and caps", async () => {
	const original = largeSession();
	const originalItems = original.continuationBase.snapshotItems();
	const priorThread = original.threadId;
	const retainedState = retained();
	let calls = 0;
	const developer = fakeDeveloper(async (input) => {
		calls += 1;
		expect(input.turn).toBe(12);
		expect(input.remainingBuildBudgetMilliseconds).toBe(91_000);
		expect(input.remainingRungWallMilliseconds).toBe(22_000);
		expect(input.session.role).toBe("builder");
		expect(input.session.effectiveRole).toBe("builder");
		expect(input.session.model).toBe(original.model);
		expect(input.session.effort).toBe(original.effort);
		expect(input.session.epoch).toBe("checkpoint-12");
		expect(input.session.authorizedTools).toEqual([]);
		expect(input.session.cacheKey).toBe(original.cacheKey);
		expect(input.session.threadId).not.toBe(priorThread);
		expect(input.session.prefix.sha256).toBe(original.prefix.sha256);
		expect(input.session.continuationBase.snapshotItems()).toEqual(
			originalItems,
		);
		const encoded = encodeSessionRequest(input.session);
		const wire = JSON.parse(new TextDecoder().decode(encoded.body)) as {
			tool_choice: unknown;
			prompt_cache_key: string;
			tools: readonly unknown[];
		};
		expect(wire.tool_choice).toBe("none");
		expect(wire.prompt_cache_key).toBe(original.cacheKey);
		expect(wire.tools.length).toBeGreaterThan(0);
		expect(encoded.headers["session-id"]).toBe(original.cacheKey);
		expect(encoded.headers["thread-id"]).toBe(input.session.threadId);
		return completedTurn(
			input.session,
			"Keep the approved goal and unfinished work.",
		);
	});

	const result = await checkpointBuildContext({
		...dueRequest(original, developer),
		retained: retainedState,
	});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	const outcome = result.value;
	expect(outcome.kind).toBe("accepted");
	if (outcome.kind !== "accepted") return;
	expect(calls).toBe(1);
	expect(outcome.attempts).toBe(1);
	expect(outcome.consumedTurns).toBe(1);
	expect(outcome.nextTurn).toBe(13);
	expect(outcome.retained.approval).toBe(retainedState.approval);
	expect(outcome.retained.plan).toBe(retainedState.plan);
	expect(outcome.retained.workspace).toBe(retainedState.workspace);
	expect(outcome.retained.caps).toBe(retainedState.caps);
	expect(outcome.retained.turnsUsed).toBe(12);
	expect(outcome.retained.caps.turnLimit).toBe(60);
	expect(outcome.retained.caps.repairCount).toBe(2);
	expect(outcome.retained.continuations).toBe(3);
	expect(outcome.session.cacheKey).toBe(original.cacheKey);
	expect(outcome.session.protocolSessionId).toBe(original.protocolSessionId);
	expect(outcome.session.threadId).not.toBe(priorThread);
	expect(outcome.session.epoch).toBe(
		createHash("sha256")
			.update(
				canonicalJsonBytes(
					JSON.parse(new TextDecoder().decode(outcome.checkpointItem.bytes)),
				),
			)
			.digest("hex"),
	);
	const compacted = outcome.session.history.itemBytes();
	expect(compacted).toHaveLength(originalItems.length + 1);
	for (const [index, item] of originalItems.entries())
		expect(compacted[index]).toEqual(item.bytes);
	const checkpoint = JSON.parse(
		new TextDecoder().decode(compacted[compacted.length - 1]),
	) as { content: readonly { text: string }[] };
	expect(checkpoint.content[0]?.text).toStartWith(
		BUILD_CONTEXT_CONTINUATION_MARKER,
	);
	expect(serializedBuildHistoryBytes(outcome.session)).toBeLessThanOrEqual(
		CONTEXT_BYTES,
	);
});

test("P13: corrupt, empty, and oversized summaries stop without accepting a new epoch", async () => {
	const cases = [
		{
			name: "corrupt response item",
			text: "A usable looking summary",
			options: { rawItemJson: "{broken" },
		},
		{
			name: "empty summary",
			text: " \n\t",
			options: {},
		},
		{
			name: "oversized compacted history",
			text: "x".repeat(CONTEXT_BYTES),
			options: {},
		},
	];
	for (const testCase of cases) {
		const original = largeSession();
		const retainedState = retained();
		const result = await checkpointBuildContext({
			...dueRequest(
				original,
				fakeDeveloper(async ({ session: summarizerSession }) =>
					completedTurn(summarizerSession, testCase.text, testCase.options),
				),
			),
			retained: retainedState,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.kind).toBe("continuation_failed");
		if (result.value.kind !== "continuation_failed") continue;
		expect(result.value.session).toBe(original);
		expect(result.value.retained.approval).toBe(retainedState.approval);
		expect(result.value.retained.caps).toBe(retainedState.caps);
		expect(result.value.retained.turnsUsed).toBe(12);
		expect(result.value.retained.continuations).toBe(2);
		expect(result.value.consumedTurns).toBe(1);
		expect(result.value.nextTurn).toBe(13);
	}
});

test("P13: malformed continuation markers are refused and omitted config sends no request", async () => {
	const original = largeSession();
	const invalid = {
		bytes: encoder.encode(
			JSON.stringify({
				role: "user",
				content: [{ type: "input_text", text: "Not a continuation." }],
			}),
		),
		kind: "user_note" as const,
	};
	expect(
		acceptBuildCheckpointItem(original, 12, invalid, CONTEXT_BYTES),
	).toBeNull();

	let calls = 0;
	const disabled = await checkpointBuildContext({
		session: original,
		retained: retained(),
		turn: 12,
		remainingBuildBudgetMilliseconds: 91_000,
		remainingRungWallMilliseconds: 22_000,
		developer: fakeDeveloper(async () => {
			calls += 1;
			throw new Error("disabled checkpoint must not call the provider");
		}),
	});
	expect(disabled).toMatchObject({ ok: true, value: { kind: "disabled" } });
	expect(calls).toBe(0);
});
