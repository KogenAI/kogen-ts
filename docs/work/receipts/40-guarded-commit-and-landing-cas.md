# B40 — Guarded commit and landing CAS

## Revision and scope

- Base SHA: `1ec5fe7bd108408fe935f94fef4a001c244b2781`
- Tested implementation HEAD: `38eceb7263badfad217555ce09fdc820629c277a`
- Spec authority: v1.3-draft `e19dd1c`; frozen conformance suite: v1.2.
- Active time: approximately 25 minutes (estimate; no authoritative session timer was available; within the 90-minute limit).
- Model: GPT-6-based Codex; exact serving variant and token telemetry are not exposed in this session.

## Changed behavior

The landing commit is created from the verified tree with exactly the expected sole parent and normative title/`Kogen-Intent` message. It uses the public Git identity and signing configuration, requests `-S` when public `commit.gpgsign` is enabled, and bypasses hooks. A missing tree is transferred from the private metadata repository through a temporary ref.

Publication durably appends `commit_result`, then persists `landing_prepared` and `run.json.landing` before publishing `refs/kogen/incoming/<run_id>` and compare-and-swapping the target branch from the expected parent. SHA-1 and SHA-256 object formats are checked. Clean checkouts are updated with a race-safe Git tree operation; dirty or raced checkouts retain their edits and receive the specified warning. Incoming-ref cleanup failure remains landed, records `cleanup_failure`, and marks cleanup pending.

## Exact owned files

- `packages/core/src/build/landing/transition.ts`
- `packages/core/src/build/landing/commit.ts`
- `packages/core/src/build/landing/publish.ts`
- `packages/core/src/build/landing/sync.ts`
- `tests/landing-cas/landing.test.ts`
- `docs/work/receipts/40-guarded-commit-and-landing-cas.md`

## Checks

- `bun test tests/landing-cas`: **10 passed, 0 failed, 87 expectations**. Covers SHA-1 and SHA-256 sole-parent/tree/message checks, public identity and signing configuration, durable record ordering, SHA-256 crash points, checkout race preservation, lock refusal, and nonfatal cleanup.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**. Format, lint, types, shell, native checks, and full test suite passed: **413 passed, 1 skipped, 0 failed, 3472 expectations**. The skip is the Linux mount test, unavailable on this macOS host.
- Required frozen case `v1.2-67-build-43` was run once with the specified profiles, jobs, and time scale. Result: **0 passed, 0 failed, 1 error, 0 skipped, 0 unimplemented; 1 instance**. Harness error: `FileNotFoundError` for the absent `dist/kogen` executable. No provider request reached the fake server; unmatched fake requests: **0**. This is pending CLI integration, not a pass. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-40-iv8k8Y/results.jsonl`.

Exact invocation:

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-40-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-67-build-43' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Replay and integration gaps

- B40 replay was not run: this packet has no assigned mandatory xspec slice. Hand count and seeds 17/23/41 are **not run**; first divergence is **not observed**. B59 owns the landing/recovery xspec slice and must provide that replay evidence; no replay acceptance is claimed here.
- CLI wiring is absent (`dist/kogen` was not built). Next owner: coordinator/integration, then rerun the frozen case against the integrated CLI.
- Host: macOS 26.7.1 arm64; the Linux-only mount test remains unverified on Linux. The frozen suite identifies itself as v1.2, so this run provides no v1.3 conformance evidence.

Successful worker checks do not constitute integration acceptance.

## Post-rebase integration follow-up

- Rebased dependency base: `b1a2f6bf50da40db125280aa0441c8eefcb68aec`; tested B40 code head: `0cb54b20f2b99b87a5e04d1e4ff07331132c2883`.
- Active follow-up effort: approximately 4 minutes. Model: GPT-6-based Codex; exact serving variant and token telemetry are unavailable.
- `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 tests/landing-cas`: **10 passed, 0 failed, 87 expectations**.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 457 passed, 1 skipped, 0 failed, 3,702 expectations. The Linux mount skip remains platform-specific.
- Integration's preceding full check failed once in `tests/host-bridge/host.test.ts` while parsing `parent-report.json` (`Unexpected EOF`); this file and test are outside B40's owned files. The driver writes the report directly to its final path while the test proceeds as soon as `existsSync` observes it, so the failure is consistent with a visibility race. The subsequent full check passed; no out-of-scope files were changed. Packet 02/coordinator owns any test repair if the race recurs.
- The required `v1.2-67-build-43` command was run once after rebase: **0 passed, 0 failed, 1 error, 0 skipped; 1 instance**. The harness could not start because `dist/kogen` is absent. Result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-40-15cmuL/results.jsonl`. No provider request reached the fake server; unmatched fake requests: **0**. This remains pending CLI integration, not a pass.
- No B40 production files changed in this follow-up. Mandatory replay remains unassigned to B40; hand counts, seeds 17/23/41, and first divergence remain not run/not observed. Linux parity and v1.3 conformance remain unverified/pending integration.

## Integration failure follow-up

