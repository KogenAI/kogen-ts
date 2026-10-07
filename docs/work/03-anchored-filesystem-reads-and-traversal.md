# 03-anchored-filesystem-reads-and-traversal

Goal: Anchored filesystem reads and traversal. Limit: 90 active minutes.

Dependencies: 02

## Owned files

`native/{paths.c,paths.h,read.c}; packages/core/src/fs/read.ts; tests/fs-read/**`

## Goal

Directory-fd traversal, no-follow controller paths, bounded in-root tool link resolution, byte paths; enumerate links as links.

## Acceptance

Parent-link swap, outside link, nonregular handle, invalid UTF-8 path fixtures.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/03-anchored-filesystem-reads-and-traversal.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
