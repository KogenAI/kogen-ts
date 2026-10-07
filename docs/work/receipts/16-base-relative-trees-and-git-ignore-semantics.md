# Packet 16 — Base-relative trees and Git ignore semantics

## Status and source

**Status:** Implemented; awaiting integration acceptance. The frozen public cases could not start because this bootstrap has no `dist/kogen` executable.

- Base SHA: `e7c2d1d65d857213694eddff0ae8ef01a32b6185`
- Implementation source SHA: `57f388ced810fee9903447d3cdb3f341bbebd138` (`Implement base-relative workspace snapshots`, rebased)
- Rebased pre-receipt HEAD used for integration recheck: `83f8a2b086b1a890eb687d3e0a635248c0e385d0`
- Branch: `kts/16-base-relative-trees-and-git-ignore-semantics`
- Dependencies 03, 04, and 15 are source ancestors of the base.
- Host: macOS 26.7.1 arm64; Git 2.54.0; Bun 1.4.2.
- Active effort: approximately 24 minutes including the integration recheck. Model: GPT-6 Codex; exact served variant and token count are not exposed by this worker interface.

## Owned files

- `packages/core/src/workspace/clone.ts`
- `packages/core/src/workspace/ignore.ts`
- `packages/core/src/workspace/snapshot.ts`
- `tests/workspace/workspace-driver.c`
- `tests/workspace/workspace.test.ts`
- `docs/work/receipts/16-base-relative-trees-and-git-ignore-semantics.md`

## Behavior

- `cloneFreshWorkspace` makes a fresh local clone with `--no-hardlinks`, fetches and checks out the saved full base object ID detached, and confirms SHA-1 or SHA-256 format and HEAD.
- `snapshotWorkspace` uses the saved base commit to reset a controller-owned private index before adding worktree changes. It never derives the base from builder HEAD or index. Git scans the worktree with its native nested `.gitignore` and negation rules. The private metadata directory keeps workspace `.git/config` and `.git/info/exclude` out of ignore, filter, hook, fsmonitor, and index decisions.
- Snapshot entries are parsed from NUL-framed `git ls-files --stage -z` output as raw path bytes, modes, object IDs, and stages. Regular file blobs are rehashed with `--no-filters`; bounded host reads cover ordinary files and trusted Git path hashing covers large regular files. Git preserves symlink target blobs. The resulting tree and changed paths retain executable mode, symlink, rename, and deletion state.
- `checkGitIgnore` exposes byte-preserving ignore decisions through trusted `git check-ignore --no-index -z --stdin`. Its `--no-index` result is independent of tracking state; the snapshot index seeded from the saved base retains tracked ignored paths while omitting untracked ignored paths.

## Validation

- Named local acceptance: `bun --no-install test --max-concurrency 1 ./tests/workspace/workspace.test.ts` — **PASS**, 2 tests, 0 failures, 102 assertions. Covers SHA-1/SHA-256 local clones and no shared object inodes; moved builder HEAD and builder index; tracked-ignored retention, untracked-ignored omission, nested negation; hostile workspace config and exclude files; raw bytes and a 1 MB blob; executable modes, symlinks, rename, and deletion.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 212 passed, 1 skipped, 0 failed, 2,216 assertions. Biome, TypeScript, shell, frozen-input and dispatcher checks, warning-as-error native compilation, and isolated tests passed. The one skip requires Linux user namespaces and bubblewrap; this host is macOS.
- Exact B16 conformance command from the brief — **HARNESS ERROR**, 2 cases / 2 instances, 0 passed, 0 failed, 2 errors, 0 skipped. Both `v1.2-123-custody-10` and `v1.2-64-build-30` failed to start with `FileNotFoundError` for `<root>/dist/kogen`. No Kogen process or fake-provider request ran; unmatched fake requests: **0**. Result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-16-95CHxH/results.jsonl`.
- Replay is not assigned to packet 16: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.
- `git diff --check` and staged `git diff --cached --check` — **PASS**.

## Rebased integration recheck

- The integration log's first `GIT_CONFIG_GLOBAL=/dev/null make check` failed in the out-of-scope `tests/host-bridge/host.test.ts` case `SIGKILL of the Kogen parent closes control EOF and kills the child group`. The test waits for `parent-report.json` to exist and then parses it; the observed JSON parser error was `Unexpected EOF` at line 241, consistent with a create/write timing race. Packet 16 does not own the host-bridge test, driver, or native helper, so no out-of-scope file was changed.
- Re-running `GIT_CONFIG_GLOBAL=/dev/null make check` at `83f8a2b086b1a890eb687d3e0a635248c0e385d0` — **PASS**, 261 passed, 1 Linux-only skip, 0 failed, 2,573 assertions. The host-bridge case passed in this run.
- Re-running the named workspace command, `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/workspace/workspace.test.ts` — **PASS**, 2 tests, 102 assertions.
- Exact B16 conformance command — **HARNESS ERROR**, 2 cases / 2 instances, 0 passed, 0 failed, 2 errors, 0 skipped. Both cases failed to start with `FileNotFoundError` because `dist/kogen` is absent. No Kogen process or fake-provider request ran; unmatched fake requests: **0**. Result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-16-90OK0L/results.jsonl`.
- This recheck used the rebased workspace implementation unchanged. The transient check failure did not recur; the B16 public cases remain pending integration because the CLI executable is not wired.
- Replay is not assigned to packet 16: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.
- No v1.2/v1.3 assertion conflict was identified in the two case definitions. Their execution remains unverified because the CLI executable is absent.
- Next owner: coordinator/integrator for filesystem registration and public Build composition; Linux runner for Linux path-byte and workspace validation.

## Pending integration and gaps

- Coordinator/integrator must register the safe filesystem host operation and wire the workspace modules into the real Build/public CLI. The owned tests call the filesystem request handler directly and use a local ProcessPort fixture; they do not prove public Build wiring. B16 remains awaiting I2 integration and the exact two public cases must be run after `dist/kogen` exists.
- Validation was on macOS only. The APFS fixture could not create an invalid-UTF-8 filename (`EILSEQ`), so raw invalid-byte path handling remains unverified on Linux. An oversized non-UTF-8 filename containing a newline cannot use Git's newline-delimited `--stdin-paths` fallback and returns a bounded error.
- No v1.2/v1.3 assertion conflict was identified in the two case definitions. Their execution remains unverified because the CLI executable was absent.
- Next owner: coordinator/integrator for filesystem registration and public Build composition; Linux runner owner for Linux path-byte and workspace validation.
