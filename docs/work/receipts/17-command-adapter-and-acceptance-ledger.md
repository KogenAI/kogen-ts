# Packet 17 — Command adapter and acceptance ledger

## Status and source

**Status:** Implemented; awaiting production caller and integration acceptance.

- Base SHA: `2153210aed8d921e780aa378a0d802e68ccd5e84`
- Implementation commit: `83907440e44248da2b69a394ea62822d7c3036f6`
- Branch: `kts/17-command-adapter-and-acceptance-ledger`
- Target contract: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`
- Host: macOS 26.7.1 arm64; Git 2.54.0; Bun 1.4.2
- Active effort: approximately 25 minutes. Model: GPT-6 Codex; exact served variant and token count are not exposed by this worker interface.

## Owned files

- `packages/core/src/adapters/interface.ts`
- `packages/core/src/adapters/command.ts`
- `packages/core/src/gate/ledger.ts`
- `tests/ledger/ledger.test.ts`
- `docs/work/receipts/17-command-adapter-and-acceptance-ledger.md`

## Behavior

- Added a shared adapter contract for source and candidate paths, source-test staging, runner outcomes, raw logs, and adapter-specific unavailable detection.
- Added the command adapter with validated relative paths and argv, `{path}` expansion without a shell, explicit `KOGEN_LEDGER_REPORT` / `KOGEN_INTENT_SLUG`, timeout forwarding, and safe staging that refuses an occupied candidate path, checks the candidate source bytes, installs the approved bytes, and removes the workspace source copy.
- Added JSONL validation for exact row fields and statuses, strict UTF-8, item pass/fail derivation, unknown-tag and inconsistent-exit `suite` failures, and the `tool_missing`, `acceptance_compile_failed`, `no_tagged_tests`, `ledger_invalid`, `acceptance_timeout`, and `tree_mutated` classifications. Reports are cleared before invocation so stale rows cannot satisfy a later run. The caller supplies before/after tree snapshots; a changed identity fails the gate.

## Validation

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/ledger/ledger.test.ts` — **PASS**, 8 tests, 38 assertions, 0 failures. The fake process calls in the runner fixtures were consumed as expected; unmatched fake calls: **0**.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — an earlier run passed (279 passed, 1 Linux-only skip, 0 failed, 2,672 assertions) before the final UTF-8 ordering and absolute-workdir guard. The final-state run completed static checks and native compilation but **failed** in two unrelated existing tests: `tests/fs-read/read.test.ts` parent-link swap timed out at 5 seconds, and `tests/custody/supervise.test.ts` could not read `escaped-grandchild.pid` (ENOENT). Summary: 277 passed, 1 Linux-only skip, 2 failed, 1 error, 2,669 assertions. No owned source was implicated.
- Diagnostic reruns, kept separate from the full check: `tests/fs-read/read.test.ts` — 6 passed, 1 failed (the same 5-second parent-link-swap timeout); `tests/custody/supervise.test.ts` — 9 passed, 0 failed. No files outside the allowlist were changed.
- `git diff --check` — **PASS**.
- No directly owned standard B-set. B18/B20 production callers were not run; the brief assigns those exercises to later production wiring. No CLI executable exists at `dist/kogen`, so this is pending integration, not a conformance pass. B18/B20 observed cases: 0; instances: 0; unmatched fake requests: 0 (no CLI or provider request was made).
- Replay is not assigned to this packet: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.

## Pending integration and gaps

- Coordinator/integrator must wire the adapter and ledger to the production checks/approval callers and supply the real `snapshotWorkspace` tree identity before and after execution. Packet 18 owns check/gate callers; packet 20 owns approval preflight callers. B18/B20 remain open until those callers exercise the implementation.
- The Linux runner has not exercised this packet. The repository check's real Linux sandbox mount case was skipped on this macOS host because Linux user namespaces and bubblewrap are unavailable here.
- No v1.2/v1.3 assertion conflict was identified in this packet's local contract. No versioned v1.3 oracle is available for a public claim.
- Next owner: coordinator/integrator for caller wiring and B18/B20 integration; Linux runner for the Linux check.
