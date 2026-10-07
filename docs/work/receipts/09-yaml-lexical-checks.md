# Packet 09 — YAML lexical checks

Status: AWAITING_INTEGRATION
Base SHA: `1e5d4cd54c6adedf7a1578112742722448324d21`
Tested implementation SHA: `92b39d1400017f27ea00713a49be1fa561f7d957`
Active effort: approximately 30 minutes
Model: GPT-6; exact serving variant and token count are not exposed by this runtime.

## Changed behavior

- Enforced the 1 MiB limit against input bytes, accepting exactly 1 MiB and
  rejecting larger inputs before decoding. UTF-8 validation, leading BOM and tab
  diagnostics retain source line numbers; CR, LF and CRLF are handled.
- Added quote-aware lexical scanning for comments, single and double quoted
  scalars, supported escapes, directives/document markers, anchors/aliases/tags,
  block scalar indicators, merge keys, plain `: ` values, list items in value
  positions, flow brackets embedded in a plain scalar, and empty documents.
- Centralized all 24 YAML error classes/messages in the frozen normative order.
  Issue selection uses earliest line first, then the frozen table order.

## Owned files

- `packages/core/src/yaml/lex.ts`
- `packages/core/src/yaml/preflight.ts`
- `tests/yaml-lex/lex.test.ts`
- `docs/work/receipts/09-yaml-lexical-checks.md`

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS on the tested implementation
  SHA. Biome, strict TypeScript, shell syntax, input freeze, dispatcher checks,
  and isolated tests passed. Full local run: 24 tests passed, 0 failed,
  1,286 assertions. The first check invocation reported Biome formatting/import
  order findings; those were fixed in owned files before the passing run.
- `GIT_CONFIG_GLOBAL=/dev/null KOGEN_CREDENTIAL_STORE=file bun test
  --max-concurrency 1 ./tests/yaml-lex`: PASS; 20 tests, 0 failures, 34
  assertions. Includes exact 1 MiB and 1 MiB + 1 byte checks, multi-byte UTF-8
  boundary, invalid UTF-8 line 3, BOM, tabs, comments/quotes/escapes, normative
  lexical rows, and precedence.
- Official conformance: not run. This packet has no assigned B-set; there is no
  executable CLI/parser facade yet. Cases: 0; expanded instances: 0; unmatched
  fake requests: 0 (no provider endpoint used).
- Replay: not assigned. Hand scenarios: 0; seeds 17, 23 and 41: not run;
  first divergence: not applicable.

## Pending integration and gaps

- Public CLI/project parser behavior and B11 remain pending integration; local
  lexical checks do not establish integrated acceptance. Packet 10 owns the next
  YAML layer; packet 11 closes B11 with the parser facade.
- Linux validation remains pending. This run used macOS 26.7.1 (25G241), arm64,
  Bun 1.4.2 and Git 2.54.0.
- No v1.2 or v1.3 conformance claim is made. There are no incompatible old YAML
  assertions identified by this local packet.

Next owner: packet 10 for block structure; coordinator/I0 for public parser wiring.
