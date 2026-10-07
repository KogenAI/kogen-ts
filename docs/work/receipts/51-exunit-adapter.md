# Packet 51 — ExUnit adapter

## Status and source

**Status:** Implemented; awaiting production caller and integration acceptance.

- Base SHA: `b6b8b407ad6a56b15b84276d9097dc1b3fd95fa2`
- Implementation commit: `6bab51c73fc2f3641365a6b8cb0697f278a205cd`
- Branch: `kts/51-exunit-adapter`
- Target contract: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`
- Dependencies 17 and 18 are in the base history.
- Host: macOS 26.7.1 arm64; Git 2.54.0; Bun 1.4.2
- Active effort: approximately 5 minutes (estimate, excluding test waits). Model: GPT-6 Codex; exact served variant and token count are not exposed by this worker interface.

## Owned files

- `packages/core/src/adapters/exunit/adapter.ts`
- `packages/core/src/adapters/exunit/findings.ts`
- `packages/core/src/adapters/exunit/index.ts`
- `packages/core/src/adapters/exunit/ledger-formatter.ts`
- `tests/exunit-adapter/exunit-adapter.test.ts`
- `docs/work/receipts/51-exunit-adapter.md`

## Behavior

- Stages `.kogen/acceptance/<slug>_test.exs` to `test/acceptance/<slug>_test.exs`, verifies the candidate source copy is identical, removes that copy, and refuses an occupied destination.
- Writes `ledger_formatter.ex` with mode 0600 under the run directory, outside the workspace. The dependency-free ExUnit GenServer formatter appends exact JSONL rows and maps test names without the `test ` prefix plus passed/failed/skipped/excluded/invalid statuses.
- Builds the frozen `elixir -e Code.require_file(...) -S mix test --formatter KogenLedgerFormatter --formatter ExUnit.CLIFormatter <candidate>` argv, optionally prefixed by `<mise> exec --`. It sets the ledger report and intent slug environment values and preserves bounded captured logs.
- Adds ExUnit failure, Elixir compiler, Credo, and `mix format --check-formatted` finding parsers. Formatter selection uses explicit `format`, then the first check containing `format` and `--check-formatted` with that flag removed, then `mix format`; selected paths are limited to `.ex` and `.exs`.
- Classifies the adapter unavailable only when a missing `erl`, `elixir`, or `mix` diagnostic appears within the first 20 captured log lines.

## Validation

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test tests/exunit-adapter/exunit-adapter.test.ts` — **PASS**, 6 tests, 25 assertions, 0 failures. Exact argv, path staging, external formatter placement, formatter selection, unavailable cutoff, and finding shapes are pinned. Unmatched fake process calls: **0**.
- External formatter smoke on the host Elixir installation — **PASS** for report emission: a tagged failing ExUnit test produced `{"tag":"greet/A1","test":"greets Almir","status":"failed"}` in the run-directory report. Host installation is Elixir 1.20.2 / OTP 29.0.3; this is not the frozen fixture version.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **final run PASS**, 311 passed, 1 Linux-only capability skip, 0 failed, 2,822 assertions across 312 tests and 34 files. Biome, TypeScript, shell, freeze, dispatcher, and native compilation checks passed. An earlier run timed out in the unrelated `tests/fs-read/read.test.ts` parent-link-swap case after 5 seconds; the isolated file run then passed 7/7, and the final full check passed.
- Exact ExUnit tier command from the brief — **pending integration, not a pass**. The frozen runner selected all six cases: 0 passed, 0 assertion failures, 6 harness errors, 0 skips, 6 instances. Every case stopped with `FileNotFoundError` for the absent `dist/kogen` before a Kogen command ran. Result: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-exunit-OZDQcm/results.jsonl`. Fake provider requests issued: **0**; unmatched fake requests: **0**.
- The optional six-case ExUnit tier is separate from the standard 236; the 236 profile was not run by this packet.
- Replay is not assigned to this packet: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.
- `git diff --cached --check` — **PASS** before the implementation commit.

## Pending integration and gaps

- `dist/kogen` is absent. Coordinator/I5 must register the ExUnit adapter in production Shape/Build selection and run the six optional cases; the current 0/6 assertion result is a wiring gap.
- Packet 17's shared `AcceptanceAdapter` type does not yet expose `formatter(project)` or `findingParsers`. This implementation returns an ExUnit-specific subtype with both; coordinator integration must thread these hooks to their production consumers or amend the shared adapter contract. No composition, registry, or shared interface file was changed here.
- The pinned optional fixture stack is Elixir 1.18.4 / OTP 27.3.4. Only a local smoke ran on Elixir 1.20.2 / OTP 29.0.3; exact pinned-stack validation remains pending.
- Linux validation remains pending on a capable runner. The repository's real Linux mount test was skipped on this macOS host because Linux user namespaces and bubblewrap are unavailable.
- No v1.2 assertion outcome is claimed; the ExUnit harness errors occurred before assertions. No standard 236-case pass is claimed.
- Next owner: coordinator/integrator at I5 for adapter registration and shared formatter/finding hooks, then rerun the six-case ExUnit command; Linux runner for Linux validation.
