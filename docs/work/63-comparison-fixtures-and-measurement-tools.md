# 63-comparison-fixtures-and-measurement-tools

Goal: Comparison fixtures and measurement tools. Limit: 90 active minutes.

Dependencies: 62

## Owned files

`tools/{measure,compare,receipt}.ts; docs/COMPARISON.md; tests/comparison/**`

## Goal

Frozen task/role/prompt/protocol receipts, fake startup/serialize/Git/CPU/RSS metrics, cache eligible-prefix/raw usage accounting, worker-effort totals. No live dispatch in this packet.

## Acceptance

Deterministic mock three-arm report; missing usage/infra retained; no invented USD/live gate.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/63-comparison-fixtures-and-measurement-tools.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
