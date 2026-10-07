# 18-checks-findings-and-gate-feedback

Goal: Checks, findings and gate feedback. Limit: 90 active minutes.

Dependencies: 17

## Owned files

`packages/core/src/gate/{checks,findings,verify,feedback}.ts; tests/gate/**`

## Goal

Fix once, checks+acceptance, base-relative excuses and stable identity count; full raw logs/findings and exact clipped feedback. Use frozen policy for contradictory baseline rules.

## Acceptance

B18; new test symbol, mutating base restoration, unavailable-on-base/current.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-18-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-136-format-10,v1.2-45-build-11,v1.2-46-build-12,v1.2-47-build-13,v1.2-48-build-14,v1.2-49-build-15,v1.2-50-build-16,v1.2-51-build-17,v1.2-52-build-18,v1.2-53-build-19,v1.2-54-build-20' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/18-checks-findings-and-gate-feedback.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
