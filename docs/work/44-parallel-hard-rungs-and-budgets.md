# 44-parallel-hard-rungs-and-budgets

Goal: Parallel hard rungs and budgets. Limit: 90 active minutes.

Dependencies: 43

## Owned files

`packages/core/src/build/{parallel,budget}.ts; tests/parallel/**`

## Goal

Hard R1/R2 truly concurrent, independent workspaces/conversations, green winner/cancel loser, active wall versus pauses, final snapshot on cancellation.

## Acceptance

B44; barrier-proven overlap, deterministic ties and stopped member cleanup.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-44-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-71-ladder-03,v1.2-86-ladder-18' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/44-parallel-hard-rungs-and-budgets.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
