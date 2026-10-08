# Packet 42 — Queue public handlers, detach and signals

**Status:** B42 implementation is committed locally. Public Build and I2
acceptance remain pending coordinator integration; this receipt does not claim
that the named public conformance cases passed.

## Changes

- Added `drainQueue`, which owns the per-checkout queue lock, runs recovery and
  status before selecting work and after every Build, starts Builds serially,
  and delegates outcomes to the shared queue transition policy. Landing output
  requires a valid Build id and commit. Skipped approvals do not count as
  Builds; stopped Build lines keep the Intent queued. Queue stop waits for the
  current Build, preserves later approvals, and prints the frozen `Build(s)`
  count form.
- Added public `queue start` and `queue stop` handlers. Attached starts stream
  lines as effects finish. Stop writes the marker only for a verified owner.
  Detached start uses a new process session, private append-only `queue.log`,
  and a bounded `ready:<pid>` handshake; startup failure terminates the child
  group and returns the frozen detach-unavailable refusal.
- Added first-signal custody for SIGINT/SIGTERM. The drain awaits the Build
  interruption port before returning 130/143, emits no final queue line after
  a signal, and releases its owner lock. The port contract requires the Build
  adapter to stop run-owned child groups and durably record interruption.
- Added 13 local tests covering serial Build effects and refreshed
  dependencies, stop marker behavior, counts and output, signal custody,
  detached startup, the public start/stop handlers, and distinct checkout
  queue roots with a shared Build-claim fixture.

The queue handler is ready for the I2 composition to supply production
`QueueLockStorage`, process identity, recovery/status adapters and a production
Build execution. Its queue tests use injected Build executions. They do not
constitute a runnable public R1 Build or end-to-end two-checkout Git claim test.

## Review findings

- REVIEW-MIDBUILD #7 is closed by the merged B38 serialized run-state writer
  and its barrier regression; B42 did not change that writer.
- REVIEW-MIDBUILD #10 remains an I1/I2 integration item owned by the coordinator
  and package 36. B42's two-checkout fixture does not cover the approval
  preflight/staging/cleanup race required by that finding.
- No other finding in `REVIEW-MIDBUILD.md` is assigned to B42.

## Source and effort

- Base SHA: `365f0e3861a6dc44e01ddad904845992fb7c90b5`.
- Tested implementation commit: `d52faa5` (`Implement B42 queue command handlers`).
- Final receipt commit and worktree HEAD are recorded in the worker handoff.
- Exact owned files changed:
  - `packages/core/src/queue/drain.ts`
  - `packages/cli/src/handlers/queue.ts`
  - `packages/cli/src/handlers/signals.ts`
  - `tests/queue-command/queue-command.test.ts`
  - `docs/work/receipts/42-queue-public-handlers-detach-and-signals.md`
- Host: macOS 26.7.1 arm64, Bun 1.4.2, Git 2.54.0. Active effort:
  approximately 55 minutes by manual estimate, within the 90-minute limit.
  Model: GPT-6-based Codex; exact serving variant and token usage are not
  exposed in this runtime.

## Local checks

- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/queue-command`:
  **PASS**, 13 tests, 49 expectations, 0 failures.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 519 passed, 1 skipped,
  0 failed, 4,006 expectations across 520 tests. The skipped case requires real
  Linux user namespaces and bubblewrap; this host is macOS.
- TypeScript and Biome checks passed as part of the final `make check`.
- `git diff --check`: **PASS** before the implementation commit.

## Frozen conformance

The exact packet command was run once, using profiles
`cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`, the eight
requested IDs, `--jobs 3`, and `--time-scale 0.02`. The suite reports
`v1.2+365f0e3`.

Result: **0 passed, 0 assertion failures, 8 harness errors, 0 skips, 0
unimplemented; 9 instances.** Every selected case stopped before launching
because `dist/kogen` is absent (`FileNotFoundError`). Case totals were:

| Cases | Instances | Result |
| --- | ---: | --- |
| `cli-29`, `state-18`, `build-38`, `build-42`, `v1.2-124-build-31`, `v1.2-65-build-33`, `v1.2-66-build-34` | 1 each | 7 harness errors |
| `custody-05` | 2 | 2 harness errors |

All nine fake request logs have empty `requests` and `oauth` arrays: **0
received requests and 0 unmatched received requests**. The scripted `plan`,
`edit`, `done` replies in `v1.2-65-build-33` and `r1_happy.plan`,
`r1_happy.edit`, `r1_happy.done` replies in `v1.2-66-build-34` remain
unconsumed because the executable did not start. The complete result is at
`/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-42-gQj15d/results.jsonl`.

The frozen `Build(s)` output assertions in `v1.2-124-build-31`,
`v1.2-65-build-33`, and `v1.2-66-build-34` match the target's §1.7.4 spelling
and are reflected in the handler. No incompatible old assertion was observed;
the cases could not execute, so their runtime compatibility remains
unverified. The suite is v1.2 while the target spec is v1.3-draft
`e19dd1c`; this run provides no v1.3 parity evidence.

## Replay and integration gaps

- Packet 42 has no assigned mandatory replay slice; packet 58 owns queue/status
  replay. B42 ran no hand scenarios or generated traces; hand counts and seeds
  17, 23, and 41 are **not run**, and first divergence is **not observed**.
- `docs/work/receipts/I1.md` says I1 is prepared but not accepted. I2 still
  needs to register and compose these handlers with the actual Build controller,
  atomic queue storage and process identity adapters, then prove a green R1
  Build and real two-checkout shared-claim behavior.
- The current B38 `runBuild` API does not expose an interruption hook. I2 must
  connect SIGINT/SIGTERM custody to supervised child-group termination and a
  durable interrupted event before resolving the queue interruption port.
- `dist/kogen` and public queue command registration are absent. Linux behavior
  is unverified on this macOS host. No I2 or v1.3 acceptance is claimed.
- Next owner: coordinator for I1 gate acceptance and I2 public composition;
  packet 58 owns the queue/status replay evidence.

Successful local checks and worker completion do not equal integration
acceptance.
