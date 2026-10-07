# 04-safe-publication-restore-and-removal

Goal: Safe publication, restore and removal. Limit: 90 active minutes.

Dependencies: 03

## Owned files

`native/{publish.c,publish.h}; packages/core/src/fs/{publish,restore}.ts; tests/fs-publish/**`

## Goal

Exclusive temps, mode 0600/0700, append, rename+fsync ordering, no-follow restore/removal; preserve executable and link types.

## Acceptance

Symlink parents/finals and rename crash matrix; external sentinel unchanged.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/04-safe-publication-restore-and-removal.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
