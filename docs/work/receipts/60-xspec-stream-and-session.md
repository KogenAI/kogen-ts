# Packet 60 — Xspec stream and session

**Status:** Slice implementation committed locally. Integrated acceptance remains
pending; the private executable is not registered in this bootstrap.

## Behavior

- Added the stream slice with its full observation and production retry/session
  transitions. It drives retry decisions with a fake monotonic clock and bounded
  random source, records the selected delays, models one forced credential
  refresh and pause outcomes, appends partial progress through the production
  session transition, and validates checkpoints with a continuation marker.
  Shape sends no Build wall budget.
- Added the session slice with all 15 observation fields. Identity, model switch,
  turns, repairs, checkpoints, and prefix registration use the production
  session APIs. Request bodies and sticky headers come from the production wire
  encoder. Run-scoped and shared affinity are carried across `NewRun` events.
- Added a provider test covering complete slice observations and a three-turn
  run through `respondWithRetry`: retry requests have identical body bytes and
  stable routing headers, appends preserve the raw input prefix, a model switch
  removes the prior Luna encrypted reasoning, Sol reasoning remains on the next
  turn, and known or nullable usage is retained.

## Revisions, ownership, and environment

- Base SHA: `cfc9340c898b15e2485461597eea41aa8ab45f2d`.
- Slice and test implementation commit: `e26d88c6ac3daafc81004d09da47f2bacbed13a8`.
- The receipt is the follow-up commit on that implementation; final worktree
  HEAD is reported in the worker handoff.
- Exact changed files:
  - `packages/xspec/src/slices/stream.ts`
  - `packages/xspec/src/slices/session.ts`
  - `tests/xspec-provider/stream-session.test.ts`
  - `docs/work/receipts/60-xspec-stream-and-session.md`
- Dependencies 30, 33, and 57 are present in the supplied base.
- Host: macOS 26.7.1, arm64. Active time: approximately 25 minutes (manual
  estimate; the runtime exposes no exact active-time counter). Model: Codex
  runtime based on GPT-6; exact serving variant and effort are unavailable.
  Token usage is not exposed.

## Checks and named cases

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 459 passed, 1 skipped,
  0 failed (460 tests, 3,692 expectations). The skipped case is the Linux
  namespace/bubblewrap mount test on macOS.
- `GIT_CONFIG_GLOBAL=/dev/null KOGEN_CREDENTIAL_STORE=file bun --no-install test --max-concurrency 1 tests/xspec-provider/stream-session.test.ts`:
  **PASS**, 4 passed, 0 failed, 39 expectations. Cases: complete stream
  observation after reducer transitions; complete session identity and
  run-affinity observations; stable shared affinity across consecutive unbound
  runs; and three-turn request bytes, headers, model switch, and nullable usage.
- No directly owned standard B-set applies.

## Quint replay

Pinned `@informalsystems/quint@0.33.0` dependencies were provisioned only in
private scratch copies. Frozen inputs were copied from
`spec-lock/kogen-spec/quint`; the bundle was not edited. Seed-separated copies,
generation output, and diagnostic logs are under
`/tmp/kogen-xspec-60.EiYaqF/seed-copies`; final session conformance logs are in
`/tmp/kogen-xspec-60.EiYaqF/post-affinity-fix`.

The required `spec` and `gen --traces 500 --steps 25` commands passed in all six
copies. Each generation produced 12,500 events and held the Quint invariant:

| Slice | Seed | Spec hand scenarios | Generated accepted/refused | Generator |
|---|---:|---:|---:|---|
| stream | 17 | 11/11 | 10,963 / 1,537 | PASS |
| stream | 23 | 11/11 | 10,960 / 1,540 | PASS |
| stream | 41 | 11/11 | 10,907 / 1,593 | PASS |
| session | 17 | 7/7 | 9,548 / 2,952 | PASS |
| session | 23 | 7/7 | 9,653 / 2,847 | PASS |
| session | 41 | 7/7 | 9,604 / 2,896 | PASS |

The exact conform commands were attempted for both slices and every seed:
`XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"`.
All six stopped before launching because `$ROOT/dist/kogen-xspec` is absent.
No public xspec case instance ran and no fake HTTP request reached a server;
unmatched fake requests were **not evaluated**, not zero.

For diagnostics only, the same generated traces were replayed through a private
adapter importing the slice modules directly. This does not replace executable
conformance:

| Slice | Seed | Hand | Generated | Total | First divergence |
|---|---:|---:|---:|---:|---|
| stream | 17 | 7/11 | 82/500 | 89/511 | Hand `01-switch-after-two-overloads`, step 3: expected overload streak 0 after switch; production reducer reports 2. First generated: `g0000`, step 5, incomplete outcome. |
| stream | 23 | 7/11 | 108/500 | 115/511 | Same hand divergence. First generated: `g0001`, step 6, production stops on overload at attempt 5 while the model retries at attempt 6. |
| stream | 41 | 7/11 | 87/500 | 94/511 | Same hand divergence. First generated: `g0000`, step 3, incomplete outcome. |
| session | 17 | 7/7 | 500/500 | 507/507 | None after shared-affinity correction. |
| session | 23 | 7/7 | 500/500 | 507/507 | None after shared-affinity correction. |
| session | 41 | 7/7 | 500/500 | 507/507 | None after shared-affinity correction. |

The stream model also disagrees with production on the hand attempt cap
(`03-attempt-cap-and-budget`, step 10: model stops at attempt 4; unbounded Build
retry proceeds to attempt 5) and on `09-incomplete-and-success` (model records
unfinished/idle with exit 0; production reducer stops with
`provider/incomplete`, exit 4). The generated divergence classes are dominated
by incomplete-result handling, overload streak observation, and attempt-cap
rules. The stream slice keeps the production reducer outcomes visible; it does
not rewrite observations to make the model appear to pass. The Quint stream
source comment cites v1.2 retry rules, while packet 33 implements the retry
policy used here. This is a recorded model/reducer conflict, not a v1.3 parity
claim.

## Gaps and next owner

- `packages/xspec/src/main.ts` and `protocol.ts` do not register stream/session;
  `dist/kogen-xspec` is absent. Coordinator owns registry and executable
  integration, then must rerun the exact conformance matrix. Missing wiring is
  pending integration, never a pass.
- Coordinator/spec owner must reconcile the stream Quint expectations with the
  production retry reducer under the frozen v1.3-draft authority before claiming
  integrated stream acceptance. The incompatible hand assertions above were
  not weakened.
- Linux replay and Linux-specific behavior remain unverified on this macOS
  host.
- The local outcome port is in-memory and makes no HTTP request. Because the
  exact executable never launched, fake-server unmatched-request counts remain
  unevaluated.
