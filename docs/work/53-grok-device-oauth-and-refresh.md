# 53-grok-device-oauth-and-refresh

Goal: Grok device OAuth and refresh. Limit: 90 active minutes.

Dependencies: 29,34,36

## Owned files

`packages/core/src/provider/auth/grok/**; tests/grok-auth/**`

## Goal

Discovery/endpoint validation, code prompt, first poll delay/pending/slow_down/expiry, stale refresh locks/rotation and local-only logout.

## Acceptance

Local P10 device/auth fixtures, no borrowed Grok credentials.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/53-grok-device-oauth-and-refresh.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
