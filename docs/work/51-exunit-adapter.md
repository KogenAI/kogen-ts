# 51-exunit-adapter

Goal: ExUnit adapter. Limit: 90 active minutes.

Dependencies: 17,18

## Owned files

`packages/core/src/adapters/exunit/**; tests/exunit-adapter/**`

## Goal

Source/staging paths, external ledger formatter, mise invocation, failure parsers, formatter selection and unavailable first20-lines rule.

## Acceptance

Six optional exunit-tier cases plus exact argv/finding fixtures; report separately from236.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-exunit-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$ROOT/spec-lock/kogen-conformance/bin/kogen-conformance" run \
  --kogen "$ROOT/dist/kogen" --profile exunit --jobs 1 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```
Report six ExUnit-tier cases separately from the standard 236.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/51-exunit-adapter.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
