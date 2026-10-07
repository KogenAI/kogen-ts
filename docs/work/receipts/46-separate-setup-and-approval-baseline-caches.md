# 46 — Separate setup and approval-baseline caches

**Status:** Implemented locally; awaiting public cache wiring and B46 acceptance. This is not integration acceptance or a v1.3 conformance claim.

## Source and effort

- Assigned base SHA: `a96219d979333f86ea8b7864a6cad7ada64171bb`.
- Implementation head SHA: `f3da2901ef4b4ce9104d672d1e9e3179b9b5037b` (`Separate setup and approval baseline caches`). The receipt is a separate follow-up commit.
- Dependencies 04, 12, 16, 18, and 20 are present in the assigned base.
- Exact owned files changed:
  - `packages/core/src/cache/setup.ts`
  - `packages/core/src/cache/baseline.ts`
  - `packages/core/src/cache/keys.ts`
  - `tests/cache/setup.test.ts`
  - `tests/cache/baseline.test.ts`
  - `tests/cache/keys.test.ts`
  - `tests/cache/d2.test.ts`
  - `docs/work/receipts/46-separate-setup-and-approval-baseline-caches.md`
- Active effort telemetry: 805 seconds (~13 minutes 25 seconds) and 369,820 thread tokens when recorded. The runtime does not identify the serving variant or reasoning setting. Model family: GPT-6 Codex.
- Host: Darwin 25.6.0 arm64; Bun 1.4.2; Git 2.54.0. Linux was not available for this packet.
- Target: v1.3-draft `e19dd1c`; frozen CLI rules read from `spec-lock/kogen-spec/CLI-RULE.txt`.

## Behavior

- Setup cache keys use canonical byte-sorted identities for setup commands, declared outputs, relevant environment, platform/toolchain, and optional selected input files. With selected setup inputs, unrelated source-tree changes do not change the setup key. Unknown or unsafe identities disable reuse; old key versions miss.
- Setup products are canonical snapshots of path, mode, kind, and bytes/content hash. Restore uses the CoW port and validates the complete product and declared output set. Cache publication is an atomic complete-entry operation under a lock; LRU3 eviction is deterministic. Failed setup/publication and input instability cannot produce a hit. Selected inputs are checked before lookup and after setup/restore.
- Approval baseline rows use v3 identity `{v, checked_base_tree, setup_key, checks, child_env, toolchain, os, arch, adapter_version}`. The cache binds the checked base tree; unknown identity disables reuse and malformed or old entries miss. File persistence uses atomic replacement and restrictive mode.
- D2 tests show that an unchanged checked tree can reuse the baseline, while a source-only base-tree change preserves the setup key and reruns baseline checks. A cached red result is replaced after a successful rerun; a green baseline never excuses a failing current check.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/cache`: **PASS**, 15 tests / 94 expectations / 0 failures.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**. Biome, TypeScript, shell/frozen-input/dispatcher checks, native compilation, and isolated tests passed; Bun reported 389 passed / 1 skipped / 0 failed (3,304 expectations). The skip is the Linux real-mount case requiring user namespaces and bubblewrap; this host is macOS.
- Exact B46 command from the brief, selecting `state-28,v1.2-133-state-26,v1.2-134-state-27`: **0 passed, 0 assertion failures, 3 harness errors, 0 skipped; 3 instances**. Each failed before CLI launch with `FileNotFoundError` for the missing `dist/kogen`. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-46-oj8Zhs/results.jsonl`. No Kogen process or fake provider request ran; fake requests issued: **0**, unmatched fake requests: **not evaluated** because no process started. The official cases were not retried.
- Replay is not assigned to packet 46: hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.
- `git diff --check` and `git diff --cached --check`: **PASS**.

## Pending integration and next owner

The bootstrap has no executable `dist/kogen` or public CLI cache registration. The coordinator owns composition/wiring into public setup and approval flows and the B46 rerun after integration. Linux CoW/filesystem behavior remains unverified. The frozen suite is v1.2 while the target is v1.3-draft, so these checks do not establish v1.3 parity; a version-matched v1.3 oracle is still needed.
