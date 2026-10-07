# 48-shape-validation-ledger-and-audits

Goal: Shape validation, ledger and audits. Limit: 90 active minutes.

Dependencies: 18,19,35,47

## Owned files

`packages/core/src/shape/{validate,ledger,audit,artifacts}.ts; tests/shape-validation/**`

## Goal

Normalize/parse/lint/gate/formatter/staged checks/base red-reclassification; requirement ledger+test audit every eligible pass, coverage repair/warning order and safe artifacts.

## Acceptance

B48; configured adapter; ledger gap must not suppress test audit; exact feedback journals.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-48-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'shape-15,shape-16,shape-17,shape-18,shape-21' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/48-shape-validation-ledger-and-audits.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I2.
