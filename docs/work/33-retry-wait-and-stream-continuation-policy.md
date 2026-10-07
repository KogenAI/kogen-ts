# 33-retry-wait-and-stream-continuation-policy

Goal: Retry/wait and stream-continuation policy. Limit: 90 active minutes.

Dependencies: 28,29,30

## Owned files

`packages/core/src/provider/retry/{transition,respond}.ts; tests/retries/**`

## Goal

One versioned retry table, jitter/overload streak/attempt caps/no planner fallback/provider-specific switch; partial progress appended, paused budgets and stopped results.

## Acceptance

B33; fake-clock matrix and no partial-call execution; public cases close I2/I4/I5.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-33-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'cli-30,shape-24,shape-25,v1.2-103-ladder-35,v1.2-112-provider-11,v1.2-113-provider-12,v1.2-114-provider-14,v1.2-115-provider-17,v1.2-116-provider-18,v1.2-125-ladder-36,v1.2-28-provider-13-planner-no-fallback,v1.2-29-provider-15-idle-stall,v1.2-30-provider-16-total-cap,v1.2-90-ladder-22' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/33-retry-wait-and-stream-continuation-policy.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
