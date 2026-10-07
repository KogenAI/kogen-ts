# 56-opt-in-context-checkpoints

Goal: Opt-in context checkpoints. Limit: 90 active minutes.

Dependencies: 30,33,39

## Owned files

`packages/core/src/build/checkpoint.ts; tests/checkpoint/**`

## Goal

No-tool summarizer epoch, validated continuation marker/size, retained approved bytes/plan/worktree/caps, new checkpoint digest epoch and unchanged affinity.

## Acceptance

Local P13 and corrupt/empty/oversized stop; no silent turn/budget reset.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/56-opt-in-context-checkpoints.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
