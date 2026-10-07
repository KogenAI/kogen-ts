# Packet 28 — Responses assembly and nullable usage

## Source and ownership

- Base SHA: `83228217497682229a47ac96aacdf22ef9f323f6`
- Head SHA: `8e10ea08545ba64316e9542f9e415efc7633c0bc`
- Branch: `kts/28-responses-assembly-and-nullable-usage`
- Status: AWAITING_INTEGRATION
- Exact owned files:
  - `packages/core/src/provider/sse/assemble.ts`
  - `packages/core/src/provider/sse/usage.ts`
  - `tests/sse-assembly/assemble.test.ts`
  - `tests/sse-assembly/usage.test.ts`
  - `docs/work/receipts/28-responses-assembly-and-nullable-usage.md`
- Active effort: approximately 20 minutes; this worker interface does not expose a precise active-time meter.
- Model/tokens: GPT-6 runtime; served variant and token count are not exposed by this worker interface.
- Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0.

## Behavior

`assembleResponses` returns a discriminated success/failure result. A provider failure takes precedence over malformed content, malformed content takes precedence over a missing completion, and a second `response.completed` is malformed. It selects non-empty `response.completed.response.output` over streamed item events, otherwise preserves `response.output_item.done` items in arrival order. Raw item JSON slices are retained alongside parsed items for continuation history. Partial items remain available on failures, while failed and incomplete assemblies expose no executable tool calls.

Completed function calls require a non-empty `call_id` and `name`, with arguments supplied as an object or as a JSON string containing an object. Calls still marked `in_progress` remain raw items but are not returned for execution. Message `output_text` parts are concatenated in order. Usage remains nullable: missing counts are not converted to zero, uncached input is known only when both total and cached input counts are present, and negative, fractional, unsafe, structurally invalid or cached-greater-than-total counts are rejected.

## Validation

- Named local acceptance: `bun test --max-concurrency 1 tests/sse-assembly` — **15 passed, 0 failed, 67 assertions**.
- Required check: `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**; Biome, TypeScript, shell, frozen-input, dispatcher and repository tests passed (**27 tests, 0 failed, 1,432 assertions**).
- Exact B28 conformance command selected `v1.2-108-provider-06`, `v1.2-109-provider-07`, `v1.2-110-provider-08`, and `v1.2-111-provider-09` — **4 cases / 4 instances; 0 pass, 0 fail, 4 harness errors**. Each errored before execution because `dist/kogen` does not exist. No request reached the fake provider; unmatched requests: **0** (no fake request was issued).
- No B28-specific v1.2/v1.3 assertion conflict is known. The old-case scripts did not execute, so the local tests do not establish public-path conformance.
- Replay hand cases/seeds: not assigned to packet 28.

## Pending integration

There is no executable CLI/provider composition in this bootstrap. The reducers and local tests are implemented, but B28 remains **awaiting integration acceptance** until the public provider path is wired and the four named cases run with no unmatched fake requests. Next owner: coordinator during provider composition/I2; packet 29 can consume the assembly interface. Only macOS arm64 was checked; Linux remains unverified.

The packet 27 implementation commit `aff0c5dad87429a8e1f23475e5695a2a34d99419` is present in this base and in `main`. The read-only dispatcher still labels packet 27 `UNVERIFIED_RECEIPT`, because its receipt does not use the dispatcher's `Status:` / `Head SHA:` fields; it consequently lists packet 28 as blocked on merged receipt 27. The coordinator should reconcile packet 27's receipt status before treating this packet as dispatch-ready.
