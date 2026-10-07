# Packet 11 — YAML flow collections and parser facade

## Source and effort

- Base SHA: `002afead1bc222abd01d299c3a654bcd00824975`
- Implementation head SHA: `224e7d81543d64a8220874bb1b35c9ddc1134459`
- Target: spec v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen conformance suite v1.2.
- Active effort: approximately 17 minutes.
- Model: Codex / GPT-6; served model variant and token count are not exposed by this runtime.

## Changed behavior

Added a flow collection parser for nested and multiline flow maps/lists. It preserves quoted delimiters and hashes, accepts comments at the lexical boundaries in §2.6, keeps all scalars as strings, and reports duplicate keys, missing values, malformed/mismatched collections, unterminated collections and trailing text. The parser facade runs lexical, block and flow parsing and selects the earliest issue using the normative line and error-class order.

## Owned files

- `packages/core/src/yaml/flow.ts`
- `packages/core/src/yaml/parse.ts`
- `tests/yaml-flow/flow.test.ts`
- `docs/work/receipts/11-yaml-flow-collections-and-parser-facade.md`

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS. Biome, TypeScript, freeze/dispatch checks and all 121 repository tests passed.
- `bun test --max-concurrency 1 tests/yaml-lex/lex.test.ts tests/yaml-block/block.test.ts tests/yaml-flow/flow.test.ts`: PASS, 49 tests, 0 failures, 99 assertions.
- Required conformance invocation selected `state-01,v1.2-128-format-05` with the full specified profiles and `--jobs 3 --time-scale 0.02`: runner ERROR before starting Kogen because `$ROOT/dist/kogen` is absent. `state-01`: 0/20 passed, 20 harness errors. `v1.2-128-format-05`: 0/24 passed, 24 harness errors. All 44 expanded instances failed to spawn for the same `FileNotFoundError`; 0 fake requests were made or left unmatched. This is pending command wiring, not a parser pass or parser assertion failure. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-11-RCiP3b/results.jsonl`.
- Replay: not assigned to B11; no hand scenarios, seeds, or first divergence apply.

## Gaps and next owner

The public CLI is not wired to this parser in the bootstrap and no `dist/kogen` executable exists. Integration owner: compose the parser into the project/config reader, produce the runnable CLI, and rerun the exact two-case conformance selection. B11 remains awaiting integration acceptance. The current host was macOS 26.7.1 arm64; Linux was not tested. The selected frozen suite is v1.2 while the implementation target is the v1.3 draft; no incompatible B11 assertion is known, and this receipt does not claim v1.3 parity.
