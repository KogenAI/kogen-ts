# 57-xspec-approval-and-intent-effects

Goal: xspec approval and Intent effects. Limit: 90 active minutes.

Dependencies: 21,22,30

## Owned files

`packages/xspec/src/{protocol,main}.ts; packages/xspec/src/slices/{approve,intent}.ts; packages/test-support/src/approval-fixture.ts; tests/xspec-approval/**`

## Goal

Long-lived reset/apply/error protocol, real source-byte/hash/CAS fixture driver and full observations; document symbolic fixture identities.

## Acceptance

Mandatory approve+intent hand and seed matrix at I3; late-mutation/no-write real-Git tests.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/57-xspec-approval-and-intent-effects.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.

Replay slices: approve, intent. Mandatory. Copy spec-lock/kogen-spec/quint to private scratch, provision its pinned dependencies before checks, then run from copied quint/prototype:

```sh
for slice in approve intent; do
  XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
  for seed in 17 23 41; do
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```
Keep seed-separated copies/receipts; never overwrite the bundle or use mismatched draft observations.
