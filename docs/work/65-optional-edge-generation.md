# 65-optional-edge-generation

Goal: Optional edge generation. Limit: 90 active minutes.

Dependencies: 44,45,64

## Owned files

`packages/core/src/build/edge.ts; tests/edge/**`

## Goal

Request-derived optional tests; failure blocks landing; parallel candidates run each other’s edge tests before deterministic selection. Defaults remain off.

## Acceptance

Local opt-in edge/cross-test fake fixtures; report experimental scope separately.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/65-optional-edge-generation.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
