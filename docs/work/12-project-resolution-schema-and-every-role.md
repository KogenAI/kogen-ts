# 12-project-resolution-schema-and-every-role

Goal: Project resolution, schema and every role. Limit: 90 active minutes.

Dependencies: 11,15

## Owned files

`packages/core/src/project/{resolve,schema,roles}.ts; tests/project/**`

## Goal

Canonical checkout/origin/base; closed schema, field-wise role precedence/provider resolution and draft fallback rules; named-role table and config diagnostics.

## Acceptance

B12; all used roles override/default/provider tests; fallback_shaper remains unknown; cross-provider model refused; auditor_demotion true refused with `build.auditor_demotion has no admitted calibration`.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-12-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'cli-23,state-03,state-13,state-16,v1.2-35-state-02-schema-errors' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/12-project-resolution-schema-and-every-role.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
