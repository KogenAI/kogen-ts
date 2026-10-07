# 27-sse-byte-framing

Goal: SSE byte framing. Limit: 75 active minutes.

Dependencies: 00

## Owned files

`packages/core/src/provider/sse/framing.ts; tests/sse-framing/**`

## Goal

Chunked CRLF/CR/data lines/comments/DONE/EOF; bounded 16MiB byte accounting and incremental decode.

## Acceptance

Boundary-split framing corpus; B28 closes assembly behavior later.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/27-sse-byte-framing.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
