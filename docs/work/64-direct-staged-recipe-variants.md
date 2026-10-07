# 64-direct-staged-recipe-variants

Goal: Direct/staged recipe variants. Limit: 90 active minutes.

Dependencies: 31,32,38,39,43

## Owned files

`packages/core/src/build/recipes/{direct,staged}.ts; tests/recipe-variants/**`

## Goal

Explicit no-plan/direct tools and unique edit/200-line write, context+review stages/roles and shell recipe variants; same gate/claim/landing machinery.

## Acceptance

Local all-admitted-recipe config/role/fake-task tests; no change to frozen public tree.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/64-direct-staged-recipe-variants.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
