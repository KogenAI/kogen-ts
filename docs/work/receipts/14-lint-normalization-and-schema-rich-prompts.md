# Packet 14 receipt — lint, normalization, and schema-rich prompts

## Source and scope

- Base SHA: `196005c8f5e676afd8f0953517b7328d3598ff9d`
- Implementation SHA: `6f96ea9bf6968b7a9ceea370d15240330b0cc585`
- Dependencies 12 and 13 are ancestors of the implementation base.
- Owned implementation files:
  - `packages/core/src/intent/lint.ts`
  - `packages/core/src/intent/normalize.ts`
  - `packages/core/src/shape/prompts.ts`
  - `tests/intent-lint/lint-normalize.test.ts`
- This receipt is the only additional file for this packet.

## Behavior

- Lint policy and wording load from the frozen `spec/data/lint.json`. Structural and style findings cover the frozen error rules, banned words and phrases, hedges, and size thresholds. The linter consumes parsed Intent fields and never scans Request bytes.
- Normalization canonicalizes an existing Notes `Approach:` prefix, adds it when Notes begin with an action verb and meet the frozen word threshold, removes any model-written Request section, then appends the supplied Request bytes unchanged with the specified separator.
- The stable shaper prompt includes required `title`, `size`, and `domains`, every allowed optional key, `A1`/`A2` Acceptance and Verify examples, the `<slug>/A<n>` ledger tag, and the ExUnit tag form. The prompt schema fixture parses with the production Intent parser.
- The prompt and its schema example omit `## Request`; Request text remains context appended verbatim after shaping.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** on macOS 26.7.1 arm64. The run reports 240 passing tests and one platform-gated Linux mount test skipped on macOS. Biome, TypeScript, shell, source-freeze, dispatcher, and native compile checks pass.
- `bun --no-install test --max-concurrency 1 tests/intent-lint`: **PASS**, 8 tests and 198 expectations.
- Exact B14 conformance command: **not accepted**. The six cases expanded to 118 instances; all six cases errored before invoking Kogen because `dist/kogen` does not exist. Results were approval-21 0/1, format-02 0/65, format-03 0/13, format-04 0/24, state-05 0/14, and v1.2-36-state-06-lint-card-warnings 0/1. There were zero unmatched fake requests because the executable could not be started. This is pending public CLI wiring, not a pass.
- Local lint tests cover all 65 banned word/phrase rows, all 13 hedge rows, all 24 tier-boundary rows, and the parseable `state-05` lint error rows. The prompt schema fixture parses and Request bytes survive CRLF and invalid UTF-8.

## Known parser boundary and remaining integration

The `state-05` fixture expects two malformed-input cases to reach lint, but the merged parser rejects them first. Its `unknown_size` row expects `unknown_size: size must be small, medium, or large`; `parseIntent` currently returns `frontmatter `size` must be small, medium, or large` as a parse error. Its `invalid_verify` row expects `invalid_verify: unknown Verify word "manual"`; `parseIntent` currently returns `invalid Verify entry` as a parse error. Resolving that classification needs a parser/interface amendment from the coordinator; packet 14 did not edit packet 13 files. The other state-05 rows match the local linter.

- B14 public closure is awaiting the coordinator's CLI/composition wiring and the parser/interface decision above. The frozen CLI suite is v1.2, while the target source is v1.3-draft; no v1.3 conformance claim is made.
- OS evidence is macOS only. Linux conformance remains unrun. The local Linux mount test was platform-gated; no Linux parity claim is made.
- Replay hand counts, seeds, and first divergence: not applicable; packet 14 owns no xspec slice.
- Next owner: coordinator for CLI wiring and a parser/interface amendment; then rerun the exact six-case B14 command on the integrated executable.

## Effort and environment

- Active effort: approximately 14 minutes; unattended check and conformance waits excluded.
- Model: GPT-6; exact runtime variant and effort label are not exposed in this session.
- Token usage: not exposed by the execution interface.
- Verification host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0; Python 3.14.7.
