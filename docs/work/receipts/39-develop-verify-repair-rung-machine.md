# B39 — Develop/verify/repair rung machine

## Scope and commits

- Base SHA: `434d7b7ed7d1d919b4227ab98294aa36544c5e15`
- Implementation commit: `04825712a8c7755c74095ecc52a5a79abaaab9b0`
- Final packet HEAD is reported in the worker's final response; this receipt is committed separately so its own commit SHA is not self-referential.
- Owned files changed:
  - `packages/core/src/build/develop.ts`
  - `packages/core/src/build/repair.ts`
  - `packages/core/src/build/rung.ts`
  - `tests/rung/rung.test.ts`
  - `docs/work/receipts/39-develop-verify-repair-rung-machine.md`
- `REVIEW-MIDBUILD.md`: no findings were assigned to B39.

## Behavior implemented

- Creates one builder session with the approved Intent, base acceptance excerpts, plan, and earlier-attempt context. Turns retain the same run/cache/thread/provider/role/stage/attempt/rung/epoch identity. Raw response items, tool results, protected-file notes, continuation text, turn-budget notes, and repair feedback append to that conversation.
- Text-only output continues the same turn history. Only a sole `finish` call with `{}` can finish. The first empty finish without a tree change receives the exact no-change response; a second empty finish can request verification.
- A red gate can receive at most six repairs. Counts use the shared verification failure counter and must strictly decrease; a repeated non-decreasing count or second red result without a count ends as `no_progress`. Six spent repairs end as `repair_cap`. After a repair, an unchanged saved-base tree ends as `unchanged`.
- Protected paths are restored after each tool batch. The fourth restore ends the rung as `protected_restore_limit` with a saved-base tree snapshot.
- Turn, rung-wall, and Build-budget caps snapshot and run the final verification against the saved base. Tree identity is not derived from workspace `HEAD`. Acceptance-only audit advice is observational and never demotes an item.

## Verification

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null mise exec -- bun --no-install test --max-concurrency 1 ./tests/rung` — **9 passed, 0 failed, 68 assertions**.
- Standalone TypeScript check: `GIT_CONFIG_GLOBAL=/dev/null mise exec -- bun --no-install node_modules/typescript/bin/tsc --noEmit` — **passed**.
- Required full check: `GIT_CONFIG_GLOBAL=/dev/null make check` — **passed**; 506 tests passed, 1 skipped, 0 failed. The skip is the Linux-mount test, which requires Linux user namespaces and bubblewrap; this worker ran on macOS.
- Exact B39 conformance command, cases `v1.2-39-build-04`, `v1.2-40-build-05`, `v1.2-41-build-06`, `v1.2-42-build-07`, `v1.2-43-build-08`, `v1.2-97-ladder-29`: **6 cases / 6 instances; 0 pass, 0 assertion failures, 6 harness errors, 0 skipped, 0 unimplemented**. Each errored before launching because `$ROOT/dist/kogen` does not exist. No provider requests reached the fake server; unmatched requests are not evaluable. No case assertion ran, so no incompatible frozen v1.2 assertion was observed or can be ruled out by this run. The v1.2 suite was not modified.
- Replay hand counts, seeds 17/23/41, and first divergence: **not applicable/not run**. B39 has no mandatory xspec slice in the queue; its named acceptance is the six public conformance cases above.

## Integration gaps and worker telemetry

- Public Build wiring and `dist/kogen` remain pending integration. The rung machine is implemented and covered locally, but the failed-to-launch public cases are **not** a conformance pass. Next owner: coordinator/I2 integrator to bind the rung machine into the public Build path and rerun the exact six cases.
- Authority: v1.3-draft `e19dd1c`; conformance runner is frozen v1.2 (`v1.2+434d7b7`). OS: macOS 26.7.1 arm64 (conformance metadata); Darwin 25.6.0 arm64 kernel.
- Active time: approximately 15 minutes. Runtime model: GPT-6 Codex; exact model variant and token telemetry were unavailable.
