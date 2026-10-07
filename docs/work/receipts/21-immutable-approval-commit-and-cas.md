# 21 — Immutable approval commit and CAS receipt

**Status:** Implemented locally; awaiting CLI and xspec integration plus B21 black-box acceptance. This receipt is not integration acceptance or a v1.3 conformance claim.

## Source and effort

- Assigned base SHA: `6511b4f70c70bb3b4238cee9b7fdbb658286fe7f`.
- Implementation commits: `69ea5ea3e5996155e98e9847f8751f2c49f175d5` (`Implement immutable approval commits and CAS`) and `920e20bf16c74ae83c9525f3d3757d6719ff93a9` (`Bind approval commit to checked base tree`). Implementation head SHA: `920e20bf16c74ae83c9525f3d3757d6719ff93a9`.
- Dependencies 20 and 15 are present in the assigned base.
- Exact owned files changed:
  - `packages/core/src/approval/commit.ts`
  - `packages/core/src/approval/transition.ts`
  - `tests/approval-ref/commit.test.ts`
  - `docs/work/receipts/21-immutable-approval-commit-and-cas.md`
- Active effort: approximately 13 minutes, manually estimated; this session exposes no worker-time telemetry.
- Model: GPT-6 Codex. Serving variant, effort setting, and token count are not exposed by the runtime.
- Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0. Linux was not available for this packet.
- Target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen CLI command tree read from `spec-lock/kogen-spec/CLI-RULE.txt`.

## Behavior

- Added `commitApprovalPackage` as the effectful production approval transition, with public Git and anchored filesystem ports. It requires a successful exact-base preflight, snapshots the exact Intent and acceptance bytes, verifies their hashes and manifest entries, and re-reads both source files after commit construction immediately before each ref CAS.
- Builds a schema-2 approval record with target branch/base, Intent domains, acceptance path, protected manifest, recorded check baseline, witness or `null`, verbatim approver, and RFC 3339 time. The immutable package tree contains only `intent.md`, `approval.json`, optional `ledger.json`, and the acceptance source; every file is mode `100644`.
- Creates commits with the previous approval as the sole parent and the four normative `Kogen-*` trailers. It publishes with create/update `update-ref --no-deref` CAS and allows one retry after observing a changed ref. `approvalCasTransition` exposes that retry decision for replay adapters.
- Public Git calls retain user identity and signing configuration. Missing author identity returns exit 2 without creating a ref; an explicit `--by` value is stored verbatim.
- SHA-1 and SHA-256 repositories, exact CRLF/UTF-8 acceptance bytes, re-approval parent chains, late Intent/test mutation, and two concurrent approvers are covered locally.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 tests/approval-ref`: **PASS**, 9 tests / 47 expectations / 0 failures.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 372 passed / 1 expected Linux-only skip / 0 failed, 3,169 expectations across 373 tests and 43 files. Biome, TypeScript, shell, frozen-input, dispatcher, native compilation, and isolated tests passed.
- Exact B21 conformance command from the brief: **0 passed, 0 assertion failures, 9 harness errors, 0 skipped; 11 instances across 9 cases**. Every selected case stopped before CLI launch with `FileNotFoundError` because this worktree has no `dist/kogen`. The cases were `approval-02, approval-04, approval-05, approval-06, approval-07, state-08, state-09, state-29, v1.2-02-approval-hash-intent-and-test-bytes`. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-21-wCzLKR/results.jsonl`. Fake requests issued: **0**; unmatched requests: **not evaluated** because no CLI process started.
- Replay was not assigned to packet 21: hand cases **0**, seeds 17/23/41 not run, first divergence not applicable. The effectful transition is exported for the later xspec adapter; no xspec registry change was made.
- No exact incompatible v1.2 assertion was identified. The harness did not reach any assertions, so the selected historical cases remain unclassified against this implementation.

## Pending integration and next owner

This bootstrap has no executable `dist/kogen` or public approval command composition. The coordinator owns CLI composition and the B21 rerun at I1; packet 57 owns the xspec approval adapter. B21 is therefore **implemented locally, awaiting integration acceptance**, not green. A matching v1.3 conformance oracle and Linux acceptance are also pending.
