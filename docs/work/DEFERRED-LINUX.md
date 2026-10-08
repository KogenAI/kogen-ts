# Deferred Linux validations

This is the append-only register for Linux checks deferred by the coordinator.
Later integration gates must append their own entries without replacing earlier
ones. An open entry is not a pass or waiver. Record the Linux host, source SHA,
exact commands, and results when closing an entry. Every entry must pass before
release gate I7 and before any public claim.

| Gate | Deferred Linux checks | Reason | Required closure | Status |
| --- | --- | --- | --- | --- |
| I0 | Packet 02 kill/pipe/framing spike including parent-kill process-group cleanup; I0 native-bridge and hostile-link smoke; packet 05 real chatty/TERM/grandchild/SIGKILL custody checks including Linux subreaper/parent-death cleanup; packet 08 B07 recheck including mount and missing-user-namespace tests. | No Linux runner is available on the Mac Studio. | Pass on a Linux benchmark host in the joint Go and TypeScript validation batch, before I7 and before any public claim. | CLOSED — Linux checks passed 2026-10-08; Linux conformance selection remains OPEN below. |
| I1 | Native C17 build, Linux auth-path mount denial, and macOS-only test portability. | Failures reported by the benchmark operator on kogen-bench-us. | Re-run the three reported checks on Linux and pass before closing. | CLOSED — all reported checks passed 2026-10-08. |
| I0 conformance | Run the selected frozen conformance suite with the conformance runner on Linux and record its Linux result. | The final batch ran `make check`; it did not run the conformance runner. | Run and record the selected conformance command on Linux, including cases, instances, errors/skips/unimplemented rows, unmatched requests, and result/log paths. | OPEN |
| I1 approval/status integration | Recheck the I1 public approve, remove, status and watch composition, including SHA-256 approval refs and the selected B20/B21/B22/B25 conformance cases, on Linux at the I1 receipt source SHA. | The Mac Studio is the available coordinator host; the earlier Linux batch predates the I1 public CLI composition. | Run pinned Linux `make check`, build the CLI, and run the exact I1 selected conformance cases with case/instance totals, skips/errors/unimplemented rows and fake-request accounting. Record the Linux host, source SHA and logs before I7. | OPEN — no Linux result for the I1 public composition. |
| I2 public Build and queue | Recheck the I2 public R1 Build, injected and owned ChatGPT requests, refresh locks, queue stop/detach, protected restore, bare-origin landing, and the I2 conformance selection on Linux at the committed I2 receipt SHA. | I2 integration and selected conformance ran on the macOS coordinator host; real Linux bubblewrap and process custody are OS-specific. | On Linux run pinned `make check`, build the CLI, run the I2 selected conformance IDs and a fake-provider green R1 with owned and injected auth. Record host, source SHA, exact commands, case/instance totals, failures, skips, errors, unimplemented rows, unmatched requests and logs before I7. | OPEN — no Linux result for the I2 public composition. |
| I3 recovery and replay | Recheck public dead-owner recovery, SIGTERM/SIGKILL child custody, status/queue reconciliation, moved-base landing, and the I3 selected conformance cases on Linux; run the mandatory replay matrix against the matching Linux xspec artifact. | This integration round runs on the macOS Studio, and no Linux runner is connected to this checkout. | On Linux use the I3 receipt source SHA, run pinned `make check`, build both artifacts, execute the I3 selection and all eight hand/generated replay slices, and record case/instance/fake counts, trace counts, first divergences and artifact hashes. | OPEN — not run on Linux. |
| I4 Build ladder and caches | Recheck serial and hard parallel rungs, candidate audit/selection, setup and approval-baseline caches, active budget, and the named I4 conformance selection on Linux. | I4 integration was exercised on the macOS Studio only; no Linux runner is connected to this checkout. | On Linux use the I4 receipt source SHA, run pinned `make check`, build the CLI, run the I4 selection and D1/D2 cache and audit traces, and record host, exact commands, case/instance/fake counts, failures, skips and artifact hashes. | OPEN — not run on Linux. |

### I1 batch note

