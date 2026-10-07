# 49-assumptions-and-shared-contract-recheck

Goal: Assumptions and shared-contract recheck. Limit: 75 active minutes.

Dependencies: 12,21,38,48

## Owned files

`packages/core/src/intent/predicates.ts; packages/core/src/build/prestart.ts; tests/predicates/**`

## Goal

Validate base predicates on approval; blocks_on landed before Build; observable stale status/recheck event; skip empty predicates and never re-Shape started Build.

## Acceptance

Local P11/predicate tests; new frozen draft pre-start/status rule, no invented public flag.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/49-assumptions-and-shared-contract-recheck.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
