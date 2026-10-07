# Packet 18 — Checks, findings and gate feedback

## Status and source

**Status:** Implemented; awaiting production caller and integration acceptance.

- Base SHA: `f3e23a85b83e971250a4317fe75c3d6a7c7287ec`
- Implementation commit: `33ee3550e899a8b64f269ad348b5c2bc9d1d5598`
- Branch: `kts/18-checks-findings-and-gate-feedback`
- Target contract: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`
- Host: macOS 26.7.1 arm64; Git 2.54.0; Bun 1.4.2
- Active effort: approximately 40 minutes (estimate). Model: GPT-6 Codex; exact served variant and token count are not exposed by this worker interface.

## Owned files

- `packages/core/src/gate/checks.ts`
- `packages/core/src/gate/findings.ts`
- `packages/core/src/gate/verify.ts`
- `packages/core/src/gate/feedback.ts`
- `tests/gate/gate.test.ts`
- `docs/work/receipts/18-checks-findings-and-gate-feedback.md`

## Behavior

- Runs each configured fix once in order, captures each configured check once in order, then runs acceptance. Captured stdout and stderr are persisted separately as private run-directory logs; the complete parsed finding list is saved to `gate-findings-<run-id>.json`.
- Captures the post-fix tree as verification tree T. Checks and acceptance are compared with T; any mutations are restored and the restored tree identity is verified.
- Applies the frozen base-relative excuse predicate: matching non-green status, then either current finding identities are a subset of baseline identities when both sets are present, or exit statuses match when they are not. Finding identity is `(path, tool/rule, symbol)`; test failure names supply the symbol.
- Counts stable non-excused identities for repair progress and formats bounded feedback with 10 findings per tool, 20 total, 200-character messages, raw-log references, an eight-line/600-character tail, acceptance rows, base-red warnings, and the gate summary.

## Validation

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/gate/gate.test.ts` — **PASS**, 9 tests, 51 assertions. Covered test-symbol identity, unavailable on base/current, base-red mutating-check restoration, ordering, exact feedback, and acceptance item identities.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **final run PASS**, 288 passed, 1 Linux-only skip, 0 failed, 2,723 assertions across 289 tests and 32 files. Formatting, types, shell checks, frozen-input check, dispatcher check, and native compilation passed. An earlier run during the work timed out in the unrelated `tests/fs-read/read.test.ts` parent-link-swap case; the final run passed that case.
- Exact B18 batch — **not executable / pending integration**. The required command selected 11 cases and produced 0 pass, 0 assertion failures, 11 harness errors, 0 skips, 11 instances. Every JSONL error is `FileNotFoundError` for the absent `dist/kogen`, before CLI execution; result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-18-UYqgnR/results.jsonl`. No provider request reached the fake endpoint; unmatched fake requests: 0 because none were issued.
- Frozen v1.2 assertion conflicts: none identified by the local review. The selected v1.2 assertions did not execute because the public executable is absent, so this is not a conformance pass and no assertion outcome is claimed.
- Replay is not assigned to this packet: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.
- `git diff --cached --check` — **PASS** before the implementation commit.

## Pending integration and gaps

- The production Build caller is not wired to `verifyGate` and no `dist/kogen` executable exists in this bootstrap. Coordinator/integrator must bind the production `GateTreePort`, wire gate verification into the Build/check/acceptance path, build the public CLI, and rerun B18. Reducer tests alone do not satisfy B18.
- The available official case set is frozen v1.2 while the target authority is v1.3-draft; no v1.3 public conformance result is available.
- The Linux real-mount test was skipped on this macOS host because Linux user namespaces and bubblewrap are unavailable. Linux validation remains pending on a capable runner.
- Next owner: coordinator/integrator for public wiring and B18; Linux runner for the Linux platform check.