- Host: `kogen-bench-us` (Ubuntu, glibc, Bun 1.4.2).
- Source SHAs: tested kogen-ts `cd5a82b28862ddfb1a6eb56f1f394f8d90fd283a`; kogen-ts fix base `6511b4f70c70bb3b4238cee9b7fdbb658286fe7f`; kogen-spec `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Reported failures:
  1. `native/paths.c:112`: `implicit declaration of function 'realpath'` with `-std=c17 -Werror`; `_POSIX_C_SOURCE 200809L` alone does not expose it on glibc.
  2. `tests/sandbox-linux/linux.test.ts:458`, “real Linux mounts hide secrets, keep the origin read-only, and allow workspace/cache writes”: fails at `test ! -r "$HOME/auth.json"`; the plan replaced the injected auth file with readable `/dev/null`.
  3. `tests/sandbox-macos/sandbox.test.ts:383` and `:443`: platform-specific tests assert `process.platform === "darwin"` instead of skipping on other platforms.
- Fix commit: `7768fabff8f49b1908d22f6911505a564a0291c3`.
- Status: awaiting Linux re-run. Keep OPEN until that run passes.

### I1 follow-up rerun and fix progress

- Host: `kogen-bench-us` (Linux).
- Source SHAs: benchmark rerun kogen-ts `9c10511`; integration base kogen-ts `147515cf5c1786bb3d20eabbd144dbe33deaedc8`; fix commit `b0be31c50fb7d464bc4a4a06047367a64aabc036`.
- Rerun result before this fix: `make check` ran 392 tests: 389 passed, 2 skipped, 1 failed.
- Exact remaining failure: `tests/sandbox-linux/linux.test.ts:476`, `expect(execution.stderr).toBe("")`. The stderr contained `kogen-sandbox-test: 1: cannot create …/home/checkout/sentinel: Read-only file system` and the same error for `…/home/origin/sentinel`. Both paths are intentionally read-only. The shell redirections previously applied left to right, so the failing append wrote its diagnostic before `2>/dev/null` took effect. Both probes now wrap the append in `{ ...; } 2>/dev/null`.
- Linux items reported passing in the rerun: native compile, auth.json mask, custody, bridge, restorer, mount tests, and capability probe. The exact-stderr Linux mount integration item still needs the final Linux rerun.
- Status: awaiting Linux re-run. Keep OPEN until that run passes.

### Final Linux validation batch — 2026-10-08

- Host: `kogen-bench-us`, Ubuntu Linux x86_64; Bun 1.4.2 and Git 2.54.0 from the pinned scratch prefix.
- Source SHA: kogen-ts `a76a1575aa0fbc3ac185a2188e081712fe4e9b8b` (`Record Linux rerun progress`), the final rerun source at main on the benchmark host.
- Commands and results:
  - `bun install --frozen-lockfile` — **PASS**, rc=0.
  - `make check MISE= BUN=<bun 1.4.2> GIT_TOOL=<git 2.54.0>` — **PASS**, rc=0; 427 tests across 52 files, 425 passed, 2 skipped, 0 failed. The skips are the macOS sandbox and macOS probe tests.
- Logs: `/srv/bh/bench/linux-batch-20261008/logs4/`; earlier reruns: `/srv/bh/bench/linux-batch-20261008/logs2/` and `/srv/bh/bench/linux-batch-20261008/logs3/`.
- The earlier follow-up failure, `tests/sandbox-linux/linux.test.ts:476` requiring empty stderr after deliberately denied checkout/origin writes, was fixed in `b0be31c50fb7d464bc4a4a06047367a64aabc036`. The final run passed it. The earlier exact failures and the three original I1 reports remain documented above for audit history; this final passing run closes the I0/I1 items covered by `make check`.
- I0 test mapping:
  - Packet 02 parent-kill cleanup: `tests/host-bridge/host.test.ts`, “SIGKILL of the Kogen parent closes control EOF and kills the child group”; frame rejection: “oversized and unknown-version frames fail before payload allocation”; exact YAML boundary/oversize behavior: `tests/integration/foundation.test.ts`, “production bridge preserves the exact YAML byte boundary and oversized rejection”.
  - Native bridge and Git integration: `tests/integration/foundation.test.ts`, “production supervisor and Git port run through the registered bridge”. Hostile Git metadata/hooks/filters/fsmonitor: `tests/git-port/git-port.test.ts`, “private metadata ignores hostile workspace hooks, filters, fsmonitor and excludes”. Hostile link restoration: `tests/protection/protection.test.ts`, “restorer repairs hostile final links, parent links and file-to-directory swaps without following links”.
  - Packet 05 custody: `tests/custody/supervise.test.ts`, “a monotonic deadline drains chatty output into bounded tails”, “TERM is delivered to the group and a TERM handler can exit”, “an ignored TERM is followed by KILL after the 200 ms grace”, “normal leader exit terminates its remaining process group”, “parent SIGKILL closes control EOF and the helper kills the process group”, and “an escaped session is outside group custody and cannot hold output open forever”.
  - Packet 08 capability fallback and mount plan: `tests/sandbox-linux/linux.test.ts`, “missing user namespace becomes an observable unconfined fallback”, “mount plan exposes only the workspace, run directory, and declared caches as writable”, and “mount plan rejects workspace paths that would re-expose a credential directory”. Real Linux confinement: “real Linux mounts hide secrets, keep the origin read-only, and allow workspace/cache writes”; capability probe: “capability probe exercises user, pid, ipc and uts namespaces without isolating network”.
- I1 test mapping: native C17 compilation is part of `make check`; auth-path masking is covered by the Linux mount-plan test and the real Linux mounts test above; portability is covered by the two macOS-only tests in `tests/sandbox-macos/sandbox.test.ts`, which use `test.skipIf(process.platform !== "darwin")` and were the two expected skips on Linux. The fixed exact-stderr mount check is included in the real Linux mounts test.
- The Linux conformance selection is not covered by these checks and remains OPEN. Run it with the conformance runner on Linux and record the case/instance totals and all unmatched requests, skips, errors, and unimplemented rows before closing that separate entry.
