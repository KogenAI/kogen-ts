# Packet 38 — Public Build skeleton and planner

**Status:** Packet implementation committed locally. Public command integration
and acceptance remain pending at I2; this receipt does not claim integrated
acceptance.

## Behavior

- Added a Git-backed approval loader for the schema-2 approval ref. It verifies
  the approval commit, exact Intent and acceptance bytes, hashes and
  `Kogen-*` trailers before the controller can claim the run or request a
  model. Invalid or tampered approval returns `controller/approval_invalid`.
- Added the one-request Build planner boundary. It resolves the planner role
  centrally, sends no tools, accepts no fallback, bounds the tracked-file
  context, and validates the difficulty line, required headings/order, and plan
  length.
- Added the B0–B10 controller path with injected setup, base-acceptance, R1,
  and landing ports. It checks target branch and base, claims before side
  effects, emits run events, makes one plan, retries setup once, requires base
  acceptance before R1, persists landing preparation before publish, and
  finishes/releases the claim on terminal paths.
- Added a serialized Build run-state writer around each event append and
  snapshot update. The concurrency barrier regression verifies that a
  `cleanup_pending` update is retained when a terminal update follows, closing
  REVIEW-MIDBUILD finding #7 for Build controller writes.

## Revisions, ownership, and environment

- Base SHA: `79f3ef53e5852685a5c628404b38f5ffb5310179`.
- Implementation commit: `16b1e516e60a03756273ea23f8cbd9dee7708eaa`.
- The receipt is a follow-up commit; final worktree HEAD is reported in the
  worker handoff.
- Exact changed files:
  - `packages/core/src/build/controller.ts`
  - `packages/core/src/build/planner.ts`
  - `packages/core/src/build/load.ts`
  - `tests/build-entry/build-entry.test.ts`
  - `docs/work/receipts/38-public-build-skeleton-and-planner.md`
- Host: macOS 26.7.1 arm64, Bun 1.4.2, Git 2.54.0. Active time: approximately
  40 minutes by manual estimate; exact active-time counter is unavailable.
  Model: Codex runtime based on GPT-6; exact serving variant and effort are
  unavailable. Token usage is not exposed.

## Checks and named cases

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 481 passed, 1 skipped,
  0 failed (482 tests across 59 files, 3,777 expectations). The skipped case is
  the real Linux namespace/bubblewrap mount test on this macOS host.
- `bun test tests/build-entry/build-entry.test.ts`: **PASS**, 5 passed,
  0 failed, 25 expectations. Cases cover approval tampering before claim or
  planner request, the injected B0–B10 landing path and one planner request,
  repeated setup failure, missing base acceptance, and concurrent run-state
  updates.
- `git show --check HEAD`: **PASS** for the implementation commit.

## Frozen conformance command

The exact requested B38 command was run with profiles
`cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`, cases
`build-39,build-40,state-10,v1.2-126-state-15,v1.2-37-build-02,v1.2-38-build-03,v1.2-56-build-22,v1.2-57-build-23,v1.2-69-ladder-01`, `--jobs 3`, and
`--time-scale 0.02`.

Result: **0/9 cases passed, 0 assertion failures, 9 harness errors, 0 skips,
9 instances**. All stopped before execution because `dist/kogen` is absent in
this bootstrap worktree. The public Kogen process did not start and no model or
fake-server requests were sent; unmatched fake requests were **not evaluated**.
The JSONL is at
`/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-38-W328Dt/results.jsonl`.
No selected frozen assertion ran, so no incompatible old assertion was
identified or cleared.

## Replay

No Build Quint replay slice is assigned by this packet. No hand scenarios or
generated traces were replayed; seeds 17, 23, and 41 were not run. First
divergence is not evaluated. The injected Build-entry tests are not replay
evidence.

## Gaps and next owner

- The executable `dist/kogen` and public command binding are absent, so B38 and
  I2 acceptance remain pending. Coordinator owns the public composition and
  must rerun the exact conformance command after wiring; reducer/controller
  tests alone do not satisfy the public Build acceptance.
- I1 is recorded as prepared, not accepted, in `docs/work/receipts/I1.md`.
- Linux behavior remains unverified on this macOS host. The frozen suite is
  v1.2; this run did not reach its assertions and makes no v1.3 parity claim.
- Next owner: coordinator for I2 public Build command binding and integrated
  conformance.
