# 58-xspec-queue-and-status

Goal: xspec queue and status. Limit: 75 active minutes.

Dependencies: 24,25,57

## Owned files

`packages/xspec/src/slices/{queue,status}.ts; tests/xspec-queue-status/**`

## Goal

Decode events, inject owner/build/ref observations into shared scheduler/deriver; full ordered results, no observation projection.

## Acceptance

Mandatory queue+status hand/seeds; malformed/unknown protocol nonzero.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/58-xspec-queue-and-status.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.

Replay slices: queue, status. Mandatory. Copy spec-lock/kogen-spec/quint to private scratch, provision its pinned dependencies before checks, then run from copied quint/prototype:

```sh
for slice in queue status; do
  XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
  for seed in 17 23 41; do
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```
Keep seed-separated copies/receipts; never overwrite the bundle or use mismatched draft observations.
