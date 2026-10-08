# Packet 65 — Optional edge generation

## Scope and source freeze

- Base SHA: 416e51dd150029d3d7875591493e5071d9185dba.
- Validated implementation head: eafe0fff5f453e50b9785d2b1e3c44c80b3571b9
  (Implement optional edge test policy).
- Target authority: frozen v1.3-draft e19dd1c21c19c5be1201c3b6a42c59c28b5c2887.
- Dependencies 44, 45, and 64 are in the base ancestry: B44 e830ec3 /
  416e51d, B45 a6f5d63 / 6cd8fe9, and B64 50005f7 / f4017f4.
- REVIEW-MIDBUILD.md assigns no remaining finding to packet 65.
- The frozen CLI-RULE.txt was read. No public command or flag was added.

## Behavior implemented

- optionalEdgeTestsEnabled keeps edge generation off unless build.edge_tests
  is true or the recipe has the +edge suffix.
- Edge generation extracts the exact Request section bytes from the approved
  Intent. Each core-green candidate gets a generated suite using only those
  Request bytes and its attempt identity; candidate implementation details are
  not passed to the generator.
- One green candidate runs its own suite. With multiple green candidates, every
  generated suite runs against every green candidate in stable attempt order.
  Selection is called only after that matrix completes.
- A red edge run leaves the candidate non-landable. Generation, runner, result,
  selector, or candidate-tree integrity failures stop selection and cannot
  produce a landable result. The candidate tree must match its pre-test verified
  tree after each run.
- tests/edge/edge.test.ts uses injected fake effects. It covers default-off,
  exact Request bytes, one-candidate testing, failure blocking, the parallel
  2x2 matrix and its ordering before selection, generation failure, and tree
  mutation.

## Verification

- Named local case:
  bun --no-install test --max-concurrency 1 ./tests/edge/edge.test.ts
  — 5 passed, 0 failed, 34 assertions.
- Required check:
  GIT_CONFIG_GLOBAL=/dev/null make check
  — PASS, 609 passed, 1 skipped, 0 failed; 4,793 assertions across 610
  tests in 79 files. The skip is the existing real-Linux-mount case, which
  requires Linux user namespaces and bubblewrap.
- The edge fixtures used 6 fake generation calls and 7 fake test-run calls,
  including the intentional injected generation failure. The callbacks all
  returned directly; there were 0 queued/unmatched fake requests and 0 fake
  HTTP endpoint requests.
- No standard B-set is assigned and no frozen conformance cases were run. No
  v1.2 assertions were classified as incompatible; this receipt makes no v1.2
  compatibility or v1.3 conformance claim.
- No xspec slice is assigned to this packet. Hand counts, seeds 17/23/41, and
  first-divergence results are not applicable and were not run.

## Experimental scope and integration gaps

- This is local policy and fake-effect evidence. It does not wire the module
  into the Build controller or CLI, provide a production test generator or
  acceptance runner, journal edge events, or alter the production selector.
  Missing wiring remains pending integration and is not an acceptance pass.
- The public Build route and the integration/release gates remain pending. The
  coordinator/I6 integrator must connect the configured recipe switch to the
  provider generation effect and safe test staging/runner, then use the returned
  landability result before selection and landing. I7 remains responsible for
  full release acceptance.
- The target rule is v1.3-draft section 3.1. A versioned v1.3 suite is not
  available; there is no exact external edge-case ID or parity claim in this
  receipt.
- Host: Darwin 25.6.0 arm64 / macOS 26.7.1, Bun 1.4.2, Git 2.54.0. Linux
  behavior is unverified. The Linux mount skip above remains an OS gap.
- Next owner: coordinator/I6 integrator.

## Source and effort

- Exact changed files:
  - packages/core/src/build/edge.ts
  - tests/edge/edge.test.ts
  - docs/work/receipts/65-optional-edge-generation.md
- Active effort: approximately 20 minutes, manual estimate excluding unattended
  check time.
- Model/token telemetry: GPT-6 Codex worker; the serving sub-variant, effort
  setting, and token count are not exposed in this API session.
