# Packet 55 — Lite adapter and endpoint capability checks

Status: **IMPLEMENTED LOCALLY, AWAITING INTEGRATION ACCEPTANCE**

Base SHA: `3da7beee2f2eff4feba911143ea46931a86a7057`

Implementation head SHA: `e0d07ff01928206626e6566a69a096096f611988`

Branch: `kts/55-lite-adapter-and-endpoint-capability-checks`

Target: spec v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen conformance suite v1.2.

Dependencies packet 30 and packet 34 are merged ancestors of the base. Their session identity/wire and account/credential interfaces are used directly.

Active effort: approximately 25 minutes; about 2 minutes of unattended check wait excluded. Model: GPT-6 Codex; exact served model variant, effort setting, and token count are not exposed in this session.

Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0.

## Owned files

- `packages/core/src/provider/lite/adapter.ts`
- `packages/core/src/provider/lite/capabilities.ts`
- `tests/lite/lite.test.ts`
- `docs/work/receipts/55-lite-adapter-and-endpoint-capability-checks.md`

## Behavior

- Adds a Lite encoder for injected ChatGPT `gpt-6-luna` sessions. It leaves `instructions` empty, omits top-level `tools`, includes the full ordered schemas and deterministic leading item IDs in `input`, uses `reasoning.context: all_turns`, retains the encrypted-reasoning include, and keeps `input` as the final body field.
- Sends `x-openai-internal-codex-responses-lite: true`, the protocol ID in `session_id`, and the conversation ID in `thread-id`. The run affinity key remains in `prompt_cache_key`; Lite does not send the ordinary `session-id` affinity header. A new conversation changes the thread while affinity and protocol session ID remain stable.
- Rejects owned auth, non-Luna models, non-ChatGPT Lite, and Lite with a generation cap as `unsupported` with the frozen message. The Lite request helper validates and encodes before invoking its credential effect.
- Allows a generation cap on the canonical Responses endpoint or an endpoint with an explicit capability declaration scoped to that exact URL. Unknown endpoints and mismatched declarations reject with `Model-generation cap is unsupported on this endpoint/adapter.` before credential loading. It does not infer capability from an unknown endpoint name.

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/lite/lite.test.ts` — **PASS**, 4 tests, 54 assertions. Covers P6 Lite shape/schema/header order and IDs, identity stability, owned/non-Luna/cap refusal before credentials, and unknown/mismatched/explicit endpoint-cap fixtures.
- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/lite/lite.test.ts tests/session/session.test.ts` — **PASS**, 14 tests, 115 assertions.
- Required `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 349 passed, 1 skipped, 0 failed across 350 tests; 3,084 assertions. Biome, TypeScript, shell, frozen-input and dispatcher checks, native warning-as-error compilation, and isolated tests passed. The one skip is the real Linux mount case, which requires Linux user namespaces and bubblewrap; this run was on macOS.
- No directly owned standard B-set. The local acceptance used injected test effects only: 0 HTTP fake requests sent and 0 unmatched requests. No public conformance command was run because `dist/kogen` is absent; this is pending integration, not a pass.
- Replay hand cases: 0. Seeds 17/23/41: not run. First divergence: not applicable. `packages/xspec` has no source implementation at this base; packet 60 owns session replay. The local compatibility helper rejects unknown endpoint capabilities by default, but replay acceptance remains pending that wiring.

## Version and integration gaps

- Frozen v1.2 P6 pins the Lite `session_id` hash to `SHA256("kogen:responses:v1\0<run-directory>\0session")`. The merged packet 30 session API supplies the separate stable Lite protocol ID derived from `"kogen:responses:lite-session:v1\0<run-directory>"`. Draft v1.3 §4.9.1 requires a stable run-level Lite protocol ID distinct from cache affinity and thread identity, but does not pin its hash formula. Treat the frozen exact-hash assertion as a versioned suite conflict if enforced; the local fixture checks v1.3 identity separation and stability and does not change packet 30's key policy.
- Provider retry/composition still calls the Responses session encoder; it does not dispatch to this Lite encoder or the endpoint capability guard. `dist/kogen` is absent. The coordinator must wire capability preflight before credential loading and select the Lite adapter in the provider route before integrated acceptance.
- No other incompatible old assertion was identified. No v1.3 conformance claim is made.
- Linux behavior is unverified. The final `make check` skipped its Linux-only mount fixture on this macOS host.

Next owner: coordinator for provider route and capability-preflight wiring; packet 60 for session replay; suite owner for a versioned P6 Lite session-ID assertion.
