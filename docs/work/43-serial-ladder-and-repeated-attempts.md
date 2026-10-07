# 43-serial-ladder-and-repeated-attempts

Goal: Serial ladder and repeated attempts. Limit: 90 active minutes.

Dependencies: 12,39,41,42

## Owned files

`packages/core/src/build/{ladder,attempts}.ts; tests/ladder/**`

## Goal

Recipe/rung defaults and config, fresh workspace per rung, shared plan/earlier summaries, escalation/repeats, max_rungs/R4 admission, per-rung repair resets.

## Acceptance

B43; freeze experimental R4/repeat contradictions before tests.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-43-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-102-ladder-34,v1.2-68-build-44,v1.2-70-ladder-02,v1.2-72-ladder-04,v1.2-80-ladder-12,v1.2-88-ladder-20,v1.2-89-ladder-21,v1.2-94-ladder-26,v1.2-95-ladder-27,v1.2-98-ladder-30,v1.2-99-ladder-31' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/43-serial-ladder-and-repeated-attempts.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
