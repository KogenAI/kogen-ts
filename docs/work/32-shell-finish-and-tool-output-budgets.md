# 32-shell-finish-and-tool-output-budgets

Goal: Shell, finish and tool-output budgets. Limit: 90 active minutes.

Dependencies: 06,23,31

## Owned files

`packages/core/src/provider/tools/{shell,finish,output}.ts; tests/shell-tools/**`

## Goal

Private script supervision; UTF8-aware head/tail/ranges/nonUTF8 base64, SHA256 regular-file handles; finish-alone {}, text continuation/first empty finish.

## Acceptance

B32; 300KiB heredoc, exact notices and full bytes on disk.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-32-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-121-custody-08,v1.2-31-provider-23-tool-result-budget' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/32-shell-finish-and-tool-output-budgets.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
