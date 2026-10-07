# 29-http-deadline-and-sticky-routing-port

Goal: HTTP, deadline and sticky routing port. Limit: 90 active minutes.

Dependencies: 23,28

## Owned files

`packages/core/src/provider/http/{transport,deadline,routing}.ts; tests/http/**`

## Goal

Streaming fetch, cancellation, first-body-byte starts before auth/connect, idle/total bounds, bounded error bodies, endpoint seams and sticky headers in persistent context.

## Acceptance

Fake slow headers/body/comment/stall/abort; routing continuity; B33 later.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/29-http-deadline-and-sticky-routing-port.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
