# 41-moved-base-landing-repairs

Goal: Moved-base landing repairs. Limit: 90 active minutes.

Dependencies: 33,39,40

## Owned files

`packages/core/src/build/landing/{rebase,retry}.ts; tests/landing-rebase/**`

## Goal

Lost CAS/.lock backoff, moved-base rebase/full gate, same winning conversation repairs and separate landing allowance; preserve best if parked.

## Acceptance

B41; conflicting move, red re-gate and late checkout edit.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-41-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-58-build-24,v1.2-59-build-25,v1.2-60-build-26,v1.2-61-build-27,v1.2-62-build-28,v1.2-63-build-29,v1.2-87-ladder-19' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/41-moved-base-landing-repairs.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
