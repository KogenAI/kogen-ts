# Packet 27 — SSE byte framing

## Source and ownership

- Base SHA: `1e5d4cd54c6adedf7a1578112742722448324d21`
- Implementation head SHA: `aff0c5dad87429a8e1f23475e5695a2a34d99419`
- Branch: `kts/27-sse-byte-framing`
- Exact owned files:
  - `packages/core/src/provider/sse/framing.ts`
  - `tests/sse-framing/framing.test.ts`
  - `docs/work/receipts/27-sse-byte-framing.md`
- Active effort: approximately 20 minutes. The runtime does not expose a precise active-time meter.
- Model/tokens: GPT-6 runtime; served variant and token count are not exposed by this worker interface.
- Host: macOS arm64, Darwin 25.6.0; Bun 1.4.2.

## Behavior

`SseFramer` consumes arbitrary `Uint8Array` chunks and emits completed `{ event, data }` frames. It incrementally decodes strict UTF-8, normalizes CRLF, CR, and LF boundaries across chunks, strips one leading space after a field colon, joins `data:` values with LF, and preserves an optional `event:` value as metadata. Comments and other fields do not contribute data. Empty data and exact `[DONE]` frames are skipped. `finish()` flushes a final unterminated line/frame. A single 16 MiB limit accounts for every body byte, including comments and ignored fields; malformed UTF-8 and excess bytes fail with typed framing errors.

## Validation

- Named local acceptance: `bun --no-install test --max-concurrency 1 ./tests/sse-framing` — **8 cases passed, 0 failed, 113 assertions**. The corpus checks every two-chunk split boundary, bytewise chunks, mixed line endings, comments, multiline data, `[DONE]`, empty data, EOF, split and invalid UTF-8, and the exact/over 16 MiB boundary.
- Required check: `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**. Biome, TypeScript, shell, frozen-input and dispatcher checks passed; all repository tests passed (**12 cases, 0 failed, 1,365 assertions**).
- The first local run exposed a fixture missing the blank line that terminates `[DONE]`; the fixture was corrected to follow the frozen frame boundary rule, then the named local suite passed. The first `make check` stopped on formatting/import ordering; the owned files were formatted and the complete required check then passed.
- Fake HTTP requests: none issued; unmatched requests: **0**.
- External conformance: no directly owned B-set; no external cases or instances run. B28 owns assembly behavior and its four provider cases.
- Replay: not owned or run in packet 27. Hand counts, seeds, and first divergence: **N/A**; stream replay belongs to packet 60.

## Pending integration

No public CLI or provider composition was changed. The bootstrap has no executable CLI, so public wiring remains pending integration and is not counted as a pass. Packet 28 is the next owner for Responses assembly and nullable usage; the coordinator owns composition. The implementation was checked on macOS arm64 only; Linux remains an integration/release gate. No packet-specific v1.2/v1.3 conflict was encountered.
