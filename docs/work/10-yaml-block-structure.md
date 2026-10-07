# 10-yaml-block-structure

Goal: YAML block structure. Limit: 90 active minutes.

Dependencies: 09

## Owned files

`packages/core/src/yaml/block.ts; tests/yaml-block/**`

## Goal

Maps, deeper block sequences, indentation, duplicate/merge/empty values, scalar strings and depth limit.

## Acceptance

Block/depth/duplicate fixtures; B11 closed by flow/schema integration.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/10-yaml-block-structure.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
