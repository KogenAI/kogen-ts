# Packet 35 — ChatGPT PKCE login and callback

## Source and effort

- Base SHA: `5585601ad1be8cac5b8daa8e3cda92078399d5e8`.
- Implementation head SHA: `224cfc9c630c0ce71e8172bb96a0ab3da47aa925`.
- The receipt is committed separately after the implementation so the implementation SHA is exact and does not try to include its own commit ID.
- Active effort: approximately 25 minutes; this is a focused-time estimate, not an automatic timer reading. The 90-minute limit was not approached.
- Model: Codex based on GPT-6; exact deployment variant and token usage are not exposed in this session.

## Changed behavior

Added injectable ChatGPT OpenID discovery and PKCE login. Login persists a stable Kogen host UUID, uses the required scopes/resource and dynamic client hint, binds the loopback callback before opening the browser, exchanges the authorization code, checks the required direct-token scope, verifies RS256/JWKS plus issuer/audience/expiry/nonce/subject, refuses subject changes for an existing label, and saves the credential/profile with credential rollback if profile publication fails. A state-verified OAuth denial for a saved client triggers one fresh dynamic-registration attempt. Invalid callbacks do not trigger repair. Callback listeners close after one result and support immediate sequential reuse of port 1455.

All owned OAuth tests use fake HTTP, generated test RSA keys, in-memory credential/filesystem ports, and the local loopback listener. No live provider, keychain, or host credential was used.

## Exact owned files

- `packages/core/src/provider/auth/chatgpt/login.ts`
- `packages/core/src/provider/auth/chatgpt/jwks.ts`
- `packages/core/src/provider/auth/chatgpt/callback.ts`
- `tests/chatgpt-login/login.test.ts`
- `tests/chatgpt-login/jwks.test.ts`
- `docs/work/receipts/35-chatgpt-pkce-login-and-callback.md`

## Validation

- `bun test tests/chatgpt-login`: **5 passed, 0 failed, 58 assertions**. Covered invalid state response, immediate back-to-back logins on port 1455, PKCE challenge/verifier and authorize/token parameters, one fresh-registration repair, subject-change refusal without overwriting the saved credential, and RS256/issuer/audience/expiry/nonce/subject validation.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, final run had **345 passed, 1 expected macOS-host skip, 0 failed**. The Linux namespace test is skipped on this macOS host. An intermediate recheck had one unrelated transient failure in the existing host-bridge SIGKILL test while it parsed a partially written `parent-report.json`; the final full check passed without changing that test or its fixture.
- Exact frozen command for `v1.2-32-provider-21-login-flow`: **harness error, 1 case / 1 instance; 0 passed, 0 failed, 1 error, 0 skipped**. The runner could not spawn `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/35-chatgpt-pkce-login-and-callback/dist/kogen` (`FileNotFoundError`). No executable ran, so the official case made no fake OAuth requests and provides no behavioral pass. The command was not retried.
- Local fake OAuth observations: **18 total** — 5 authorize URLs, 5 discovery requests, 4 token exchanges, 4 JWKS requests; **0 unmatched**. The separate failed-state callback test made no OAuth HTTP requests.
- Replay: not assigned to packet 35; hand counts, seeds, and first divergence are not applicable.

## Pending integration

- Public `provider login chatgpt` composition and `dist/kogen` wiring are coordinator-owned and remain pending. Next owner: coordinator at I2; wire `loginChatGpt`, build the CLI artifact, then rerun B35 serially on port 1455.
- The frozen B35 oracle is v1.2. No incompatible B35 assertion was identified, but this result does not claim v1.3 parity or close the case.
- Validation ran on macOS 26.7.1 arm64. Linux login/callback and port-reuse behavior remain unverified; final platform closure belongs to integration/I7.
