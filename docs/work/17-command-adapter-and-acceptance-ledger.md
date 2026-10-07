# 17-command-adapter-and-acceptance-ledger

Goal: Command adapter and acceptance ledger. Limit: 90 active minutes.

Dependencies: 05,06,16

## Owned files

`packages/core/src/adapters/{interface,command}.ts; packages/core/src/gate/ledger.ts; tests/ledger/**`

## Goal

Source/candidate paths, staging, JSONL rows/tags/items, unavailable/compile/empty/malformed/timeout classifications and tree mutation detection.

## Acceptance

Ledger exit/report matrix; B18/B20 exercise production callers later.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/17-command-adapter-and-acceptance-ledger.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
