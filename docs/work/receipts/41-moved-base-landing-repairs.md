# Packet 41 — Moved-base landing repairs

**Status:** Owned landing repair and retry behavior committed locally. Public
Build integration and B41 conformance remain pending; this receipt does not
claim integrated acceptance.

## Behavior

- Added a moved-base landing transition that resolves the current base, rebases
  the candidate, sends conflict feedback to the same winning R1 conversation,
  then runs the guard and full verification gate. Red guard or gate results
  return to that conversation for repair; green results are committed only
  when the new base is the sole parent and the commit tree matches the verified
  tree.
- Added a separate 600,000 ms landing-repair allowance. Model-reported active
  repair time consumes it; exhaustion parks with the last fully verified
  candidate. Landing retries carry the same allowance and conversation.
- Added journaled 1/2/4-second publish backoff for branch locks and moved-base
  CAS losses. After bounded waits, retry drops this run's stale incoming ref
  through an expected-value CAS, rebases and fully re-gates, then republishes.
  A lock that persists after a no-op rebase parks and retains the best
  candidate.
- Added a real temporary-Git-checkout race case. An edit made after checkout
  sync planning and after the origin ref CAS is retained, with the dirty
  checkout warning returned.

## Revisions, ownership, and environment

- Base SHA: `365f0e3861a6dc44e01ddad904845992fb7c90b5`.
- Implementation commit: `d54771cff074d25423d731e2845ab48c5b0a233b`.
- Receipt is a follow-up commit; final HEAD is reported in the worker handoff.
- Dependencies 33, 39, and 40 were present as ancestors of the assigned base.
- Exact changed files:
  - `packages/core/src/build/landing/rebase.ts`
  - `packages/core/src/build/landing/retry.ts`
  - `tests/landing-rebase/landing-rebase.test.ts`
  - `tests/landing-rebase/landing-checkout-race.test.ts`
  - `docs/work/receipts/41-moved-base-landing-repairs.md`
- REVIEW-MIDBUILD was read. No finding was assigned to B41; finding #2 is
  assigned to B33, already merged in the base.
- Host: macOS 26.7.1 arm64, Bun 1.4.2, Git 2.54.0. Active time at receipt
  preparation: about 16 minutes (943 seconds on the task counter). Model:
  Codex runtime based on GPT-6; exact serving model and effort are unavailable.
  Token counter at receipt preparation: 347,685.

## Checks and named cases

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 514 passed, 1 skipped,
  0 failed (515 tests across 64 files, 4,007 expectations). The skipped test
  requires Linux user namespaces/bubblewrap; this host is macOS.
- `bun test tests/landing-rebase`: **PASS**, 8 passed, 0 failed, 50
  expectations. Cases cover moved-base conflicts, red re-gate, stable winning
  conversation identity, separate allowance exhaustion and parking, lock
  backoff, lost-CAS stale-ref cleanup/rebase/re-gate, persistent-lock parking,
  and late checkout edit retention.
- `git diff --check`: **PASS** before the implementation commit.

## Frozen conformance command

The exact requested command was run once with profiles
`cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`, cases
`v1.2-58-build-24,v1.2-59-build-25,v1.2-60-build-26,v1.2-61-build-27,v1.2-62-build-28,v1.2-63-build-29,v1.2-87-ladder-19`, `--jobs 3`, and
`--time-scale 0.02`.

Result: **0 passed, 0 assertion failures, 7 error cases, 0 skips, 8 instances**
(case `v1.2-62-build-28` has two instances). Every instance stopped at process
startup with `FileNotFoundError` because `dist/kogen` is absent. No public
Kogen process or fake-provider request ran; unmatched fake requests were not
evaluated. The result JSONL is at
`/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-41-0slIno/results.jsonl`.
No selected assertion ran, so no incompatible old assertion was identified or
cleared. Text review found no incompatible assertion, but v1.2 compatibility
remains unverified. The v1.3-draft target remains authoritative.

## Replay

No xspec replay was run. The eight local tests are direct unit/integration
cases, not replay observations. Hand replay count and first divergence are
not applicable. Generated runs for seeds 17, 23, and 41, with 500 traces of
25 events per seed, remain pending the I3/B59 replay integration gate.

## Gaps and next owner

- The current `BuildLandingPort` exposes only `prepare` and `publish`, while
  `BuildRungPort.run` returns no resumable winning conversation. Coordinator
  must amend the shared Build interface to retain the winning rung's
  conversation and candidate workspace, then wire the production rebase,
  guard, full-gate, repair, and retry effects to these transitions. The
  packet-owned modules cannot establish public Build acceptance without that
  composition. Next owner: coordinator at I3 integration.
- The landing allowance charges active time reported by repair effects; Git,
  guard, full-gate work, and retry sleeps are not charged. The v1.2 ladder case
  explicitly leaves provider backoff accounting unspecified; coordinator/spec
  freeze should settle it during integration.
- Linux behavior remains unverified on this macOS host. The frozen command
  did not reach assertions, and no v1.3 parity claim is made.
