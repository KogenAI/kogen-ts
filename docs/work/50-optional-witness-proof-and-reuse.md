# 50-optional-witness-proof-and-reuse

Goal: Optional witness proof and reuse. Limit: 90 active minutes.

Dependencies: 39,44,45,48

## Owned files

`packages/core/src/shape/witness.ts; packages/core/src/build/witness.ts; tests/witness/**`

## Goal

Throwaway R1/hardR2 real gate with no demotion, bounded adjudication/test-vs-witness repair; immutable witness/ref/diff bind; reverify on current base before zero-model landing.

## Acceptance

B50; proof refused when unproven; stale witness runs normal ladder; narrow to two packets if 90min exceeded.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-50-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-100-ladder-32,v1.2-101-ladder-33,v1.2-135-shape-26' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/50-optional-witness-proof-and-reuse.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
