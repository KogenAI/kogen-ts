# 11-yaml-flow-collections-and-parser-facade

Goal: YAML flow collections and parser facade. Limit: 90 active minutes.

Dependencies: 09,10

## Owned files

`packages/core/src/yaml/{flow,parse}.ts; tests/yaml-flow/**`

## Goal

Multiline flow maps/lists with quote/comment boundaries; unify earliest error selection and full subset parser.

## Acceptance

B11; no general YAML acceptance beyond §2.6.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-11-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'state-01,v1.2-128-format-05' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/11-yaml-flow-collections-and-parser-facade.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
