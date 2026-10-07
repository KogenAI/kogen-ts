# 52-rails-adapter

Goal: Rails adapter. Limit: 90 active minutes.

Dependencies: 17,18

## Owned files

`packages/core/src/adapters/rails/**; tests/rails-adapter/**`

## Goal

Two-file detection, command+ledger bridge, ruby syntax/standard/rubocop, offline setup seeds/env/gate paths and Minitest findings.

## Acceptance

Local P12 and fake argv/ledger fixtures; optional actual Rails fixture receipt.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/52-rails-adapter.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
