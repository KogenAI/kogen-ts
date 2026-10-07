# 09-yaml-lexical-checks

Goal: YAML lexical checks. Limit: 90 active minutes.

Dependencies: 00

## Owned files

`packages/core/src/yaml/{lex,preflight}.ts; tests/yaml-lex/**`

## Goal

Byte cap/UTF-8/BOM/tabs/directives/markers; scalar quoting/comment/escape rules, line and normative error ordering.

## Acceptance

Normative yaml-errors lexical rows; input-byte boundary tests; B11 closed later.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/09-yaml-lexical-checks.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