- Follow-up base: `b1a2f6bf50da40db125280aa0441c8eefcb68aec`; starting HEAD: `2bf9497dd688010b2d893795d63badd5ce2168eb`. There was no in-progress rebase. This follow-up changed only this receipt; no landing implementation or test files changed.
- Active time: approximately 10 minutes. Model: GPT-6-based Codex; exact serving variant and token telemetry are unavailable.
- `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 tests/landing-cas`: **10 passed, 0 failed, 87 expectations**.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **FAIL**, 456 passed, 1 skipped, 1 failed, 3,699 expectations. The failing test is `tests/approval-ref/commit.test.ts: missing public Git identity refuses without creating an approval ref`. It is outside B40's owned files and fails when run alone. Git 2.54 returns the host account's fallback from `git var GIT_AUTHOR_IDENT` even with a fresh temporary `HOME`, `GIT_CONFIG_GLOBAL=/dev/null`, and no repository identity; the test assumes that result is unavailable after clearing local `user.name` and `user.email`. This reproduces independently of B40. Packet 21 owns `tests/approval-ref/**`; next owner is the packet 21/coordinator integration owner to make that hermetic fixture host-independent. No B40 change can repair this assertion within its allowlist.
- The exact `v1.2-67-build-43` command was run once with the requested profiles, jobs, and time scale. Result: **0 passed, 0 failed, 1 error, 0 skipped, 0 unimplemented; 1 instance**. The harness could not start because `dist/kogen` is absent (`FileNotFoundError`); no provider request reached the fake server, unmatched fake requests: **0**. This is pending public CLI integration, not a pass. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-40-pf3A6B/results.jsonl`.
- No mandatory xspec slice is assigned to B40. Replay hand counts, seeds 17/23/41, and first divergence remain not run/not observed. Host is macOS 26.7.1 arm64 with Git 2.54.0 and Bun 1.4.2; the Linux mount test remains skipped on this host. v1.3 case coverage and CLI integration remain pending. Next owner for B40's public case: coordinator/I2 CLI wiring, then rerun under the integrated executable.

## Integration retry (2026-10-08)

- Starting HEAD/base for this retry: `ad981b405e10e9156f825529082536ff6e394f81` on `kts/40-guarded-commit-and-landing-cas`. No rebase was in progress and the worktree was clean. The B40 implementation commit remains `f20e998`; this retry changes only this receipt. No other worktree or branch was touched.
- Active effort for this retry: approximately 7 minutes; prior receipt estimates total approximately 39 minutes, cumulative approximately 46 minutes. Model: GPT-6-based Codex; exact serving variant and token telemetry are unavailable.
- `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 tests/landing-cas`: **10 passed, 0 failed, 87 expectations**.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **FAIL**, 456 passed, 1 skipped, 1 failed, 3,699 expectations. All formatting, type, shell, freeze, dispatcher, native and other test checks passed. The sole failure is again `tests/approval-ref/commit.test.ts`'s `missing public Git identity refuses without creating an approval ref`; the Linux mounts test is the one platform skip.
- The failure is outside B40's allowlist. With `GIT_CONFIG_GLOBAL=/dev/null`, `git config --get user.name` and `git config --get user.email` return no configured values, while `git var GIT_AUTHOR_IDENT` still returns `Almir Sarajčić <almirsarajcic@Almirs-Mac-Studio.local>` from the host account. `packages/core/src/approval/commit.ts` uses that `git var` result, so `commitApprovalPackage` succeeds and contradicts the test's expected refusal. B21 owns the approval source and test; no B40-only change can repair this failure. Next owner: packet 21/coordinator integration owner to make the identity behavior and hermetic assertion agree with the contract.
- The exact required `v1.2-67-build-43` command was run once with the specified profiles, jobs and time scale. Result: **0 passed, 0 failed, 1 error, 0 skipped, 0 unimplemented; 1 instance**. The harness could not start because `dist/kogen` is absent (`FileNotFoundError`), so this is pending CLI wiring, not a pass. The fake request record has no received requests (`requests: []`, `oauth: []`): **0 unmatched requests**; its three expected `r1_happy` responses remained unconsumed because the executable did not start. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-40-bFW8gD/results.jsonl`.
- B40 has no assigned mandatory xspec slice. Hand counts, seeds 17/23/41 and first divergence remain not run/not observed. Host is macOS 26.7.1 arm64 with Git 2.54.0 and Bun 1.4.2; Linux behavior remains unverified here. The frozen suite is v1.2, so this provides no v1.3 conformance evidence. Next owner for B40's public case: coordinator/I2 CLI wiring, then rerun under the integrated executable.

## Retained branch repair — 8 October 2026

The latest dispatcher integration check at 458 tests failed only in
`tests/custody/supervise.test.ts:286`: the parent-SIGKILL test read its report
after the shell created the file but before the shell had written both PIDs.
The observed one-PID report was a test readiness race, unrelated to B40's
landing code. The coordinator fixed that shared test on main by waiting for a
complete two-PID report; packet 40 cannot own the custody file under its scope
rule. The dispatcher fixture also received a 30-second test timeout on main
because it runs many real Git operations and sometimes exceeded Bun's default
five-second timeout. Neither scope rule needed alteration.

Rebased onto main `95b91a36cb69d16273a49922af6145f6f8cfda46`.
`GIT_CONFIG_GLOBAL=/dev/null make check` with the pinned Git 2.54.0 selected
through `GIT_TOOL`: **PASS, 457 passed, 1 Linux-only skip, 0 failed, 3,702
assertions across 55 files**. Log: `~/cx/kts/logs/40-manual-final-check.log`.
The branch's three-dot diff contains only B40's four landing modules,
`tests/landing-cas/**`, and this receipt. It remains retained for dispatcher
integration and was not merged.
