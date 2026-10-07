# 47-shape-conversation-loop-and-accounting

Goal: Shape conversation loop and accounting. Limit: 90 active minutes.

Dependencies: 14,17,30,31,33,34,46

## Owned files

`packages/core/src/shape/{controller,conversation,counters}.ts; tests/shape-loop/**`

## Goal

One primary RequestContext and one fallback context; shape-v1.3 counter rules (3passes/60turns/2style each), turn OR pass exhaustion starts fallback once, last-turn success, alias effective shaper/provider; schema1 shape-accounting.json on success/failure with separate auditor/HTTP/unknown-usage totals.

## Acceptance

B47; primary+fallback prefix continuity, no loss of interrupted/controller input.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-47-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'format-07,shape-01,shape-03,shape-04,shape-05,shape-06,shape-07,shape-08,shape-09,shape-10,shape-11,shape-12,shape-13,shape-23' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/47-shape-conversation-loop-and-accounting.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
