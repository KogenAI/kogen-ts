# Packet 10 — YAML block structure

- Status: AWAITING_INTEGRATION
- Base SHA: `8e168d0f987615e88e1301258bd6e986259d93be`
- Tested implementation head: `9dbbe300d8078028e211254a58d390ff86ac5283`
- Active effort: approximately 30 minutes
- Model: GPT-6; exact serving variant is not exposed by this runtime.
- Tokens: not exposed by this runtime.

## Changed behavior

- Added a block parser that builds string-valued maps and sequences, including
  nested sequences, sequence mapping items, compact nested lists, and deeper
  block values. Maps use `Map` keys so names such as `__proto__` remain data.
- Decoded the supported quoted scalar escapes and single-quote doubling; plain
  numeric and boolean-looking values remain strings. Empty quoted values and
  deeper values are represented, while keys and list items with no value are
  diagnosed.
- Detected decoded duplicate map keys and rejected unexpected/indentless
  indentation. Merge-key errors continue to come from packet 09 lexical checks.
- Enforced a combined 64-collection limit across block ancestors and preserved
  flow collections with source location as nodes for packet 11 to parse.

## Owned files

- `packages/core/src/yaml/block.ts`
- `tests/yaml-block/block.test.ts`
- `docs/work/receipts/10-yaml-block-structure.md`

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null KOGEN_CREDENTIAL_STORE=file bun test
  --max-concurrency 1 ./tests/yaml-block`: PASS; 13 test instances, 32
  assertions, 0 failures, 0 unmatched fake requests. Cases covered block maps
  and scalar decoding; deeper sequences and map items; nested/empty values;
  flow-node preservation; duplicate and merge keys; missing values; root,
  unexpected and indentless indentation; and depth 64/65.
- The first local run had 12 passes and one failure in the flow-node preservation
  case because a flow map was classified as a block map. The dispatch was fixed;
  the final named local run above passed all cases.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS; Biome, strict TypeScript,
  shell syntax, input freeze, dispatcher checks, and isolated tests passed. Full
  suite result: 90 tests, 0 failures, 1,498 assertions. An earlier check found
  formatting and test type-inference issues; those were fixed before the passing
  run.
- `git diff --check`: PASS.
- Official conformance: not run. Packet 10 has no standard B-set and the public
  parser/CLI route is not wired. Cases: 0 run; instances: 0; failures: 0;
  unmatched fake requests: 0. This is pending integration, not a pass.
- Replay: not assigned. Hand scenarios: 0; seeds 17, 23, and 41: not run; first
  divergence: not applicable.

## Pending integration and gaps

- B11 remains pending packet 11's flow parser/facade and coordinator wiring.
  This receipt does not claim reducer-only or CLI acceptance.
- No incompatible frozen v1.2 YAML assertion was identified in the local cases;
  official B11 assertions were not run, so no compatibility claim is made.
- Tested on macOS 26.7.1 (25G241), arm64, Bun 1.4.2, Git 2.54.0. Linux
  validation remains pending.

Next owner: packet 11 for flow collections and parser facade; coordinator for
public schema/CLI integration and B11 closure.
