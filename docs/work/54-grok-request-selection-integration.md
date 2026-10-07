# 54-grok-request-selection-integration

Goal: Grok request/selection integration. Limit: 90 active minutes.

Dependencies: 12,30,33,53

## Owned files

`packages/core/src/provider/grok/**; tests/grok-wire/**`

## Goal

Exact wire/headers/new requestUUID, provider-aware roles/fallback stays Grok, error sentence mapping, same append/usage policy.

## Acceptance

Local P10 and Grok-pass4; accounts diagnostic at 61; no ChatGPT endpoint fallback.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/54-grok-request-selection-integration.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
