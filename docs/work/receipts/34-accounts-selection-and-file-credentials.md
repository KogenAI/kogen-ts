# Packet 34 — Accounts, selection and file credentials

Status: **IMPLEMENTED, AWAITING INTEGRATION ACCEPTANCE**

Base SHA: `a86eb3dc886e0201b0b1da65a85248a225c0e2d7`

Implementation head SHA: `96fe903c322edf8d7b834782a0601e562fd6b075` (rebased implementation commit; full tested branch head `fe6f1315c976cf29892e8c6eb24ccce27a9ae2fc`)

Branch: `kts/34-accounts-selection-and-file-credentials`

Target: spec v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen conformance suite v1.2.

Active effort: approximately 19 minutes for implementation plus 8 minutes for the integration follow-up (~27 minutes total); test/check wait excluded. Model: GPT-6 Codex; exact served model variant and token count are not exposed in this session.

Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0.

## Owned files

- `packages/core/src/provider/accounts/select.ts`
- `packages/core/src/provider/accounts/format.ts`
- `packages/core/src/provider/accounts/profiles.ts`
- `packages/core/src/provider/auth/store.ts`
- `packages/core/src/provider/auth/injected.ts`
- `tests/accounts/accounts.test.ts`
- `docs/work/receipts/34-accounts-selection-and-file-credentials.md`

## Behavior

- Resolves provider precedence as `KOGEN_BENCH_PROVIDER`, checkout-specific machine selection, machine default, then ChatGPT. Resolves the account as `KOGEN_BENCH_ACCOUNT`, selected provider's checkout row, legacy committed `account:` for ChatGPT only, selected provider's default, then `default`. It returns one provider/account pair and does not try another account.
- Parses the accounts document with the strict YAML parser and validates provider, account, path, row, and key shapes. Canonical serialization writes the required comment, provider blocks in fixed order, rows sorted by path, and atomically replaces `accounts.yaml` with mode `0600`. The writer prunes project rows whose checkout directories no longer exist. `provider use` updates either machine defaults or both provider/account project selection rows.
- Reads/writes the per-provider `profiles.json` maps and formats the empty two-provider list rows. Profile updates are serialized compactly and atomically. `host.json` stores and reuses an `ext_agent_host_id` UUID v4.
- Adds a `CredentialPort` backed only by `$HOME/.kogen/credentials`, with provider/label-safe file names, bounded reads/writes, atomic mode-`0600` publication, and no external agent credential paths. The selected file backend must be used for `KOGEN_CREDENTIAL_STORE=file` and on platforms configured for JSON credentials.
- Reads `KOGEN_AUTH_PATH` via the anchored filesystem port each time the injected auth reader is called. It validates the auth JSON and JWT structure, requires a future `exp`, deliberately does not verify the signature, and exposes no refresh operation. Missing, malformed, or expired auth returns `Codex login is missing, invalid, or expired.`

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/accounts` — **PASS**, 9 tests, 45 assertions.
- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install x tsc --noEmit` — **PASS**.
- Required `GIT_CONFIG_GLOBAL=/dev/null make check`: final diagnostic run **PASS**, 268 tests passed, 1 skipped, 0 failed; 2,516 assertions. The skip is the existing Linux-only real-mount test on this macOS host. An immediately preceding final run had one timing failure in the unrelated custody escaped-session duration assertion (509 ms observed against 600 ms minimum), with 267 passed and 1 skipped; it was preserved and reported, and the separate diagnostic run passed without code changes. Biome, types, shell checks, input freeze, dispatcher check, and warning-as-error native compilation passed.
- Required B34 conformance command with cases `provider-19,v1.2-24-state-14-grok-account-row,v1.2-34-format-11-account-selection` — **HARNESS ERROR / PENDING INTEGRATION**, not a pass. Summary: 3 cases, 4 expanded instances, 0 passed, 0 assertion failures, 3 case errors, 0 skipped. Every instance failed to spawn because `$ROOT/dist/kogen` does not exist (`FileNotFoundError`). No Kogen process started: 0 fake requests were made; 0 unmatched requests. The `provider-19` zero-request assertion itself did not execute. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-34-fZyUnw/results.jsonl`.
- Version conflicts: none identified among the three assigned cases. The v1.2 replacements exercise the same empty-provider rows and provider-selection behavior targeted by the draft.
- Replay is not assigned to packet 34. The accounts slice belongs to diagnostic packet 61; hand cases 0, seeds 17/23/41 not run, first divergence not applicable.

## Integration follow-up after rebase

The requested rebase is complete. The worktree was clean before this receipt update, `git rebase --show-current-patch` reported no rebase in progress, and the branch head checked was `fe6f1315c976cf29892e8c6eb24ccce27a9ae2fc` (implementation commit `96fe903`). No account implementation or test change was needed.

- The coordinator integration log's `make check` failed in the unrelated custody test `an escaped session is outside group custody and cannot hold output open forever`: observed duration **508 ms**, below its **600 ms** minimum at `tests/custody/supervise.test.ts:238`.
- The required post-rebase `GIT_CONFIG_GLOBAL=/dev/null make check` also exited nonzero. Biome, TypeScript, shell, freeze, dispatcher and native compilation passed. Bun reported **279 passed, 1 skipped, 1 failed** with 2,678 assertions; the failure was the unrelated fs-read test `parent link swaps never redirect the opened path outside the root`, which hit its 5,000 ms timeout. The skip was the existing Linux-only real-mount case on macOS. No `tests/accounts` case failed.
- Post-rebase local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/accounts` — **PASS**, 9 tests and 45 assertions.
- Exact B34 conformance command — **HARNESS ERROR / PENDING INTEGRATION**, not a pass: 3 cases, 4 expanded instances, 0 passed, 0 assertion failures, 3 case errors, 0 skipped; **0 Kogen requests and 0 unmatched fake requests**. All instances failed to spawn because `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/34-accounts-selection-and-file-credentials/dist/kogen` is absent. The `provider-19` zero-request assertion did not execute. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-34-pVPnrb/results.jsonl`.

The post-rebase check failures are outside packet 34's owned files and were not edited or suppressed. The source-specific cases remain green locally, while overall integration acceptance remains pending. Next owner: coordinator for the red integrated check and public command wiring; packet 03/05 owners for the fs-read/custody test failures.

## Pending integration and gaps

- The bootstrap has no runnable public CLI at `dist/kogen`. The three B34 public cases remain pending provider command and Build wiring; the harness errors above are not accepted behavior. The coordinator owns that composition and should rerun the exact B34 command after wiring.
- The current `FileSystemPort` provides anchored reads and atomic file writes but no directory creation. The auth composition must provision `$HOME/.kogen` and its `credentials/` directory with private permissions before using the file store. macOS encrypted Keychain storage remains packet 37; this packet does not claim that vault path.
- Validation was on macOS arm64 only. Linux runtime acceptance remains open; the full check's Linux mount test was skipped on this host.

Next owner: coordinator for public provider/Build integration and B34 conformance; packet 37 for the macOS vault backend.
