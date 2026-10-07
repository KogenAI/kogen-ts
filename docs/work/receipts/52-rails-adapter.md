# Packet 52 — Rails adapter

## Status and source

**Status:** Implemented; awaiting production selection and integration acceptance.

- Base SHA: `b6b8b407ad6a56b15b84276d9097dc1b3fd95fa2`
- Tested implementation head: `48d8aa06df0506d7975b2a7308decfdc77911657`
- Branch: `kts/52-rails-adapter`
- Target contract: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`
- Host: macOS 26.7.1 arm64; Git 2.54.0; Bun 1.4.2; Ruby 3.4.10; Bundler 2.6.9. Rails is not installed.
- Active effort: approximately 20 minutes. Model: GPT-6 Codex; exact served variant and token count are not exposed by this worker interface.

## Owned files

- `packages/core/src/adapters/rails/adapter.ts`
- `packages/core/src/adapters/rails/commands.ts`
- `packages/core/src/adapters/rails/config.ts`
- `packages/core/src/adapters/rails/findings.ts`
- `packages/core/src/adapters/rails/index.ts`
- `packages/core/src/adapters/rails/ledger.ts`
- `tests/rails-adapter/rails.test.ts`
- `docs/work/receipts/52-rails-adapter.md`

## Behavior

- Selects Rails only when both `Gemfile` and `config/application.rb` are present; an explicitly configured adapter wins. Uses `.kogen/acceptance/<slug>_test.rb` and `test/acceptance/<slug>_test.rb` and safely stages the approved bytes while removing a matching workspace source copy.
- Runs `bundle exec rails test <candidate path> --verbose` through the supplied process port. Minitest verbose result lines are converted into the common JSONL ledger, which is written to the run directory by a second supervised Ruby process using stdin and exclusive file creation. Timeout, argv, output and report sizes are bounded.
- Exposes the default `ruby -c <path>` acceptance check; selects `bundle exec standardrb -a` before `bundle exec rubocop -a` when the Gemfile declares both; seeds `vendor/cache`, uses offline `bundle install --local`, sets candidate-local `BUNDLE_PATH=vendor/bundle` and `RAILS_ENV=test`, and lists the five Rails gate paths.
- Parses Minitest failures/skips and common Standard/RuboCop diagnostics into gate finding identities. Missing `bundle`, `rails` or `ruby` diagnostics are classified as unavailable.

The frozen spec does not define Rails test tag syntax. The ledger bridge therefore infers an item from exactly one delimited `A<n>` token in the Minitest method name; missing or ambiguous tags become invalid, unknown rows rather than disappearing. The Shape prompt does not teach this convention yet. The coordinator must align the prompt and production finding-parser wiring during I5. No change was made outside the owned files.

## Validation

- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test tests/rails-adapter/rails.test.ts` — **PASS**, 8 tests, 40 assertions. Covers P12, both single-marker refusals, explicit override, staging, setup/env/gate defaults, formatter choice, syntax/runner argv, Minitest ledger rows, the fake command-to-ledger run, finding parsing and unavailable detection. The fake process consumed exactly two requests (Rails runner and report writer); unmatched fake requests: **0**.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **final run PASS**, 313 passed, 1 Linux-only skip, 0 failed, 2,837 assertions across 314 tests and 34 files. Formatting, lint, TypeScript, shell, frozen-input, dispatcher, native compilation and isolated tests passed.
- An earlier full check on the initial adapter revision timed out in the unrelated `tests/fs-read/read.test.ts` parent-link-swap race at 5 seconds and its cleanup raised `ENOENT`. A separate diagnostic run of that file passed 7/7 tests; the final full check also passed it. No files outside this packet's allowlist were changed.
- `git diff --cached --check` — **PASS** before the implementation commit.
- P12: local only, 1 named test passed. No directly owned standard B-set; external cases/instances run: **0/0**. No executable CLI was available for integrated Rails selection, so public wiring remains pending, not accepted. No provider HTTP requests were made; unmatched fake HTTP requests: **0**.
- Optional actual Rails fixture: not run because Rails is not installed. The available Ruby is 3.4.10 rather than the planned fixture pin 3.4.4. Linux adapter validation remains pending.
- Replay is not assigned to this packet: hand cases 0; seeds 17/23/41 not run; first divergence not applicable. No incompatible v1.2 assertion was identified locally; no public v1.3 conformance claim is made.

## Pending integration and next owner

- Coordinator/integrator: select the adapter from checkout markers and explicit config, bind the exposed setup/format/syntax/gate helpers, wire `parseRailsFindings` into gate finding collection, and align the Shape prompt with the inferred Minitest item token convention.
- I5 integration: run an actual frozen Rails fixture and verify Rails selection, staged paths, setup, ledger findings, and gate tree mutation handling end to end.
- Linux runner: validate offline Bundler paths and the adapter against the Linux toolchain.
