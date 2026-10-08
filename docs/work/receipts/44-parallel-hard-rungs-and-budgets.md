# B44 — Parallel hard rungs and budgets

## Scope and source freeze

- Base SHA: `38297e6139e36dde63777ed5c41c5b7ea9b42c0d`.
- Validated implementation head: `8654b4dc274989b6a131f5090ab20bbbea752de2`
  (`Implement parallel hard rungs and budget tracking`).
- Target authority: frozen `spec-lock/kogen-spec` v1.3-draft at
  `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; the public suite remains the
  read-only v1.2 overlay.
- Dependency 43 is present at the base. The required I2 receipt says
  **prepared for coordinator review; not accepted**. Public B44 acceptance
  therefore remains pending I2 and I4 integration.
- Exact owned files:
  `packages/core/src/build/parallel.ts`,
  `packages/core/src/build/budget.ts`,
  `tests/parallel/parallel.test.ts`, and this receipt.

## Mid-build review finding

- **#7 P2 (38/44, coordinate 23):** the parallel policy serializes events from
  both rung members before sending them to the shared run-state writer. The new
  barrier regression routes concurrent member events through
  `createSerializedRunStateWriter`, blocks the first append, and verifies the
  later terminal snapshot retains `cleanup_pending` from the first event.
  I2 also owns the durable append-plus-snapshot writer. Local finding coverage
  is closed; merged integration acceptance remains with the coordinator.

## Behavior implemented

- `runParallelHardRungs` starts admitted R1 and R2 from separate workspaces.
  Each receives distinct attempt/workspace inputs, a shared plan, a fresh
  repair allowance, a wall limit, the shared pause-aware Build budget, and an
  abort signal. The barrier fixture models a separate conversation per rung.
- First green completion wins. Exact completion-time ties choose the lower
  rung ordinal. The other member is aborted, stopped and joined; its final
  base-relative snapshot is published before its workspace is cleaned up.
- Budget expiry stops active members and publishes each final snapshot while
  retaining those workspaces and candidates for later selection. Both-red
  results are returned in rung order for the coordinator's selector.
- `BuildBudget` measures monotonic active time, counts overlapping provider
  pauses once, exposes remaining/used/paused observations, and wakes its expiry
  wait when a pause begins or ends.
- Concurrent rung event emissions pass through one serialized event lane. The
  existing production rung/controller composition is not wired to this policy
  in the owned files.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null mise exec -- bun --no-install test --max-concurrency 1 ./tests/parallel`:
  **PASS**, 6 tests, 33 expectations. Includes barrier-proven overlap,
  deterministic tie, cancellation snapshot-before-cleanup, active-vs-paused
  accounting, separate member inputs, and the shared run-writer interleaving.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**; 578 passed, 1 skipped,
  0 failed, 4,432 assertions across 579 tests in 74 files. The skip is the
  Linux-only user-namespace/bubblewrap mount test on macOS.
- Ran the exact B44 frozen-suite command from the brief once, with cases
  `v1.2-71-ladder-03,v1.2-86-ladder-18`, full required profile, jobs 3 and
  time scale 0.02. Result: **2 cases / 2 instances, 0 passed, 0 assertion
  failures, 2 harness errors, 0 skips or unimplemented**. Both errors are
  `FileNotFoundError` before launch because `$ROOT/dist/kogen` does not exist.
  The harness says no provider request reached the fake server: **0 received,
  0 unmatched**. These are pending wiring errors, not conformance passes.
- No v1.2 assertion executed, so no incompatible old assertion was confirmed.
  Both selected cases express behavior compatible with the v1.3-draft target;
  their compatibility still needs a run against the integrated executable.
- Replay hands, generated traces for seeds 17/23/41, and first-divergence
  records were **not run**; B44 has no assigned xspec slice. I3/I4 own the
  integrated replay and ladder closure.

## Integration, version and platform gaps

- `docs/work/receipts/I2.md` is not accepted. I4 owns production Build
  composition of the parallel policy, after the coordinator closes I2.
- `dist/kogen` is absent, and the public controller still does not route a hard
  plan to this policy. Missing public wiring remains pending, never accepted
  from these effect-boundary tests.
- The current project schema has no `build.budget_ms` admission and still lacks
  the B43 ladder option admission. The coordinator/project-schema owner must
  resolve those interfaces before the v1.2 budget case can run. Do not add
  schema or composition files from this packet.
- The frozen v1.2 suite has no new version conflict identified by this packet;
  the exact selected cases remain unverified because the executable is absent.
- Validation host: macOS 26.7.1 / Darwin 25.6.0, arm64; Bun 1.4.2, Git 2.54.0.
  Linux behavior remains untested here.
- Next owner: coordinator to accept I2 and route the real Build through the B44
  effect boundary in I4; project-schema owner to admit the budget/ladder config;
  then rerun both exact frozen cases against the integrated `dist/kogen`.

## Effort and model

- Active effort: approximately **10 minutes**, plus about **2 minutes** of
  automated `make check` wait.
- Model/token telemetry: GPT-6 Codex worker; exact serving variant, effort
  setting, and token count are not exposed to this worker.
