# 20-approval-preflight-and-card

Goal: Approval preflight and card. Limit: 90 active minutes.

Dependencies: 14,17,18,19,23

## Owned files

`packages/core/src/approval/{preflight,card}.ts; tests/approval-preflight/**`

## Goal

Hash-first refusal, stage/setup/check/baseline/card, warnings, red acceptance refusal and always restore scratch. Cache port binds checked tree, using scratch exact-base checks when checkout differs.

## Acceptance

B20; no check on mismatch and no checkout mutation.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-20-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'approval-01,approval-03,approval-08,approval-09,approval-10,approval-11,approval-12,approval-13,approval-17,approval-19,approval-20,format-08,state-25' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/20-approval-preflight-and-card.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
