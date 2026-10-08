# Packet 59 receipt — xspec rebase and recovery

## Status and source

- Base SHA: `1e0cca536451836633ec633283657113a86dbfc1`.
- Implementation commit: `3523a032c04a57a5142da2d69c3b507789dce54e` (`test(xspec): add landing effect fixtures`).
- Tested implementation HEAD: `3523a032c04a57a5142da2d69c3b507789dce54e`.
- Receipt is a follow-up commit; xspec slice/model work remains pending clarification.
- Dependencies 26, 41, and 57 are present as ancestors of the supplied base.
- Spec authority: v1.3-draft source `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Host: macOS 26.7.1 (25G241), arm64; Bun 1.4.2, Git 2.54.0, Python 3.14.7.
- Active effort: approximately 40 minutes by session estimate; the runtime has no active-time counter. Model: GPT-6-based Codex; exact serving variant, effort, and token count are unavailable.
- Exact changed files so far:
  - `packages/test-support/src/landing-fixture.ts`
  - `tests/xspec-landing/landing-fixture.test.ts`
  - `docs/work/receipts/59-xspec-rebase-and-recovery.md`

## Implemented behavior

- Added a hermetic temporary Git origin, cloned workspaces, public Git and process ports, a deterministic local filesystem, and fault injection for ref and durable-record writes.
- The fixture can create candidate commits with distinct messages, perform expected-value ref CAS, and publish real unverified recovery snapshots.
- Added tests that call the shared `retryLanding`, `rebaseAndVerifyLanding`, `publishLanding`, and `recoverDeadRun` APIs. A controlled race advances the temporary origin after preflight but before `update-ref`, so the test observes a real lost CAS, 1/2/4-second retries, rebase/regate on the competing base, and final landing. Recovery tests inspect durable run records before cleanup, preserve bytes/modes/symlinks, retain work and `cleanup_pending` on publication failure, and keep a post-CAS run landed while preserving later workspace work.

## Checks and named cases

- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 tests/landing-cas tests/landing-rebase tests/recovery tests/xspec-landing`: **PASS**, 31 passed, 0 failed, 257 expectations across 5 files.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 531 passed, 1 skipped, 0 failed, 4,203 expectations across 532 tests/67 files. The only skip requires Linux user namespaces and bubblewrap; this host is macOS.
- No directly owned standard B-set applies. Public CLI cases were not run because this bootstrap has no `dist/kogen`; no assertion or fake HTTP request was launched. Unmatched fake requests were not evaluated.
- No exact incompatible frozen-v1.2 public assertion was observed because the executable is absent. Compatibility remains unverified. Packet 26's B26 cases and packet 41's B41 cases likewise remain integration work.

## Draft Quint replay and blockers

- Pinned `@informalsystems/quint@0.33.0` was installed only in `/tmp/kogen-59-xspec.lrfbZC/quint/prototype`. The frozen bundle under `spec-lock/kogen-spec/quint` was not modified.
- Rebase hand `spec`: **7/7**. Recovery hand `spec`: **5/5** only after a private scratch migration added the preservation fields required by the draft `Fact` type; the checked-in recovery hand events omit those fields. The scratch migration and resulting observations are not treated as authoritative adapter inputs.
- `gen --traces 500 --steps 25` completed for each required seed in the private copy. Accepted/refused events:

  | Slice | Seed | Accepted | Refused |
  | --- | ---: | ---: | ---: |
  | rebase | 17 | 2,343 | 10,157 |
  | rebase | 23 | 2,306 | 10,194 |
  | rebase | 41 | 2,436 | 10,064 |
  | recovery | 17 | 9,898 | 2,602 |
  | recovery | 23 | 9,886 | 2,614 |
  | recovery | 41 | 9,893 | 2,607 |

- Seed-separated generated output and build directories are under `/tmp/kogen-59-xspec.lrfbZC/receipts/{rebase,recovery}/seed-{17,23,41}`. These are generator diagnostics only; the recovery hand migration does not authorize use of mismatched observations.
- The exact `conform` command was attempted for rebase and recovery at seeds 17, 23, and 41. All six exited 1 before the first trace because `$ROOT/dist/kogen-xspec` is absent (`FileNotFoundError`); **0 hand/generated instances were compared**, so no first divergence was observed. The slice adapters are not yet implemented.
- The existing recovery draft also treats `approved` as a run status and includes `Reapprove`, while production `RunRecord` has no `approved` status and the recovery controller does not own reapproval. The adapter documentation forbids inventing a compatibility mapping. Clarification on the updated recovery model/source was requested; no response has arrived yet.

## Pending integration and next owner

- Required owned slice files `packages/xspec/src/slices/rebase.ts` and `packages/xspec/src/slices/recovery.ts` remain pending the recovery model/transition clarification above. No reducer-only or partial-observation result is claimed.
- `packages/xspec/src/main.ts` / the registry do not register these slices, and `dist/kogen-xspec` is absent. Registry, composition, and executable wiring belong to the coordinator; integrated replay remains pending.
- Linux behavior is unverified. Next: coordinator/spec owner supplies or approves an aligned recovery model and effect boundary; packet 59 then completes the full-observation adapters and replays. Coordinator wires the slices and reruns integrated conformance.
