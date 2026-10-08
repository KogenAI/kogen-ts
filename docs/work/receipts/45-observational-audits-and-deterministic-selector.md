# B45 — Observational audits and deterministic selector

**Status:** Local policy implementation complete; public Build and B45 command
acceptance remain pending integration.

## Source and dependencies

- Base SHA: `38297e6139e36dde63777ed5c41c5b7ea9b42c0d`.
- Implementation head SHA: `f06e7e9177669dd945e001d4c33cb65665c6d0c6` —
  `Implement observational audit and selector policies`.
- Target authority: frozen `spec-lock/kogen-spec` v1.3-draft at
  `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen black-box suite is v1.2.
- Dependencies 18, 30, 33, and 43 are ancestors of the base:
  `053f226e` (gate verification), `118544e6` (canonical sessions),
  `b679c644` (retry policy), and `6fb1d844` (serial ladder).
- `docs/work/receipts/I2.md` exists but says **prepared for coordinator review;
  I2 has not been accepted**. That receipt assigns red ladder and advanced
  selection integration to I4.

## Owned files

- `packages/core/src/build/audit.ts`
- `packages/core/src/build/select.ts`
- `tests/audit-policy/audit-policy.test.ts`
- `tests/audit-policy/fixtures.ts`
- `tests/audit-policy/select.test.ts`
- `docs/work/receipts/45-observational-audits-and-deterministic-selector.md`

## Behavior

- Build audit parsing returns an `observational` receipt. Only advice for actual
  failed acceptance rows is retained; malformed, duplicate, unknown, or
  citation-shaped legacy entries warn. The receipt fixes `demoted` to false and
  `advisoryItems` to an empty tuple.
- Landing eligibility uses the real gate result, requires every approved item
  to pass and at least one approved change item to pass. `green` and
  `green-or-advisory` take the same path. The default is `green`; existing
  project parsing still rejects `auditor_demotion: true` with
  `build.auditor_demotion has no admitted calibration`.
- Selector scores real acceptance item results, then blocking findings from
  the gate, added plus removed lines in the exact unified diff, and one-based
  attempt order. It does not accept auditor advice as an input. It returns the
  winning diff as a private byte copy even when every candidate remains red.
- No endpoint detection, fake-only behavior, demotion switch, or enabled legacy
  landing toggle was added.
- The new modules are intentionally not wired into `controller.ts`, `ladder.ts`,
  or CLI composition, which are outside this packet's allowlist. Integration
  must bind these policies to the public Build before claiming B45 acceptance.

## Review findings

`docs/work/REVIEW-MIDBUILD.md` assigns no finding to package 45. Its findings
#2, #3, #6, #7, and #10 belong to other packages/gates; the merged dependency
work and I2 receipt record their repairs and remaining integration scope.

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/audit-policy` — **PASS**, 10
  tests, 33 assertions.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 582 passed, 1 skipped,
  0 failed, 4,432 assertions across 583 tests / 75 files. The one skip is the
  real Linux mount test, unavailable on this macOS host.
- Exact B45 frozen command from the brief — **not executable / pending
  integration**. Result: 14 cases, 14 instances; 0 pass, 0 assertion failures,
  14 harness launch errors, 0 skipped or unimplemented. Each failed before CLI
  execution because `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/45-observational-audits-and-deterministic-selector/dist/kogen`
  does not exist. No provider request reached the fake server; unmatched fake
  requests were not evaluable because no request was issued. Result file:
  `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-45-z85msB/results.jsonl`.
  The official command was run once and not retried.
- Replay is not assigned to B45: hand cases run 0; seeds 17/23/41 not run; first
  divergence not applicable.
- Host: macOS 26.7.1 / build 25G241, Darwin 25.6.0, arm64; Git 2.54.0, Bun
  1.4.2, Python 3.14.7. Linux execution is unverified.
- Active effort: approximately 27 minutes; about 2.5 minutes spent waiting for
  the two full checks. Model: GPT-6 Codex; exact served variant and token count
  are not exposed by this worker interface.

## Historical v1.2 assertions and v1.3 reconciliation

Manual review covered all fourteen named B45 cases and their exact overlay
assertions. The command could not execute them, so no case is recorded as a
pass or as an observed assertion failure.

| Cases | Historical assertion | v1.3-draft disposition |
|---|---|---|
| `v1.2-73-ladder-05`, `v1.2-74-ladder-06`, `v1.2-75-ladder-07` | An `over_strict` A2 is demoted; `green-or-advisory` can land and report `green-with-advisory-tests`, while `land: green` parks that demoted verdict. | Direct version conflict. A2 remains binding, `demoted` is false, advisory items stay empty, and neither policy admits the red tree. |
| `v1.2-79-ladder-11` | The ended R1 is rescored after demotion and lands as advisory without repair or a new rung. | Direct version conflict. Audit advice cannot rescore the verified gate or grant landing. |
| `v1.2-76-ladder-08` | A citation-bearing `infeasible` response is normalized to `valid` and emits `acceptance_upheld`. | The target verdict set is `valid`, `over_strict`, or `contradicts`; unknown/garbled advice warns. The target event catalog has no `acceptance_upheld` event. The old verdict/schema and event assertions need a versioned migration; its red repair outcome is compatible. |
| `v1.2-77-ladder-09` | Malformed auditor JSON demotes nothing and the red candidate stays unverified. | Compatible in outcome; the v1.3 receipt additionally records a warning. |
| `v1.2-78-ladder-10` | All-change-items-demoted title, but assertions only require failure, no landing preparation, and an unchanged base ref. | Compatible in outcome: actual failing items still block landing. The title does not establish a required demotion behavior. |
| `v1.2-81-ladder-13`, `v1.2-82-ladder-14`, `v1.2-83-ladder-15`, `v1.2-84-ladder-16`, `v1.2-85-ladder-17`, `v1.2-91-ladder-23` | Select R1 by item count; select R2 by fewer findings or smaller diff / earlier rung; retain and emit the best unverified diff; retain per-rung candidate refs. | Their asserted outcomes align with the target's real-result ranking and unverified-candidate retention by inspection. They remain unverified until the public command runs. |
| `v1.2-96-ladder-28` | Exactly one test-auditor request and one audit event across the Build. | Target §3.8.2 places an audit in an acceptance-only red rung but does not state whether the historical once-per-Build limit remains. Resolve this in the versioned suite/spec before treating the old request-count assertion as a target requirement. |

The target is v1.3-draft only. The current v1.2 cases are historical evidence;
no v1.3 parity or full B45 conformance is claimed.

## Integration and next owner

The CLI artifact and merged I2 acceptance are missing, and the exact suite run
failed before launching `kogen`. Coordinator/I4 must wire the audit and selector
into the production red ladder, prove the I2 public Build path, then rerun the
exact B45 cases. The spec/suite owner should resolve the audit-frequency
question for `v1.2-96-ladder-28` in the versioned v1.3 oracle. Linux validation
and mandatory replay remain later platform/gate work.
