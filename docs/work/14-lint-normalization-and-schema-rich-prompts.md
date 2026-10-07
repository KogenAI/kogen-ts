# 14-lint-normalization-and-schema-rich-prompts

Goal: Lint, normalization and schema-rich prompts. Limit: 90 active minutes.

Dependencies: 12,13

## Owned files

`packages/core/src/intent/{lint,normalize}.ts; packages/core/src/shape/prompts.ts; tests/intent-lint/**`

## Goal

Normative lint word lists/style thresholds; Notes normalization/Request append; required title/size/domains template, optional keys and A<n>/tag examples.

## Acceptance

B14; prompt schema fixture parses; no Request lint/normalization damage.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-14-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'approval-21,format-02,format-03,format-04,state-05,v1.2-36-state-06-lint-card-warnings' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/14-lint-normalization-and-schema-rich-prompts.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
