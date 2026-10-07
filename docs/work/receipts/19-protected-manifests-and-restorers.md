# Packet 19 — Protected manifests and restorers

**Status:** Implemented locally; awaiting B19 public wiring and black-box closure. This is not integration acceptance.

## Source and ownership

- Base SHA: `b6b8b407ad6a56b15b84276d9097dc1b3fd95fa2`
- Implementation commit: `b1f3d744ea545a3b3df4e3a99240c2c7468ee9ac` (`Implement protected manifests and restorers`). The receipt is a following documentation-only commit.
- Dependencies 12, 14, 16, and 18 are ancestors of the base.
- Contract inputs: v1.3-draft `e19dd1c`, frozen `CLI-RULE.txt`, and the read-only v1.2 conformance suite.
- Owned files:
  - `packages/core/src/gate/manifest.ts`
  - `packages/core/src/gate/protect.ts`
  - `packages/core/src/gate/scope.ts`
  - `tests/protection/protection-driver.c`
  - `tests/protection/protection.test.ts`
  - `docs/work/receipts/19-protected-manifests-and-restorers.md`
- Effort: approximately 15 active minutes, manually estimated. Runtime: GPT-6 Codex; exact serving variant, effort setting, and token count were unavailable.

## Behavior

- Builds the approved path-to-SHA-256 manifest from the saved origin base tree, using approved bytes for the Intent and acceptance source. Literal paths that name nothing retain the SHA-256 of `kogen:absent`. `changes_gate: true` excludes the effective gate files while retaining configured protected paths.
- Resolves effective gate program paths for Make, configured checks, acceptance checks, fix commands, and `acceptance.run`. Compiles the frozen glob forms, including `**`, character classes, alternatives, dotfiles, and trailing-slash subtrees. Unrepresentable base paths fail closed.
- Captures the worktree through the private Git snapshot and a no-follow filesystem walk. Stale checkout detection compares non-own protected paths to the saved base. The refusal helper returns the frozen protected-write message for exact manifest entries and paths selected by protected globs.
- Restores mismatches after a batch from approved/base bytes, removes absent paths, repairs parent and final symlink/type replacements through the anchored no-follow filesystem operations, and rechecks the result. The restore result signals `limitReached` on the fourth restored path so the caller can end the rung. `guardProtectedManifest` returns ordinary `protected/<path>` error findings for pre-verify/pre-commit callers.
- Scope warnings are deterministic advice from changed paths and declared domains; this helper does not affect gate status.

## Validation

- `bun --no-install test --max-concurrency 1 tests/protection`: **PASS**, 6 tests / 38 assertions. Covers base-derived manifest paths, effective gate programs, absent literals, `changes_gate`, stale checkout, write refusal, dynamic and ignored glob paths, hostile final/parent symlinks, file-to-directory replacement, external sentinel preservation, guard findings, scope advice, and the fourth-restore boundary.
- `bun --no-install node_modules/typescript/bin/tsc --noEmit`: **PASS**. Also passed in the final `make check` run.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: the first invocation found Biome import ordering; safe import fixes were applied. The final invocation exited 2: **310 passed / 1 skipped / 1 failed** across 312 tests (2,833 assertions). Formatting, TypeScript, shell, native compile, and the protection tests passed. The unrelated `tests/custody/supervise.test.ts` case `an escaped session is outside group custody and cannot hold output open forever` measured 507 ms and failed its `durationMs >= 600` assertion. The skip is the Linux namespace/mount test on this macOS host. No automatic retry was made.
- Exact B19 conformance command was run with `approval-14,approval-15,approval-16,v1.2-127-build-10,v1.2-44-build-09,v1.2-55-build-21` under profiles `cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`.

  Result: **6 cases / 6 instances; 0 pass, 0 fail, 6 harness errors, 0 skipped**. Every case stopped before launch with `FileNotFoundError` for `<repo>/dist/kogen`. Three Build rows explicitly report that no provider request reached the fake server; no provider requests reached it in this run, so unmatched requests were **not evaluated**, not zero unmatched. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-19-NDTyUP/results.jsonl`. The command was not retried.
- Replay hand cases / seeds 17, 23, and 41: not run; no replay slice applies to this packet. First divergence: not applicable.
- `git diff --cached --check`: **PASS** before implementation commit.

## Version and integration gaps

- `dist/kogen` and the public CLI are absent in this bootstrap. The six frozen cases could not reach their assertions; this does not demonstrate B19 parity. No incompatible historical assertion was reached or evaluated, and the frozen suite was not changed.
- The owned gate APIs are not connected to the public shaper write/edit path, post-batch tool loop, verify/commit transitions, or scope-warning journal. Those composition points belong to the coordinator. Missing wiring remains pending integration, not a pass.
- Tests ran on macOS 26.7.1 arm64. Linux filesystem/conformance behavior remains unverified; the Linux namespace/mount test skipped here. No v1.3 frozen executable suite exists, so no v1.3 public parity is claimed.

**Next owner:** I2/coordinator for shaper refusal, post-batch restore and fourth-restore transition, pre-verify/pre-commit guard, scope-warning journaling, and rerunning the exact B19 command after CLI wiring.
