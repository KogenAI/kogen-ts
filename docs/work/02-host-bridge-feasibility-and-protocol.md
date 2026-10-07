# 02-host-bridge-feasibility-and-protocol

Goal: Host bridge feasibility and protocol. Limit: 90 active minutes.

Dependencies: 00

## Owned files

`native/{main.c,protocol.c,protocol.h,host.h}; packages/core/src/process/host.ts; tests/host-bridge/**`

## Goal

Prove bounded binary frames, private pipes/control EOF, fd inheritance, compiled helper lookup on macOS and Linux. Spike parent-kill group cleanup before committing architecture. Shared registration edits transfer to integrator after merge.

## Acceptance

Kill/pipe/framing spike on both OS; fail design gate if unavailable.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/02-host-bridge-feasibility-and-protocol.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
