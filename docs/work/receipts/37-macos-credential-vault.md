# Packet 37 — macOS credential vault

Status: **IMPLEMENTED, AWAITING INTEGRATION ACCEPTANCE**

Base SHA: `5585601ad1be8cac5b8daa8e3cda92078399d5e8`

Implementation commit: `8c24be67748dd4a2a23982b55b018ec3aeb8605a`
(`Implement macOS credential vault`, rebased).
Validated code tree head: `6793e2d41e0bc6954677687b98084f470ed87135`.
Latest rebase base: `79f3ef53e5852685a5c628404b38f5ffb5310179` (`main`).

Branch: `kts/37-macos-credential-vault`

Target: spec v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen
conformance suite v1.2.

Active effort: approximately 28 minutes total, including the integration
diagnosis/rebase and receipt updates; automated check wait excluded. Model:
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

## Integration scope repair — 8 October 2026

The supplied integration log reported packet 35's ChatGPT login files outside
the packet 37 allowlist. At repair start the worktree was clean, no rebase was
in progress, and the branch merge base was `c3e4ecbb6c15513a570ac8de0722b8216d2edff1`,
before the current `main` tip. Rebasing onto `main` at
`79f3ef53e5852685a5c628404b38f5ffb5310179` completed without conflicts. The
new merge base is that main tip. The dispatcher scope check passed:
`bun tools/dispatch-scope.ts 37-macos-credential-vault "$PWD" 79f3ef53e5852685a5c628404b38f5ffb5310179`.
The branch diff contains only this receipt, `native/keychain.c`,
`native/keychain.h`, `packages/core/src/provider/auth/vault.ts`, and
`tests/vault/vault.test.ts`.

At validated code tree head `6793e2d41e0bc6954677687b98084f470ed87135`, named
local acceptance `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test
--max-concurrency 1 ./tests/vault` passed: **6 cases, 25 assertions**.
`GIT_CONFIG_GLOBAL=/dev/null make check` passed: **482 passed, 1 Linux-only
skip, 0 failed, 3,777 assertions across 59 test files**. The skip is the
existing Linux-only real-mount case on this macOS host. Biome, TypeScript,
dispatcher validation, warning-as-error native compilation (including
`native/keychain.c`), and isolated tests passed. No real Keychain operation
was invoked. The explicit dispatcher scope check passed. There is no assigned
B-set: **0 external cases run**, **0 expanded instances**, and **0 unmatched
fake provider requests**. Replay is not assigned: **0 hand scenarios**, seeds
17/23/41 not run, first divergence not applicable.

Production integration remains pending: `native/main.c` does not register or
link operation `0x0304`, and `packages/cli/src/composition.ts` does not select
`createCredentialPort` or construct its Keychain/random ports. The coordinator
owns that wiring. I6 still needs the isolated explicit OS-Keychain fixture;
Linux remains file-backed, and packet 02's Linux helper design gate remains
unavailable. No public CLI or cross-OS Keychain acceptance is claimed.

## Integration scope follow-up — 8 October 2026

The supplied integration log lists unrelated changes from already integrated
packages. This branch is already rebased on `main`: `git rebase main` reported
up to date, there is no rebase in progress, and `git merge-base HEAD main` is
`79f3ef53e5852685a5c628404b38f5ffb5310179`. The log's 99-path set matches a
comparison from the original packet base `5585601ad1be8cac5b8daa8e3cda92078399d5e8`,
which includes changes merged into `main`. Comparing from the current integration
base gives only the five paths in this receipt's allowlist. The dispatcher
recheck must use `79f3ef53e5852685a5c628404b38f5ffb5310179` as its base.

- Dependencies are present in the rebased history: packet 02 (`e3c4d16`, host
  bridge), packet 04 (`ab18393`, safe publication), and packet 34 (`1fc8a66`,
  accounts/file credentials). Packet 02's Linux design gate remains unavailable.
- Review findings assigned to packet 37: none.
- Scope check against the current main base:
  `GIT_CONFIG_GLOBAL=/dev/null bun tools/dispatch-scope.ts 37-macos-credential-vault "$PWD" 79f3ef53e5852685a5c628404b38f5ffb5310179`
  — **PASS**. The tracked diff from that base contains only this receipt,
  `native/keychain.c`, `native/keychain.h`,
  `packages/core/src/provider/auth/vault.ts`, and `tests/vault/vault.test.ts`.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 482 passed, 1 existing
  Linux-only mount skip, 0 failed, 3,777 assertions across 59 files. Native
  `keychain.c` compiled with warnings as errors; no real Keychain item was used.
- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/vault`
  — **PASS**, 6 tests, 25 assertions. No fake provider requests were made.
- No B-set is assigned: 0 external cases run, 0 expanded instances, 0 unmatched
  fake requests. Replay remains unassigned: 0 hand scenarios; seeds 17/23/41
  not run; first divergence not applicable.

This follow-up changed only this receipt. The tested source head was
`b9c9d0651a01dd338cc6e4fe3561e80e197b1c38`; this follow-up is approximately
40 active minutes total including the earlier 28-minute implementation/rebase
receipt, with automated check wait excluded. Model: GPT-6 Codex; exact served
variant and token count are not exposed.

Remaining I6 gaps are unchanged: coordinator-owned `native/main.c` registration
and auth composition, directory provisioning, and the isolated explicit
OS-Keychain fixture. No public-wiring, real-Keychain, Linux-Keychain, or v1.3
oracle acceptance is claimed. Next owner: coordinator/integrator; packet 37 is
ready for dispatcher recheck with the rebased main base above.
