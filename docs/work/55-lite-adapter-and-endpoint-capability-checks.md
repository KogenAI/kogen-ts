# 55-lite-adapter-and-endpoint-capability-checks

Goal: Lite adapter and endpoint capability checks. Limit: 90 active minutes.

Dependencies: 30,34

## Owned files

`packages/core/src/provider/lite/**; tests/lite/**`

## Goal

Injected Luna-only shape/id/header/schema order, owned/cap incompatibilities and rejection before credential load; unchanged affinity vs protocol session ID.

## Acceptance

Local P6 and unknown endpoint cap fixtures; replay does not infer unsupported capabilities.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/55-lite-adapter-and-endpoint-capability-checks.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
