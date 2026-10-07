# 59-xspec-rebase-and-recovery

Goal: xspec rebase and recovery. Limit: 90 active minutes.

Dependencies: 26,41,57

## Owned files

`packages/xspec/src/slices/{rebase,recovery}.ts; packages/test-support/src/landing-fixture.ts; tests/xspec-landing/**`

## Goal

Shared controllers, explicit CAS effects plus temp origins, durable crash/preservation effect observations; regenerate draft models externally first.

## Acceptance

Mandatory rebase+recovery hand/seeds; matches public crash-phase tests.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/59-xspec-rebase-and-recovery.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.

Replay slices: rebase, recovery. Mandatory. Copy spec-lock/kogen-spec/quint to private scratch, provision its pinned dependencies before checks, then run from copied quint/prototype:

```sh
for slice in rebase recovery; do
  XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
  for seed in 17 23 41; do
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```
Keep seed-separated copies/receipts; never overwrite the bundle or use mismatched draft observations.
