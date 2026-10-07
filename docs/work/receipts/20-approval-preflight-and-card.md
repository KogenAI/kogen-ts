# 20 — Approval preflight and card receipt

**Status:** Implemented locally; awaiting public CLI integration and B20 acceptance. This is not integration acceptance or a v1.3 conformance claim.

## Source and effort

- Assigned base SHA: `5585601ad1be8cac5b8daa8e3cda92078399d5e8`.
- Implementation head SHA: `d8876e1e892951116213f473395ad8bbfba0ea4e` (`Align approval card with v1.3 format`). The receipt is a separate follow-up commit.
- Dependencies 14, 17, 18, 19, and 23 are present in the assigned base.
- Exact owned files changed:
  - `packages/core/src/approval/preflight.ts`
  - `packages/core/src/approval/card.ts`
  - `tests/approval-preflight/preflight.test.ts`
  - `docs/work/receipts/20-approval-preflight-and-card.md`
- Active effort: approximately 31 minutes, manually estimated; this session exposes no worker-time telemetry.
- Model: GPT-6 Codex. Serving variant, effort setting, and token count are not exposed by the runtime.
- Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0. Linux was not available for this packet.
- Target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen CLI command tree read from `spec-lock/kogen-spec/CLI-RULE.txt`.

## Behavior

- Approval hash is computed from the exact Intent bytes, one NUL byte, and the exact acceptance source bytes. A supplied prefix mismatch returns `intent/hash_mismatch` before scratch creation, cache access, setup, or checks.
- Checks use an isolated workspace at the resolved base commit and verify its initial tree against the resolved base tree. Setup runs first; configured baseline checks then run once in order. Baseline rows retain findings and classify red, unavailable, timeout, and mutation outcomes. Red baseline checks warn without blocking the card.
- The acceptance adapter stages the reviewed source into the candidate path. The staged bytes are compared with the hash-bound bytes before acceptance checks run. A red acceptance result refuses approval; an unavailable checker returns an environment error.
- Scratch is restored to its initial snapshot before removal on completed paths and refusals after snapshot acquisition. The checkout tree and source files are not used as the check workspace.
- The v3 baseline cache key includes the exact checked base tree, setup key, complete check commands/deadlines, child environment, toolchain, OS, architecture, and adapter version. Unknown identities disable reuse; cache entries separately carry and validate the checked tree.
- Cards include hash, approver, base, brief, acceptance labels, hash-matched shape warnings, and baseline warnings. The renderer follows the v1.3-draft §1.7.2 card and omits the historical `Feasibility: not checked` line.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun test tests/approval-preflight`: **PASS**, 10 tests / 60 expectations / 0 failures. Covers card rendering, hash-first refusal, exact-base scratch, setup/check ordering, red acceptance refusal and cleanup, setup refusal, unavailable acceptance, cache identity, shape warnings, and red baseline warnings.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**. Biome, TypeScript, shell, frozen-input and dispatcher checks, native compilation, and isolated tests passed; Bun reported 350 passed / 1 skipped / 0 failed across 351 tests (3,032 expectations). The skip is the real Linux mount case requiring Linux user namespaces and bubblewrap on this macOS host.
- Exact B20 command from the brief selected 13 cases and 13 instances: **0 passed, 0 assertion failures, 13 harness errors, 0 skipped**. Each stopped before CLI launch with `FileNotFoundError` for this worktree's missing `dist/kogen`. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-20-5pR1xZ/results.jsonl`. The exact selected cases were `approval-01,approval-03,approval-08,approval-09,approval-10,approval-11,approval-12,approval-13,approval-17,approval-19,approval-20,format-08,state-25`. No Kogen process or fake provider request ran; fake requests issued: **0**, unmatched fake requests: **not evaluated** because no process started.
- Static v1.2 incompatibilities with the v1.3 target: `cases/approval/approval-01-card-golden.json` expects the line `Feasibility: not checked`; `cases/format/format-08-card-warning-wording.json` makes the same expectation. v1.3-draft §1.7.2 omits that line, so the implementation follows v1.3. The harness errors prevented these assertions from being reached. The frozen suite was not edited or retried.
- Replay is not assigned to packet 20: hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.

## Pending integration and next owner

The bootstrap has no executable `dist/kogen` or public approval composition, and this packet provides the preflight/card ports rather than a production cache registration. The coordinator owns CLI composition and B20 rerun at I1; packet 46 owns persisted baseline cache integration. Linux acceptance remains pending. The v1.2 suite remains read-only and cannot establish v1.3 parity; a version-matched v1.3 oracle is still needed.
