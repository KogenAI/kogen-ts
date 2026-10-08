# Packet 26 receipt: recovery preservation before cleanup

## Revision and scope

- Base: `832f3456bb513fe83b47fd5aaff1df46840ffe25`.
- Head for tested implementation: `f0a6bd7fb137a5ae4287e539bf74e2dd340f34b0` (`Preserve recovery work before cleanup`). The receipt is committed separately.
- Owned implementation files: `packages/core/src/recovery/transition.ts`, `packages/core/src/recovery/recover.ts`, and `tests/recovery/recovery.test.ts`.
- This receipt is the only documentation file added for packet 26.
- Read `docs/work/REVIEW-MIDBUILD.md`, the packet brief, `PLAN.md`, `QUEUE.md`, `WORKER-RULES.md`, and frozen `CLI-RULE.txt`. No mid-build finding was assigned to recovery.

## Behavior implemented

Recovery checks both process liveness and start identity, and leaves live or unknown owners untouched. Once the owner is stale, it stops run-owned writers, reconciles a durable landing before choosing the terminal outcome, then snapshots every present workspace against its saved base. Recovery snapshots preserve tracked edits and deletions, non-ignored untracked files, executable modes, and symlinks, and are published through create-only recovery refs. A complete existing publication is adopted; a later differing tree is recorded under its own deterministic ref. An injected archive port provides create-only fallback and requires a verified complete manifest before cleanup. The run record stores unverified recovery identity before workspace removal.

If preservation or cleanup fails, recovery records `cleanup_failure`, keeps the affected workspace, and leaves `cleanup_pending` for a later attempt, including terminal runs. A landed outcome is retained while recovery finishes safe incoming-ref cleanup. Project claim release compare-deletes only a claim whose exact durable payload names this run; it does not remove a replacement claim.

## Draft D3 regression matrix

| Case | Local coverage | Boundary |
| --- | --- | --- |
| D3-a: edits before the first snapshot | Dead/reused-owner recovery preserves an edit, deletion, untracked file, executable bit, and symlink; the test observes the durable run record before workspace removal. | Deterministic stale-owner/effect test; no subprocess SIGKILL was run. |
| D3-b: publication gap and later progress | Injected record-append failure leaves the create-only ref; the next recovery adopts it and publishes a distinct later tree while retaining both recovery records. | Exercises the publication-to-record crash window through injected failure, not process termination. |
| D3-c: preservation failure and post-CAS cleanup | Ref and archive failure retains the workspace and sets cleanup pending; archive retry completes terminal cleanup. A separate landed case retains the landed outcome, preserves later progress, removes only its incoming ref, and protects a replacement claim. | Public moved-base/CAS crash and concurrent-user-checkout cases await compiled CLI integration. |

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS. Biome formatting/lint, TypeScript, shell checks, native units, and isolated tests passed; 499 pass, 1 skip, 0 fail, 3,927 assertions across 500 tests/61 files. The sole skip is the real Linux mount test, which requires Linux user namespaces and bubblewrap; this run was on macOS 26.7.1 arm64.
- Named local case, `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 tests/recovery/recovery.test.ts`: PASS, 7 pass, 0 fail, 63 assertions.
- The exact frozen command from the packet was run once for `build-36`, `build-37`, `state-21`, and `v1.2-06-crash-after-base-cas`. All four requested instances started in the harness but errored before launching Kogen because `dist/kogen` does not exist. Each error was `FileNotFoundError` for that executable; totals: 0 pass, 0 fail, 4 error, 4 instances. No provider request reached a fake endpoint; observed unmatched requests: 0. These are wiring errors, not conformance passes or assertion failures.
- No exact incompatible frozen-v1.2 assertion was observed: the executable was missing before case assertions could run. Compatibility remains unverified. The frozen suite is v1.2; exact v1.3 case IDs remain pending the suite owner.

## Replay, effort, and integration gaps

- Replay hands/seeds/first divergence: no replay slice was run by packet 26. The mandatory full-observation and 500 × 25-per-seed replay matrix remains with I3 / packet 59.
- Active effort: approximately 27 minutes through receipt preparation (wall-clock estimate; no active-time telemetry is exposed). Model: GPT-6-based Codex; serving variant/effort and token count are not exposed in this run's telemetry.
- Public integration remains pending: composition must call this recovery API with the durable terminal journal outcome; a production archive adapter must implement create-only publication and complete-manifest validation; the executable CLI must be built and the four frozen cases rerun by the coordinator. Linux host parity also remains open.
- Next owner: coordinator for archive/effect composition and executable CLI wiring, then I2/I3 integration for the real crash/CAS matrix and required replay evidence.
