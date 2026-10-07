# 00-scaffold-and-input-freeze

Goal: Scaffold and input freeze. Limit: 60 active minutes.

Dependencies: none

## Owned files

`Root manifests/config/Makefile; spec-lock/**; packages/*/package.json; packages/core/src/contracts/{ports,events,errors,clock}.ts; tools/{check,freeze,dispatch}.ts`

## Goal

Freeze e19dd1c draft plus working-tree content hashes and CHANGES-v1.3; pin tools/lock; hermetic runner; typed ports. Adapt the Rust dispatch method to a DAG/receipt-aware local dispatcher with dry-run, no automatic push or failed-worktree deletion; integration hooks are completed by the rounds. No behavior stubs may be counted as accepted.

## Acceptance

Version/blank-HOME/no-network check smoke; source-hash receipt.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/00-scaffold-and-input-freeze.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
