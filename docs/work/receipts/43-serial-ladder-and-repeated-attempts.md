# B43 — Serial ladder and repeated attempts

## Scope and source freeze

- Base SHA: `fdbf24acf656670845d92741e9083b4e4c9561a4`.
- Validated implementation head: `6fb1d8444c54228ec8ea458c504b644c60a122af`.
- Target authority: frozen `spec-lock/kogen-spec` v1.3-draft at
  `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; the public conformance suite is
  the read-only v1.2 overlay.
- Dependencies 12, 39, 41, and 42 are present in the base ancestry. I2 has
  merged, but its receipt leaves red ladder composition for I4.
- `REVIEW-MIDBUILD.md`: #2 is assigned to the package 33 amendment before B43
  integration. The merged retry transition was inspected: it increments
  telemetry `attempts` for each failure and only increments `cappedAttempts`
  for malformed and eligible overload failures. Login/usage waits and
  budget-funded timeout, stall, and transport retries do not spend the cap.
  Finding #2 is closed in the merged dependency. `tests/retries` passed in both
  the focused run and the final repository check.

## Frozen R4 and repeat interpretation (before tests)

The frozen spec makes R4 experimental (§3.1) and says repeats begin after R4,
cycling from zero-based rung index 2 (`sol-high`, then `raw-request`); setting
`repeat_from: null` disables those repeats, which is not the default. The v1.2
overlay's `v1.2-99-ladder-31` has no ladder config and asserts exactly three
`rung_started` events with no R4. The project format notes `max_rungs` and
`experimental_r4` as admitted-draft fields, but the current TypeScript project
schema still rejects them and does not describe `repeat_from`.

For the owned ladder policy, freeze this consistent reading:

1. `experimental_r4` defaults to `false`; R4 is not scheduled unless it is
   explicitly true.
2. `max_rungs` is an integer from 1 through 4. Its default is 3 when R4 is
   disabled and 4 when R4 is enabled. An explicit value caps the initial
   ladder; `max_rungs: 1` admits only R1 even for a hard plan.
3. `repeat_from` is a zero-based index, defaults to 2, and accepts `null` to
   disable repeats. Repeats are available only after an admitted R4; they cycle
   from the configured index through the admitted rung list until the Build
   budget prevents another start. Names use the spec's suffix form, such as
   `sol-high-2` and `raw-request-2`.
4. Every attempt gets a fresh workspace from the saved base, the same plan
   unless its input is raw-request, the saved base-acceptance observation,
   earlier-attempt summaries without prior diffs, and six fresh repairs.

This records an implementation interpretation only. It does not alter the
frozen spec, suite, project schema, controller, or I2 composition. Public
config decoding and I4 Build wiring remain integration interfaces for the
coordinator to admit.

## Behavior implemented

- `parseLadderOptions` validates the ladder map and its known keys. R4 defaults
  off; `max_rungs` defaults to 3, or 4 when R4 is enabled, and accepts 1–4;
  `repeat_from` defaults to zero-based rung 2 and accepts `null` to disable
  repeats.
- `createLadderPlan` resolves the built-in ladder, diverse, Luna, and Sol
  low/medium/high recipes, preserving `+edge`. It schedules R1–R3 by default
  and admits the raw-request R4 only with `experimental_r4: true`. Repeats
  cycle from the configured index after R4, with `-2`, `-3`, etc. suffixes.
  Built-in Grok ladder roles stay on the resolved Grok provider.
- `runSerialLadder` injects workspace and rung effects. It requires unique
  workspace IDs and roots, retries setup once in that workspace, and gives
  every attempt the saved base, base-acceptance observation, shared plan (R4
  receives `null`), and summaries of earlier attempts without their diffs.
  Each rung receives six repairs and a wall allowance capped by the remaining
  active Build budget and 30 minutes. Green, stopped, and exhausted schedules
  return verified candidates for the later selector. Hard plans with more than
  one admitted rung are refused here for the parallel policy owner; a
  `max_rungs: 1` hard plan can run serially.
- The implementation provides the ladder policy and effect boundary. Project
  YAML admission and production Build composition are not wired in this packet.

The R4/repeat interpretation above was frozen before running the new ladder
tests. The suite's no-config expectation in `v1.2-99-ladder-31` is consistent
with the default-off choice.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null mise exec -- bun --no-install test --max-concurrency 1 ./tests/ladder ./tests/retries`:
  **31 passed, 0 failed, 166 assertions**.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**; 572 passed, 1 skipped,
  0 failed, 4,399 assertions across 573 tests in 73 files. The single skip is
  `real Linux mounts require Linux user namespaces and bubblewrap` on Darwin.
- Ran the exact B43 frozen-suite command with profile
  `cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`,
  `--jobs 3`, and `--time-scale 0.02` for cases:
  `v1.2-102-ladder-34`, `v1.2-68-build-44`, `v1.2-70-ladder-02`,
  `v1.2-72-ladder-04`, `v1.2-80-ladder-12`, `v1.2-88-ladder-20`,
  `v1.2-89-ladder-21`, `v1.2-94-ladder-26`, `v1.2-95-ladder-27`,
  `v1.2-98-ladder-30`, and `v1.2-99-ladder-31`. Result: **11 instances,
  0 passed, 0 assertion failures, 11 harness launch errors, 0 skipped or
  unimplemented**. Every case failed before launching because
  `dist/kogen` is absent. The harness reported no provider request reached the
  fake server: **0 received, 0 unmatched**. This is pending executable/I4
  integration, not a conformance pass.
- No v1.2 assertion incompatibility was confirmed: none of these case
  assertions ran. The exact compatibility of the remaining cases needs the
  command rerun after CLI wiring.
- Replay hands, 500 × 25 counts for seeds 17/23/41, and first-divergence data:
  **not run in B43**; no B43 xspec replay was available at this package boundary.

## Integration and version gaps

- The current project schema rejects `max_rungs` and `experimental_r4` and
  lacks `repeat_from` admission. The coordinator/project-schema owner must
  admit these keys and pass their resolved values into the ladder plan.
- Production Build composition has not wired this runner. I2's receipt assigns
  the red ladder to I4; I4/coordinator owns the composition and public R1 proof.
  B44/parallel policy owns hard plans with multiple admitted rungs.
- `dist/kogen` is absent in this bootstrap, so public CLI and frozen-suite
  behavior remain unverified. The Linux mount test also remains platform-gated
  on this macOS host.
- Next owner: coordinator for schema/composition interfaces and I4 integration;
  rerun the exact frozen command after `dist/kogen` is available, then attach
  the required merged integration receipt I2.

## Source and effort

- Exact owned files: `packages/core/src/build/ladder.ts`,
  `packages/core/src/build/attempts.ts`, `tests/ladder/**`, and this receipt.
- Runtime: Darwin 25.6.0 arm64 / macOS 26.7.1, Bun 1.4.2, Git 2.54.0.
- Active effort: approximately 25 minutes (within the 90-minute limit).
- Model/token telemetry: GPT-6 Codex worker; exact serving sub-variant,
  effort setting, and token count are not exposed to this worker.
