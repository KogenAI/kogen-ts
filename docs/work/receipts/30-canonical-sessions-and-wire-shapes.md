# Packet 30 — Canonical sessions and wire shapes

**Status:** Implemented locally; awaiting provider composition and B30 black-box closure. This is not integration acceptance.

## Source and ownership

- Base SHA: `196005c8f5e676afd8f0953517b7328d3598ff9d`
- Implementation commit after integration rebase: `118544e6e0a3a13ec11ea9c1bbc4169fead765c2`
- Dependencies are ancestors of the base: packet 12 `faf71abdbea676765614146f369852af239784e1`, packet 23 `6111327ac4af6c7605792e67f03b0f502903051b`, packet 29 `20d0778cc7a21ddf9e30dc37dfd9dd6d15beaea1`.
- Contract inputs: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`, frozen `CLI-RULE.txt`, and v1.2 suite `0f93bad988fb8d7a8eff4e94954d1db0a046c89d`.
- Owned implementation files:
  - `packages/core/src/provider/session/transition.ts`
  - `packages/core/src/provider/session/history.ts`
  - `packages/core/src/provider/session/wire.ts`
  - `packages/core/src/provider/session/keys.ts`
  - `packages/core/src/provider/session/prefix.ts`
  - `tests/session/session.test.ts`
  - `docs/work/receipts/30-canonical-sessions-and-wire-shapes.md`
- Initial implementation effort: approximately 11 active minutes plus 3 minutes of verification wait, manually estimated. The GPT-6 Codex runtime did not expose its specific model variant, effort setting, or token count.

## Behavior

- Derives stable opaque run affinity and `(run, stage, attempt, rung, epoch)` thread IDs. Model switches retain the thread; independent runs and conversation tuples receive distinct IDs. A caller can supply a previously selected affinity key for an evidenced shared-affinity policy. The prefix registry can be serialized and restored to detect changed bytes under an unchanged provider/model/adapter/prompt/schema version.
- Stores conversation history as copied raw JSON item bytes. Read access returns copies. Turn appends keep provider response items first, then function-call results, then user notes. Retries leave state untouched, so rebuilding a request produces the same body bytes.
- Encodes the complete canonical schema list and shared generic instructions before variable history, retains schemas for tool-less roles, and derives callable names from the selected role allowlist. `fallback_shaper` resolves to the shaper allowlist.
- Encodes `input` as the final body field. ChatGPT owned requests put complete schemas in a leading `additional_tools` item and omit top-level `tools`/`include`; injected requests send top-level schemas and encrypted-reasoning `include`. Sticky run/thread headers come from packet 29's routing context.
- On a model switch, drops encrypted reasoning items associated with the prior model while retaining other raw items. An accepted checkpoint changes the epoch/thread and keeps the approved request and plan bytes before the continuation item.

The session API exposes the identities and wire metadata needed by packet 23's request-attempt journal, but the public provider path is not composed yet. Nullable usage remains handled by packets 23 and 28.

## Validation

- `bun test --max-concurrency 1 tests/session`: **PASS**, 10 tests, 61 assertions. Covers stable run/thread IDs, three-turn raw-byte prefixes, identical retries, immutable history, owned/injected controls, role authorization, model-switch reasoning removal, cross-run Shape/Build prefix identity, registry restore/change detection, and checkpoint continuation.
- Final `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, Biome, TypeScript, shell syntax, native compilation, and 242 tests passed / 1 skipped / 0 failed across 243 tests (2,266 assertions). The one skip is the existing real Linux mount test, which requires Linux user namespaces and bubblewrap.
- One preceding full check had a 5-second timeout in the existing `tests/fs-read/read.test.ts` parent-link-swap race test. The isolated diagnostic `bun test --max-concurrency 1 --test-name-pattern 'parent link swaps never redirect' tests/fs-read/read.test.ts` passed in 3.1 seconds; the subsequent full check passed. No out-of-allowlist files were changed.
- Exact B30 conformance command was run with the brief's eight cases:

  `v1.2-03-consecutive-request-byte-prefix`, `v1.2-04-cache-key-session-headers`, `v1.2-05-missing-usage`, `v1.2-104-provider-01`, `v1.2-105-provider-02`, `v1.2-106-provider-03`, `v1.2-107-provider-04`, `v1.2-117-provider-20`.

  Result: **8 cases / 8 instances; 0 pass, 0 fail, 8 errors, 0 skipped**. Every instance stopped before launch with `FileNotFoundError` for `<repo>/dist/kogen`. The runner reported that no provider request reached the fake server; unmatched fake requests were **not evaluated**, not zero unmatched. The JSONL result is at `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-30-rxUIin/results.jsonl`.

