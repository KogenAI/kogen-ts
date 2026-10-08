# 47 — Shape conversation loop and accounting

**Status:** Implemented locally; awaiting public Shape wiring and B47. This is not integration acceptance or a v1.3 conformance claim.

## Source and effort

- Assigned base SHA: `fdbf24acf656670845d92741e9083b4e4c9561a4`.
- Implementation commit: `20bdd3736808ab8be4d8e0d5a3ed5c474656bb80` (`Shape conversation loop and accounting`). The receipt is a separate follow-up commit.
- Dependencies 14, 17, 30, 31, 33, 34, and 46 are present in the assigned base. I2 is prepared for coordinator review, not accepted.
- Exact owned files changed:
  - `packages/core/src/shape/controller.ts`
  - `packages/core/src/shape/conversation.ts`
  - `packages/core/src/shape/counters.ts`
  - `tests/shape-loop/shape-loop.test.ts`
  - `docs/work/receipts/47-shape-conversation-loop-and-accounting.md`
- Active effort: approximately 40 minutes at close; the runtime does not expose an active-time timer. Model family: GPT-6 Codex. Serving variant, reasoning setting, and token usage are not exposed by the runtime.
- Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0. Linux was not available for this packet.
- Target: v1.3-draft `e19dd1c`; frozen CLI rules read from `spec-lock/kogen-spec/CLI-RULE.txt`.

## Behavior

- `runShape` keeps one primary `SessionState` across all shaper turns and validation repairs. It starts one fresh fallback context only when the primary turn or pass allowance is exhausted. A valid result on the last available turn or pass succeeds; fallback exhaustion exits 1. Provider and environment failures retain their exits and do not start fallback.
- Each conversation has 3 counted validation passes, 60 logical shaper turns, and 2 free style repairs. First HTTP dispatch charges a logical turn; retries and stream continuations count only as HTTP attempts. Finish guards spend turns but no pass. Fallback pass labels begin at 4, while recorded totals count actual counted traversals.
- Fallback is assigned `fallback_shaper` and resolves to the effective shaper role/provider/model/effort. It retains the static prefix and run cache affinity, uses a new thread, and preserves the original user item bytes, exact interrupted raw response items, continuation instruction, controller notes, and latest failure.
- Schema-1 `shape-accounting.json` is atomically written to the scratch directory on terminal success and failure. It records resolved roles, per-conversation allowances and pass labels, HTTP attempts including failed/partial attempts, auditor requests and usage separately, known token sums, unknown-usage attempts, outcome, and elapsed milliseconds.
- Mid-build review finding #6 (required shared-prefix cache breakpoint) has local Shape integration evidence: tests verify equal primary/fallback static-prefix hashes and stable cache affinity across the fresh fallback thread. I2 records the shared developer-item breakpoint and Shape/Build byte comparison; package 63 still owns live request/cache telemetry verification.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/shape-loop`: **PASS**, 10 tests / 101 expectations / 0 failures.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 569 tests / 4,425 expectations / 1 skip / 0 failures. The skip is the Linux real-mount test requiring user namespaces and bubblewrap; this host is macOS. Format, lint, TypeScript, shell, frozen-input, dispatcher, native compilation, and isolated tests passed.
- Exact B47 selection (`format-07,shape-01,shape-03,shape-04,shape-05,shape-06,shape-07,shape-08,shape-09,shape-10,shape-11,shape-12,shape-13,shape-23`): **0 pass, 0 assertion failures, 14 harness errors, 0 skips; 16 instances**. Every case failed before CLI launch with `FileNotFoundError` for the absent `dist/kogen`; no provider request reached the fake server. Fake provider requests issued: **0**; unmatched requests: **0 observed / not applicable because no Kogen process started**. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-47-eTpNjf/results.jsonl`. This is pending integration, not a B47 pass.
- The requested frozen v1.2 assertions were not weakened or edited. The selected fallback assertions in `shape-12` (fresh fallback at pass 4) and `shape-13` (six failing passes, exit 1) match the retained v1.3-draft 3+3 pass ladder; no specific incompatible assertion was established. Since the executable was absent, this run does not verify those assertions. The suite remains frozen v1.2 while the target is v1.3-draft, so it cannot establish v1.3 parity.
- Replay is not assigned to packet 47: hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.
- `git diff --check`: **PASS**.

## Pending integration and next owner

The bootstrap has no public `intent shape` composition or `dist/kogen` executable. The controller currently exposes injected validation and effect ports, so local reducer/controller tests do not prove public Shape wiring. Coordinator/I5 owns public Shape composition and executable production; rerun B47 after that wiring. I2 is still awaiting coordinator acceptance and is required as the merged integration receipt. Package 63 owns actual request-byte and cache telemetry evidence. Linux-specific validation remains open; no OS waiver is claimed.
