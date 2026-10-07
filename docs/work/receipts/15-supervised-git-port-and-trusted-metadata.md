# Packet 15 — Supervised Git port and trusted metadata

**Status:** Implemented; awaiting integration acceptance. The public `dist/kogen` command is not wired in this bootstrap.

## Source and ownership

- Base SHA: `c6c143ade697e586c3b4159e4fec98ff2df5108f`
- Implementation head: `e56052c` (`Implement supervised Git metadata port`)
- Exact packet files:
  - `packages/core/src/git/command.ts`
  - `packages/core/src/git/repository.ts`
  - `packages/core/src/git/identity.ts`
  - `tests/git-port/git-port.test.ts`
  - `docs/work/receipts/15-supervised-git-port-and-trusted-metadata.md` (this receipt)

## Changed behavior

Git commands now use explicit argv and copied stdin through the supervised process port, with per-call timeout, argv, stdin, and output caps. The runner starts from the allowlisted base environment and removes Git variables that redirect repository discovery, config, indexes, objects, templates, pagers, hooks, or tracing. It disables hooks, fsmonitor and external diff; commits add `--no-verify`; diff-family commands add `--no-textconv` and `--no-ext-diff`.

`createPrivateGitRepository` probes the source storage format and initializes a separate private metadata directory with the same SHA-1 or SHA-256 format. Worktree calls supply that private `--git-dir` and explicit `--work-tree`, so workspace `.git/config` and `.git/info/exclude` do not control Git. Private metadata uses an isolated identity and signing-off config; blob hashing uses `--no-filters`.

Public author identity is resolved separately with `git var GIT_AUTHOR_IDENT`. The public Git path retains the user global config and signing setup, while still clearing config redirection and suppressing hooks. The local signing-child test confirms that a hung configured signer is bounded by the process deadline.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/git-port` — **PASS**, 4 tests and 67 assertions. Covers SHA-1/SHA-256, limits and stdin, hostile workspace config (hooks, filter, fsmonitor, textconv, `info/exclude`), public identity/signing, and a hung signer.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 200 tests, 0 failures, 2,019 assertions across 19 files; formatting, lint, typecheck, shell syntax, native compilation and isolated tests all passed.
- Frozen case `v1.2-122-custody-09`, run with the exact brief command and its full profile selection — **HARNESS ERROR**, 1 case / 1 instance, 0 passed, 0 failed, 1 error, 0 skipped, 0 unimplemented. Python could not start `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/15-supervised-git-port-and-trusted-metadata/dist/kogen` (`FileNotFoundError`). No Kogen process or fake provider request ran; unmatched fake requests are not measurable. Result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-15-hGZXdU/results.jsonl`. This is pending wiring, not a pass. The official case was not retried.
- Replay: not owned by this packet; hand counts, seed traces and first-divergence report are not applicable.

## Effort and remaining closure

- Active effort: approximately 35 minutes; unattended check/test time excluded.
- Model: Codex GPT-6 agent; exact deployed variant was not exposed. Token usage was not exposed by the runtime.
- Host covered: macOS 26.7.1 arm64, Git 2.54.0. Linux acceptance remains pending.
- Version gap: the frozen case is the v1.2 replacement `v1.2-122-custody-09`; the authoritative target is spec v1.3-draft `e19dd1c`. No v1.3 B15 overlay is available, so this receipt makes no v1.3 conformance claim.
- Next owner: coordinator / I2 integration. Wire the public CLI to the supervised Git and process ports, then rerun B15 on supported hosts. The packet is not integration-accepted until the exact public case runs.
