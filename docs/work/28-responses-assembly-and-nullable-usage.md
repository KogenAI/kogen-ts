# 28-responses-assembly-and-nullable-usage

Goal: Responses assembly and nullable usage. Limit: 90 active minutes.

Dependencies: 27

## Owned files

`packages/core/src/provider/sse/{assemble,usage}.ts; tests/sse-assembly/**`

## Goal

Completed precedence, duplicate/error/incomplete/malformed handling; retain raw partial items; validate function arguments, usage counts and no incomplete execution.

## Acceptance

B28; complete/failure/partial precedence matrix.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-28-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-108-provider-06,v1.2-109-provider-07,v1.2-110-provider-08,v1.2-111-provider-09' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/28-responses-assembly-and-nullable-usage.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
