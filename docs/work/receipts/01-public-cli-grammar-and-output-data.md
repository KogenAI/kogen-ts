# 01 — Public CLI grammar and output data

Status: **implemented; public black-box acceptance awaits CLI integration**.

## Source and effort

- Base: `1e5d4cd54c6adedf7a1578112742722448324d21`
- Validated implementation commit: `0738ed5c58fa63b91068c219d3f819da253bb4f2`
- Branch: `kts/01-public-cli-grammar-and-output-data`
- Active effort: approximately 10 minutes; the session did not expose an active-time counter.
- Model and tokens: Codex GPT-6; model deployment/effort and token count were not exposed by the session tools.

This receipt is added as a documentation-only follow-up to the validated implementation commit above.

## Changed behavior

- Added a typed public argument parser with the fixed command tree, moved-form-first handling, options only after the command path, `--` positional handling, last-option-wins, and option errors before positional and value errors.
- Added command-specific option/positional tables, absolute resolution for `--project` and `--origin`, both `chatgpt` and `grok`, approval hash validation, and the status `--watch`/`--json` conflict.
- Slugs remain raw positional values in the parser; command-time slug validation stays downstream.
- Added exact help and moved-form output, plus stdout/error exit rendering. Help pages and `moved.json` are copied from the locked v1.3-draft data and bundled through static imports.
- Added grammar table tests, every moved-form row, stdout/stderr and exit checks, and byte-for-byte comparisons for all 15 help pages.

## Exact owned files

- `packages/cli/src/argv.ts`
- `packages/cli/src/output.ts`
- `packages/cli/data/moved.json`
- `packages/cli/data/text.d.ts`
- `packages/cli/data/help/{kogen,kogen-intent,kogen-intent-approve,kogen-intent-remove,kogen-intent-shape,kogen-queue,kogen-queue-start,kogen-queue-stop,kogen-provider,kogen-provider-list,kogen-provider-login,kogen-provider-logout,kogen-provider-use,kogen-status,kogen-version}.txt`
- `tests/cli-boundary/argv.test.ts`
- `tests/cli-boundary/output.test.ts`
- `docs/work/receipts/01-public-cli-grammar-and-output-data.md`

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**. Biome, TypeScript, shell, input freeze, dispatcher, native unit compilation, and 49 repository tests passed (0 failed).
- `bun --no-install test --max-concurrency 1 ./tests/cli-boundary` — **PASS**, 45 tests, 67 assertions.
- Exact packet B01 conformance command — **not accepted**. Runner summary: 25 cases, 0 pass, 0 assertion failures, 25 harness errors, 0 skips; 166 instances, all 166 harness errors. Breakdown: CLI 6 cases/35 instances, format 2/30, v1.2 overlay 17/101. Every case failed to spawn `dist/kogen` (`FileNotFoundError`); no CLI process or fake request ran, so unmatched fake requests: **0**. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-01-fzlh3e/results.jsonl`.
- Replay: not run; packet 01 owns no xspec slice. Hand counts, seeds, and first divergence are not applicable.

The B01 harness errors are integration blockers, not passing cases or parser failures. This bootstrap has no `dist/kogen`, `main.ts`, or `composition.ts`; central CLI wiring is coordinator-owned.

## Superseded v1.2 assertions

The selected v1.2 overlay cases reflect the target spec. These older, replaced assertions conflict with the current target:

| Older assertion | Active overlay / target behavior |
|---|---|
| `cli-11`: unknown provider says `(supported: chatgpt)` | `v1.2-14`: lists `chatgpt, grok`. |
| `cli-13` and `cli-21`: invalid slugs are parse-time usage errors with a help page | `v1.2-16` and `v1.2-20`: parser preserves the slug; command dispatch reports `intent/invalid_slug` without a usage page. |
| `cli-17`: `help` reports `no command '<all following words>'` | `v1.2-19`: reports `unexpected argument '<first following token>'`. |
| `cli-24`: `--help` prints the command page and exits 0 | `v1.2-21`: `--help` is an unknown option, exits 2, and appends the command page. |

These are replaced historical expectations, not changes made to the frozen suite. No suite files were edited.

## Pending integration and next owner

- Coordinator/integrator: connect `parseArgv` and output renderers to central `main.ts`/`composition.ts`, produce `dist/kogen`, then rerun the exact B01 command as public-route acceptance. Parser/module tests alone do not close B01.
- Platform: validation ran on macOS 26.7.1 arm64; Linux behavior is unverified.
- Version: implementation follows locked spec draft `e19dd1c` and the selected v1.2 overlay. No v1.3 suite or full CLI parity claim is made.
