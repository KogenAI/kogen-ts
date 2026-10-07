# 31-read-search-write-edit-tool-boundary

Goal: Read/search/write/edit tool boundary. Limit: 90 active minutes.

Dependencies: 03,04,19,30

## Owned files

`packages/core/src/provider/tools/{schema,files,dispatch}.ts; tests/file-tools/**`

## Goal

Canonical schema union; role allowlists; read lines/search/write limits, approved-path errors and safe in-root links; unknown tools and schema guard.

## Acceptance

B31; incomplete/partial proposals cannot dispatch.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-31-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'provider-24,provider-26,v1.2-118-provider-25' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/31-read-search-write-edit-tool-boundary.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
