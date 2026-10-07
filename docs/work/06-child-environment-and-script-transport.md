# 06-child-environment-and-script-transport

Goal: Child environment and script transport. Limit: 75 active minutes.

Dependencies: 05

## Owned files

`packages/core/src/process/{environment,script}.ts; tests/environment/**`

## Goal

Allowlisted base environment, exact project override/PATH, mise env timeout and isolated state/cache, private shell scripts and stdin.

## Acceptance

Host secrets/runtime paths absent; project timeout unscaled; large script bytes preserved.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/06-child-environment-and-script-transport.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
