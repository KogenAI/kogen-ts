# 60-xspec-stream-and-session

Goal: xspec stream and session. Limit: 75 active minutes.

Dependencies: 30,33,57

## Owned files

`packages/xspec/src/slices/{stream,session}.ts; tests/xspec-provider/**`

## Goal

Production retry/session steps, fake clock/outcomes, complete observations plus real wire bytes/headers/nullable usage and fallback reasoning removal.

## Acceptance

Mandatory stream+session hand/seeds, three-turn/retry/model-switch wire checks.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/60-xspec-stream-and-session.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.

Replay slices: stream, session. Mandatory. Copy spec-lock/kogen-spec/quint to private scratch, provision its pinned dependencies before checks, then run from copied quint/prototype:

```sh
for slice in stream session; do
  XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
  for seed in 17 23 41; do
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```
Keep seed-separated copies/receipts; never overwrite the bundle or use mismatched draft observations.
