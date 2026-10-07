# 45-observational-audits-and-deterministic-selector

Goal: Observational audits and deterministic selector. Limit: 90 active minutes.

Dependencies: 18,30,33,43

## Owned files

`packages/core/src/build/{audit,select}.ts; tests/audit-policy/**`

## Goal

Default audit cannot demote/score/land; score real item results and retain best unverified diff. Default land green and legacy green-or-advisory identical; auditor_demotion true refused without calibration; no fake mode or enabled legacy toggle.

## Acceptance

B45 historical/version conflicts; D1 default safety fixture and experiment-off tests.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-45-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-73-ladder-05,v1.2-74-ladder-06,v1.2-75-ladder-07,v1.2-76-ladder-08,v1.2-77-ladder-09,v1.2-78-ladder-10,v1.2-79-ladder-11,v1.2-81-ladder-13,v1.2-82-ladder-14,v1.2-83-ladder-15,v1.2-84-ladder-16,v1.2-85-ladder-17,v1.2-91-ladder-23,v1.2-96-ladder-28' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/45-observational-audits-and-deterministic-selector.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
