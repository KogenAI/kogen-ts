# 62-compiled-artifacts-and-operator-docs

Goal: Compiled artifacts and operator docs. Limit: 75 active minutes.

Dependencies: 37,42,50,51,52,54,55,56,61,64,65

## Owned files

`tools/{build,artifact}.ts; docs/{INSTALL,ARCHITECTURE}.md; tests/compiled/**`

## Goal

Native per-OS CLI/xspec/helper builds, helper hash/location manifest, no runtime resolver/download; compiled signals/detach/version and install instructions.

## Acceptance

Source/compiled equivalent smoke; artifact hashes and clean host prerequisite receipt.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/62-compiled-artifacts-and-operator-docs.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I6.