## Version and integration gaps

- Exact old assertion conflict: `v1.2-104-provider-01`, selected request `r1_happy.edit`, checks `body.instructions` for `You are Kogen's builder.` The v1.3 target places role-specific developer instructions after the shared generic-instruction and full-schema prefix, in the leading input history. Moving that role-specific text into `instructions` before the schemas would conflict with the v1.3 prefix order. The old assertion was not dynamically reached because `dist/kogen` is missing; request a versioned oracle migration and do not treat this as an observed case failure.
- `spec/04-provider.md` §4.9.2 requires an explicit cache breakpoint for GPT-6/GPT-5.6, while the frozen v1.3 change notes leave serialization finding 8 open and do not freeze its wire representation. This packet keeps the static instruction/schema bytes stable but does not invent a breakpoint encoding. The coordinator must resolve that shared serialization contract before claiming complete v1.3 wire parity.
- `dist/kogen`, CLI/provider composition, and request-journal wiring are absent in this bootstrap. I2 must wire the real provider path and rerun the exact B30 command; missing public wiring is pending integration, not a reducer or wire-unit pass.
- Mandatory session replay belongs to packet 60. Hand cases run: 0. Seeds 17/23/41: not run. First divergence: not applicable.
- Tests ran on macOS 26.7.1 arm64. Linux execution is unverified; the make-check Linux mount case skipped on this macOS host. The frozen v1.2 suite has no v1.3 overlay for claiming target parity.

**Next owner:** I2 coordinator for provider composition, journal wiring, and B30 black-box rerun; packet 60 for mandatory session replay.

## Integration recheck after rebase — 8 October 2026

- Rebased implementation commit: `118544e6e0a3a13ec11ea9c1bbc4169fead765c2`; follow-up started from branch HEAD `9793f71eea392114bcbc267d7e0c543719b35321`, whose parent is the merged base `a86eb3dc886e0201b0b1da65a85248a225c0e2d7`. The packet brief's original base remains `196005c8f5e676afd8f0953517b7328d3598ff9d`.
- Re-ran `bun test --max-concurrency 1 tests/session`: **PASS**, 10 tests / 61 assertions.
- Re-ran `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 269 passed / 1 skipped / 0 failed across 270 tests (2,532 assertions). The skip remains the Linux-only mount test on macOS. In the failed integration run, `tests/fs-read/read.test.ts`'s parent-link-swap race exceeded its 5-second test limit; this run passed that case in 2.88 seconds. The failure was outside packet 30's allowlist and required no source edit.
- Re-ran the exact B30 command: **8 cases / 8 instances; 0 pass, 0 fail, 8 errors, 0 skipped**. All eight report `FileNotFoundError` for the absent `dist/kogen`; the runner confirms no provider request reached the fake server. Unmatched fake requests were **not evaluated**, not zero unmatched. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-30-QrUREK/results.jsonl`.
- Follow-up effort is approximately 8 active minutes plus 1 minute of verification wait, manually estimated; cumulative effort is approximately 19 active minutes plus 4 minutes of verification wait. Model: GPT-6 Codex; exact runtime variant, effort setting, and token count remain unavailable.
- Source edits in this follow-up: receipt only. No `fs-read` or other out-of-allowlist files were changed. Public provider wiring and the v1.2/v1.3 assertion conflict remain pending as described above.
