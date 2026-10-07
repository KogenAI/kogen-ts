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
- Fix commit: `9f5831991874c4e39db9c724772dcbdcc857ac6c`.
- Status: awaiting Linux re-run. Keep OPEN until that run passes.
