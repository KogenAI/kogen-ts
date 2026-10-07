# 05 — Native process custody receipt

## Source and effort

- Base: `d35207aeb70e3dd305fdc43dcfd7f25366dcdd61`
- Implementation commit/head: `249a7fcf162a421a4469dac214ec310a2ca5ba16` (`Implement native process custody`)
- Exact owned files:
  - `native/supervisor.c`
  - `native/supervisor.h`
  - `packages/core/src/process/supervise.ts`
  - `tests/custody/escaped-session.c`
  - `tests/custody/parent-kill-driver.ts`
  - `tests/custody/supervise.test.ts`
  - `tests/custody/supervisor-host.c`
  - `docs/work/receipts/05-native-process-custody.md`
- Active effort: approximately 44 minutes, excluding unattended check/conformance wait.
- Model: Codex/GPT-6. The serving variant, effort label and token counts were not exposed by the runtime.

## Behavior

Added host operation `0x0303` and a matching TypeScript request/result codec. The native supervisor validates each argument at 4 KiB, accepts explicit environment/cwd/stdin, streams stdout and stderr into bounded tails, counts all captured bytes, and enforces a monotonic wall deadline. It runs commands in a new session/group, sends TERM then KILL after 200 ms, and cleans remaining group members after a normal leader exit. The parent control socket is monitored for EOF; the supervisor also detects a reparented owner. Linux enables subreaper mode; macOS validates the session guardian's PID and start identity before signalling it.

The group boundary is deliberate: an escaped session is outside group custody. Its inherited output cannot hold the supervisor open forever because post-KILL draining is bounded. The escaped-session fixture confirms this limit and kills its own escaped child during cleanup.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** — Biome, TypeScript, shell check, warning-clean native C units and **167 tests / 0 failures / 1,803 expectations**.
- `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 ./tests/custody`: **PASS** — **9 tests / 0 failures / 37 expectations**. Covers chatty output/deadline, TERM handler, TERM-to-KILL escalation, normal-exit grandchild cleanup, escaped-session boundary, actual parent `SIGKILL`/control EOF cleanup, stdin and separate bounded tails, and TypeScript/native rejection of arguments over 4 KiB.
- Exact B05 command from the brief, with `--case 'custody-01,custody-02,custody-03,custody-04'`: **4 errors, 0 passes, 4 instances**. All four harness errors are `FileNotFoundError` for `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/05-native-process-custody/dist/kogen`; the bootstrap has no executable CLI. No provider request reached a fake server and there were **0 unmatched fake requests**. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-05-mu9BC4/results.jsonl`.
- Replay: not applicable to this packet; it owns no xspec slice. Hand scenarios, seeds and first divergence: not run.

## Pending integration

`native/main.c` is coordinator-owned and does not yet register operation `0x0303`; there is also no public command composition or `dist/kogen`. B05 public cases remain **awaiting integration**, not passed. The coordinator/I0 integration owner must register the process operation and wire production callers; I2 should then rerun the four exact custody cases.

The exercised host was Apple Silicon macOS 26.7.1. The macOS process-identity path was compiled and exercised. The Linux `PR_SET_CHILD_SUBREAPER` path is implemented but was not run because no Linux runner is available in this worktree; Linux verification remains pending with integration.

No v1.2/v1.3 contract incompatibility was found in this packet. The B05 suite errors are solely due to missing executable wiring.
