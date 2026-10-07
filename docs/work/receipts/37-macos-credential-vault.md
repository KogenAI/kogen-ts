# Packet 37 — macOS credential vault

Status: **IMPLEMENTED, AWAITING INTEGRATION ACCEPTANCE**

Base SHA: `5585601ad1be8cac5b8daa8e3cda92078399d5e8`

Implementation commit: `604b772` (`Implement macOS credential vault`, rebased).
Latest validated branch head: `ac84f7a0141077688db790c5984a9a5ef30d99c6`.
Rebase base: `3da7beee2f2eff4feba911143ea46931a86a7057` (`main`).

Branch: `kts/37-macos-credential-vault`

Target: spec v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen
conformance suite v1.2.

Active effort: approximately 18 minutes total, including the integration
diagnosis/rebase and receipt update; automated check wait excluded. Model:
GPT-6 Codex; exact served variant and token count are not exposed by this worker
interface.

Host: macOS 26.7.1 (25G241), arm64; Apple clang 21.0.0; Bun 1.4.2; Git 2.54.0.

## Owned files

- `native/keychain.c`
- `native/keychain.h`
- `packages/core/src/provider/auth/vault.ts`
- `tests/vault/vault.test.ts`
- `docs/work/receipts/37-macos-credential-vault.md`

The host bridge source, safe publication source, and accounts/file credential
source from dependencies 02, 04, and 34 are present in the base history. Their
integrated source commits are ancestors of this base. Packet 02's Linux design
gate remains unavailable as described in its receipt.

## Behavior

- Added a bounded native Security.framework handler for generic-password key
  items. It supports get/add/delete with a fixed `kogen` service, non-syncing
  items, and `WhenUnlocked` access. Key accounts are provider-specific, such as
  `chatgpt:work:key` and `grok:work:key`. The 32-byte key and account bytes are
  encoded in the host protocol payload; no key or credential is passed in argv
  or diagnostics. Non-Apple builds return an explicit unavailable status.
- Added the TypeScript host-operation adapter for operation `0x0304`, including
  strict request/response lengths and typed Security.framework error mapping.
  Secret-bearing request buffers are cleared after the pipe request completes.
- Added a `KGV1` AES-256-GCM envelope: 12-byte nonce, 16-byte authentication
  tag, and ciphertext. Associated data binds the bytes to provider, account,
  credential name, and envelope version. Keys are created with a no-overwrite
  Keychain add; a concurrent create conflict reloads the winner's key. Reads do
  not create replacement keys when the original key is missing. Temporary key,
  nonce, tag, and plaintext buffers are cleared after use.
- Added `createCredentialPort` selection. `KOGEN_CREDENTIAL_STORE=file` selects
  the existing file-backed port before any Keychain call; non-macOS hosts also
  use that file port. macOS uses the vault when the selected store is Keychain.
- Credential files remain under `$HOME/.kogen/credentials`, use the existing
  private 0600 atomic filesystem port, and never store plaintext on the macOS
  vault path.

## Validation

- Named local acceptance at the rebased branch head:
  `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/vault`
  — **PASS**, 6 cases, 25 assertions. Coverage: encrypted round-trip and private
  envelope, modified-tag rejection, missing-key refusal without key recreation,
  provider separation and associated-data binding, file-seam bypass, and framed
  native request encoding.
- Required `GIT_CONFIG_GLOBAL=/dev/null make check` at the latest validated
  branch head `ac84f7a0141077688db790c5984a9a5ef30d99c6` — **PASS**, 351 passed,
  1 skipped, 0 failed; 3,055 assertions. Biome, TypeScript, frozen input,
  dispatcher validation, warning-as-error native compilation, and isolated
  tests passed. The skip is the existing Linux-only real-mount case on this
  macOS host. `native/keychain.c` compiled cleanly; no real Keychain operation
  was invoked.
- The integration log's check at `073160db85aa3db8abf005720dc5a1886d665ae5`
  had 345 passed, 1 skipped, and 1 unrelated failure: `tests/host-bridge/host.test.ts`
  raised `SyntaxError: Unexpected EOF` parsing `parent-report.json`. The test
  waits for the report path to exist, then reads it while its driver writes the
  JSON file. A required full-check rerun at that head passed (346 passed,
  1 skipped, 0 failed; 2,997 assertions). After rebasing onto the current main
  tip, the named vault cases and full check passed again at the latest head.
  This packet changed no files outside its allowlist; the host-bridge test and
  driver remain with their owner if the report-read race recurs.
- `git diff --cached --check`: **PASS** for the implementation commit.
- No directly assigned B-set. Conformance cases: **0 assigned / 0 run**;
  expanded instances: **0**; unmatched fake provider requests: **0**. The
  bootstrap has no executable `dist/kogen`; absent public wiring is pending
  integration, not accepted behavior.
- Replay is not assigned: hand scenarios **0**; seeds 17/23/41 not run; first
  divergence not applicable.

## Pending integration and gaps

- `native/main.c` does not yet register or link operation `0x0304`, so the
  Security.framework handler cannot be reached through the production helper.
  The coordinator owns that registration/build wiring and the auth composition
  change that selects this port and supplies a cryptographically secure
  `RandomPort` (the current foundation composition does not yet construct
  credential or random ports). The composition must also provision the
  `$HOME/.kogen/credentials` directory through the safe filesystem layer.
- Run the isolated, explicit OS-Keychain fixture at I6. `make check` and the
  named local tests intentionally use only mocked Keychain operations and the
  file seam. No real credentials or Keychain items were accessed.
- Validation was on macOS arm64 only. Linux uses the file backend; the broader
  packet 02 helper design gate still has no Linux runtime acceptance. No
  cross-OS native Keychain claim is made.
- The frozen oracle is v1.2 while the target is v1.3-draft. No incompatible old
  assertions were exercised and no parity claim is made.

Next owner: coordinator/integrator for native operation registration, auth
composition and directory provisioning, then the isolated I6 OS-Keychain
fixture.
