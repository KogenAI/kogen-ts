# 08 — Linux confinement receipt

## Source and effort

- Base SHA: `c6c143ade697e586c3b4159e4fec98ff2df5108f`.
- Implementation commit/head SHA: `876494d4fe8f258aaa735ec03b363ea0345728a0`.
- Exact owned files changed:
  - `packages/core/src/sandbox/linux.ts`
  - `tests/sandbox-linux/linux.test.ts`
  - `docs/work/receipts/08-linux-confinement.md`
- Active effort: approximately 18 minutes; elapsed test wait was brief.
- Model: GPT-6; the runtime did not expose the deployment variant, effort label, or token count.
- Host: macOS 26.7.1 arm64, Bun 1.4.2, Git 2.54.0. No Linux VM/container runner or `bwrap` was available.
- Frozen target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.

## Behavior

- Added a Linux-only capability probe for bubblewrap and the user, PID, IPC, and UTS namespaces used by the plan. The probe includes a read-only root and bounded timeout/output. Network remains shared because no network namespace is created.
- Added a mount request builder with a read-only root, host `/tmp`, required read-only checkout and origin mounts, writable workspace/run/cache mounts, and masks for `~/.kogen/credentials*`, SSH/GnuPG/Codex data, keyrings, the user runtime directory, and `KOGEN_AUTH_PATH`.
- The sandbox drops all capabilities and disables nested user namespaces before running the requested command. It preserves the command environment, stdin, timeout, and output limit.
- Probe failures resolve to an explicit `unconfined` observation carrying the warning, `sandbox_unavailable` event, and report field. Disabled and already-confined calls remain unwrapped.

## Verification

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 ./tests/sandbox-linux` — 5 passed, 1 Linux-only real-mount test skipped on macOS, 0 failed; 41 expectations.
- Required check: `GIT_CONFIG_GLOBAL=/dev/null make check` — PASS; 201 passed, 1 Linux-only real-mount test skipped, 0 failed; 1,993 expectations. Formatting, lint, TypeScript, native compilation, and input-freeze checks passed.
- Exact B07 command was run with cases `v1.2-119-custody-06,v1.2-120-custody-07`. The suite found 2 cases / 2 instances, with 0 passes, 0 assertion failures, and 2 harness errors: `FileNotFoundError` for `dist/kogen`. No fake provider request reached the server; unmatched fake requests: 0. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-08-g38poP/results.jsonl`.
- The B07 run host was macOS. It is not Linux acceptance. Real Linux mount behavior and the Linux capability probe remain unverified; the local real-mount test is explicitly skipped unless Linux, bubblewrap, and namespace creation are available.
- Replay: not assigned to this packet; hand cases 0, seeds 17/23/41 not run, first divergence not applicable.
- No v1.2/v1.3 assertion conflict was assessed: both B07 cases errored before the CLI started.

## Pending integration

- Public CLI wiring and `dist/kogen` are absent at this base. The implementation is local and awaits coordinator integration; reducer/mount tests do not close B07.
- Next owner: coordinator at I2 for public Build wiring and a Linux runner for the required B07 recheck, mount test, and missing-user-namespace host test. Do not claim Linux parity until those run.

