# 25-status-derivation-and-renderers

Goal: Status derivation and renderers. Limit: 90 active minutes.

Dependencies: 13,21,23,24

## Owned files

`packages/core/src/status/{derive,report,render,watch}.ts; tests/status/**`

## Goal

Reachable landed precedence, current approval runs, blocked/next/interrupted, all JSON fields/nulls, five-history window, streaming watch. Resolve slug reuse from frozen version.

## Acceptance

B25; synthetic status and 50-intent/200-run timing now; live watch after I2.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-25-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'cli-28,state-17,state-19,state-24,state-30,v1.2-129-cli-27,v1.2-131-state-12,v1.2-132-state-23,v1.2-137-format-12,v1.2-22-cli-25-status-overview,v1.2-23-cli-26-status-slug,v1.2-25-state-20-status-next,v1.2-26-state-22-status-next,v1.2-27-approval-18-status-next,v1.2-92-ladder-24,v1.2-93-ladder-25' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/25-status-derivation-and-renderers.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
