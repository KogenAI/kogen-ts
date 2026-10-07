# Packet 33 — Retry, wait, and stream-continuation policy

**Status:** Implemented locally; awaiting public provider composition and B33 closure. This is not integration acceptance.

## Source and ownership

- Base SHA: `326225c8e46633dcfa93fdedae6281f11e2134f1`
- Tested implementation commits: `613e979` (`Implement provider retry and continuation policy`) and `b69fca2` (`Honor resolved disabled fallback policy`). Final tested source is at `b69fca2`.
- Dependencies are ancestors of the base: packet 28 `934e4592d8e110e1cf06e98cd57db860faf965c1`, packet 29 `20d0778cc7a21ddf9e30dc37dfd9dd6d15beaea1`, packet 30 `118544e6e0a3a13ec11ea9c1bbc4169fead765c2`.
- Contract inputs: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`, frozen `CLI-RULE.txt`, and v1.2 suite `v1.2+326225c`.
- Owned files:
  - `packages/core/src/provider/retry/transition.ts`
  - `packages/core/src/provider/retry/respond.ts`
  - `tests/retries/retry.test.ts`
  - `docs/work/receipts/33-retry-wait-and-stream-continuation-policy.md`
- Effort: approximately 30 active minutes plus 5 minutes of verification wait, manually estimated. Runtime: GPT-6 Codex; exact serving variant, effort setting, and token count were unavailable.

## Behavior

- Added one immutable `responses-v1.2` retry policy table retained by v1.3-draft §4.5: four-attempt default cap, 2/4/8/16/32/60-second ceilings, uniform half-ceiling-to-ceiling jitter, switch after two consecutive overloads, and 5-minute/24-hour Build pause limits.
- ChatGPT builder/context/reviewer switch immediately to their centrally resolved fallback after two consecutive overloads. Planner never switches; Grok never switches. When Build fallback is disabled for an eligible role, overload retries stay on the selected model for as long as the active Build budget can pay. Shape caps every transient request at four attempts; Build timeout/stall/transport retries remain bounded by active budget.
- Identical retries preserve the encoded request bytes when no response items arrived. Retryable partial streams append exact received item bytes and one continuation instruction to the same session. Partial function-call proposals are retained as history but are never returned as executable calls. A model switch uses the session transition that drops the prior model's encrypted reasoning.
- Login and usage-limit waits reserve a shared per-Build pause budget, use a fixed 5-minute wait, and do not consume active Build time. Exhausted policy paths return stopped provider results with exit code 4. Shape has no Build wait or total-wall budget.

## Validation

- `bun --no-install test --max-concurrency 1 tests/retries`: **PASS**, 17 tests / 74 assertions. Covers jitter bounds and budget fit, overload streak/switch/caps, disabled fallback, planner/Grok behavior, shared pause limits, Shape stops, byte-identical retries, partial continuation, and partial-call non-execution.
- Latest `GIT_CONFIG_GLOBAL=/dev/null make check` on final source: **FAIL**, 285 passed / 1 skipped / 1 failed across 287 tests (2,605 assertions). Formatting, TypeScript, shell, and native checks passed. The unrelated `tests/fs-read/read.test.ts` parent-link-swap race exceeded its 5-second timeout at 5000.53 ms. The immediately preceding full check passed with 286 passed / 1 skipped / 0 failed; it included all retry behavior except the final fallback inference adjustment. That same filesystem case passed there in 3907.97 ms. The skip is the real Linux-mount test, unavailable on this macOS 26.7.1 arm64 host. No out-of-allowlist files were changed.
- Exact B33 command was run with the brief's 14 cases: `cli-30`, `shape-24`, `shape-25`, `v1.2-103-ladder-35`, `v1.2-112-provider-11`, `v1.2-113-provider-12`, `v1.2-114-provider-14`, `v1.2-115-provider-17`, `v1.2-116-provider-18`, `v1.2-125-ladder-36`, `v1.2-28-provider-13-planner-no-fallback`, `v1.2-29-provider-15-idle-stall`, `v1.2-30-provider-16-total-cap`, and `v1.2-90-ladder-22`.

  Result: **14 cases / 14 instances; 0 pass, 0 fail, 14 harness errors, 0 skipped**. Each stopped before launch with `FileNotFoundError` for `<repo>/dist/kogen`. No fake provider request reached the server; unmatched fake requests were **not evaluated**, not zero unmatched. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-33-in8i1R/results.jsonl`. The official command was not retried.

## Version and integration gaps

- Exact incompatible historical assertions, superseded by the frozen v1.2 overlay: `provider-11` asserts `provider_wait.wait_ms = 30000` (the overlay requires `300000`); `provider-13` expects a planner switch from `gpt-6.1-sol/high` to `gpt-6.1-sol/medium` (the overlay requires four planner overload attempts and no switch); `provider-15` classifies the idle gap as `timeout` (the overlay says `stall`); `provider-16` expects an 800-second stream to hit the total cap (the overlay expects it to complete under the 20-minute cap); `provider-18` expects a `900000` ms usage wait (the overlay requires `300000`); `ladder-35` expects a `120000` ms wait (the overlay requires `300000`); and `ladder-36` expects `provider_switch` (the overlay requires four planner overload attempts, no switch, and a stopped queued Intent). These are historical version conflicts, not observed B33 failures. The selected B33 instances could not reach their assertions because `dist/kogen` is absent.
- The public CLI/provider composition and executable `dist/kogen` are not present in this bootstrap. The I2 coordinator must connect this reducer/effect loop to the real provider path and request journal, then rerun B33 and close public I2/I4/I5 cases. Missing wiring is pending integration, never a pass.
- v1.3-draft has no frozen executable conformance suite; no v1.3 parity is claimed. Tests ran on macOS 26.7.1 arm64; Linux execution remains unverified.
- Retry/session xspec hand cases run: 0. Seeds 17/23/41: not run. First divergence: not applicable. Packet 60 owns mandatory stream/session replay and full observations.

**Next owners:** I2 coordinator for public provider composition and B33 rerun; packet 60 for mandatory stream/session replay; suite owner for the future frozen v1.3 conformance release.
