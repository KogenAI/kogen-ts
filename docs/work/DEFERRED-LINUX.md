# Deferred Linux validations

This is the append-only register for Linux checks deferred by the coordinator.
Later integration gates must append their own entries without replacing earlier
ones. An open entry is not a pass or waiver. Record the Linux host, source SHA,
exact commands, and results when closing an entry. Every entry must pass before
release gate I7 and before any public claim.

| Gate | Deferred Linux checks | Reason | Required closure | Status |
| --- | --- | --- | --- | --- |
| I0 | Packet 02 kill/pipe/framing spike including parent-kill process-group cleanup; I0 native-bridge and hostile-link smoke; packet 05 real chatty/TERM/grandchild/SIGKILL custody checks including Linux subreaper/parent-death cleanup; packet 08 B07 recheck including mount and missing-user-namespace tests. | No Linux runner is available on the Mac Studio. | Pass on a Linux benchmark host in the joint Go and TypeScript validation batch, before I7 and before any public claim. | OPEN |
| I1 | Native C17 build, Linux auth-path mount denial, and macOS-only test portability. | Failures reported by the benchmark operator on kogen-bench-us. | Re-run the three reported checks on Linux and pass before closing. | OPEN |

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
