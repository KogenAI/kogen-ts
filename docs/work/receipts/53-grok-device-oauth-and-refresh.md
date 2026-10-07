# Packet 53 — Grok device OAuth and refresh

**Status:** Implemented; awaiting public integration acceptance.

## Source and ownership

- Base SHA: `a96219d979333f86ea8b7864a6cad7ada64171bb`.
- Implementation commit: `31776c02968d4a882743b8e8155b2f507386a433`.
- Target: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Dependency implementations 29 (`20d0778cc7a21ddf9e30dc37dfd9dd6d15beaea1`), 34 (`1fc8a666ecd000441dde5b7b5e84cbd1d7f35148`), and 36 (`273d7c94e5f4bb863ade4510f8eaa500780762b2`) are ancestors of the base.
- Owned files:
  - `packages/core/src/provider/auth/grok/login.ts`
  - `packages/core/src/provider/auth/grok/refresh.ts`
  - `packages/core/src/provider/auth/grok/logout.ts`
  - `tests/grok-auth/auth.test.ts`
  - `docs/work/receipts/53-grok-device-oauth-and-refresh.md`
- Active effort: 649 seconds (~11 minutes) at receipt authoring. Model: Codex/GPT-6; exact served variant and effort were not exposed. Goal telemetry reported 338,161 thread tokens at receipt authoring; provider token usage is not applicable.
- Host: macOS 26.7.1, arm64; Bun 1.4.2; Git 2.54.0.

## Changed behavior

- Adds Grok device-code login using the fixed `https://auth.x.ai` OIDC discovery URL and xAI client ID/scopes. Validates the discovery issuer and HTTPS token/device endpoints, uses the specified fallback device endpoint only when discovery omits it, and rejects userinfo and unsafe displayed verification URLs.
- Prints the device code and verification URL before polling. Sleeps before the first poll and each retry, handles the default/zero interval, `authorization_pending`, `slow_down` (+5 seconds), `expired_token`, access denial, and the device-code deadline. Persists the credential and `grok.<label>` profile through injected Kogen ports.
- Refreshes credentials within the 300-second expiry window under `locks/grok-<label>.lock`. Stale takeover uses observed owner bytes and directory mtime for compare-and-remove. The owner rereads under lock, rotates and stores a replacement refresh token before returning, and retains the old refresh token when xAI omits a replacement. A forced 401 refresh is skipped when another process already rotated the access token.
- Logout removes only the local credential and marks the profile signed out. It has no HTTP port and never attempts remote revocation.

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**: 386 passed, 1 expected platform skip, 0 failed; 3,294 assertions across 45 files. The skip is the repository's real Linux namespace/mount case on this macOS host.
- `GIT_CONFIG_GLOBAL=/dev/null KOGEN_CREDENTIAL_STORE=file bun --no-install test --max-concurrency 1 ./tests/grok-auth` — **PASS**: 12 tests, 84 assertions. Covers prompt-before-poll ordering, discovered and fallback endpoints, endpoint/control-character rejection, initial/pending/slow-down delays, both expiry paths, access denial, stale takeover, concurrent refresh/token rotation, stale 401 handling, and local logout.
- The Grok fixtures scripted 24 HTTP requests; **0 unmatched**. They used fake HTTP, clock, credential and lock ports. No borrowed Grok credential, Grok CLI credential file, live provider, or keychain was read.
- TypeScript (`tsc --noEmit`), scoped Biome check, and `git diff --check` passed.
- There is no directly owned standard B-set. No external conformance case was run. `dist/kogen` is absent, so public `provider login/logout grok` behavior is pending integration and is not claimed as a pass. No packet-specific v1.2 incompatible assertion was identified; this receipt makes no v1.3 suite parity claim.
- Replay is not assigned to this packet: hand cases 0; seeds 17/23/41 not run; first divergence not applicable.

## Pending integration and gaps

- The coordinator must compose `loginGrok`/`logoutGrok`, select the Kogen credential store, and provide a real anchored `GrokRefreshLockPort`; local lock tests exercise the transition with an injected fake effect. Public login/logout acceptance remains pending I2 integration.
- Grok request-side 401 refresh/replay and full P10 provider behavior remain with packet 54 and I6. macOS Keychain integration belongs to packet 37. Grok auth cases ran only on macOS with injected credential bytes; Linux deployment behavior is unverified.
- Next owner: coordinator for the real public auth/lock effects; packet 54 and I6 for end-to-end Grok provider integration.
