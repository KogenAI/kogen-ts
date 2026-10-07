# 61-diagnostic-replay-adapters

Goal: Diagnostic replay adapters. Limit: 90 active minutes.

Dependencies: 45,46,54,57

## Owned files

`packages/xspec/src/slices/{accounts,gate,orchestration,setup-cache}.ts; tests/xspec-diagnostics/**`

## Goal

Thin maps to production policies/effects; current L/E classifications printed into receipts; no legacy resilience/prototype release pass.

## Acceptance

Diagnostic full observations; unsupported fields explicitly fail; never augment mandatory count.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/61-diagnostic-replay-adapters.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.

Replay slices: accounts, gate, orchestration, setup-cache. Diagnostic only. Copy spec-lock/kogen-spec/quint to private scratch, provision its pinned dependencies before checks, then run from copied quint/prototype:

```sh
for slice in accounts gate orchestration setup-cache; do
  XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
  for seed in 17 23 41; do
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```
Keep seed-separated copies/receipts; never overwrite the bundle or use mismatched draft observations.
