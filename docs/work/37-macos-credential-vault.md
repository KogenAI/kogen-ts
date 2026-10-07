# 37-macos-credential-vault

Goal: macOS credential vault. Limit: 90 active minutes.

Dependencies: 02,04,34

## Owned files

`native/{keychain.c,keychain.h}; packages/core/src/provider/auth/vault.ts; tests/vault/**`

## Goal

Security.framework pipe-only key operations and AES256GCM envelope; provider-specific key account; never Keychain under file seam.

## Acceptance

Mock vault encryption/integrity and seam test in make check; isolated explicit OS-keychain fixture at I6.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/37-macos-credential-vault.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
