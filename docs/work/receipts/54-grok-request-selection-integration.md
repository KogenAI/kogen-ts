# Packet 54 — Grok request and selection integration

**Status:** Implemented locally; awaiting public integration acceptance.

## Source and ownership

- Base SHA: `b0d8da73c47dfe4427a0a03a0034174fdc101cb7`.
- Implementation SHA: `3fafbd900b55f989ee1957543b8a29fdf02ca365`.
- Target: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Dependencies 12, 30, 33, and 53 are ancestors of the base.
- Owned files:
  - `packages/core/src/provider/grok/adapter.ts`
  - `tests/grok-wire/adapter.test.ts`
  - `docs/work/receipts/54-grok-request-selection-integration.md`
- Active effort: approximately 20 minutes. Model: Codex/GPT-6; exact served variant and effort were not exposed. Token usage was not exposed by session telemetry.
- Host: macOS 26.7.1 (25G241), arm64; Bun 1.4.2; Git 2.54.0.

## Changed behavior

- Adds a Grok `SendProviderAttempt` adapter with the fixed default endpoint `https://cli-chat-proxy.grok.com/v1/responses` and the existing explicit test endpoint seam.
- Sends the Grok authorization, protocol, client, version, model, and sticky affinity headers. It makes a fresh UUID v4 for every Grok HTTP attempt, including a 401 refresh replay.
- Uses the shared session encoder, Responses SSE assembler, nullable usage parser, and retry policy. Retries retain body bytes; partial stream items follow the shared append/continuation rule.
- Proactively refreshes saved Grok credentials and performs one forced refresh/replay after a 401. The replay uses the same body and a new request UUID.
- Maps Grok HTTP status/body, deadline, stall, transport, malformed-stream, and oversize failures to the §4.10 classes and sentences.
- Rejects a non-Grok session before reading credentials or making an HTTP request. Selection tests feed the selected Grok provider through the shared role resolver; pass 4 inherits an explicit effective Grok shaper model/effort in a fresh conversation.

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null KOGEN_CREDENTIAL_STORE=file bun --no-install test --max-concurrency 1 ./tests/grok-wire ./tests/grok-auth` — **PASS**: 20 tests, 147 assertions. Grok wire fixtures scripted 14 HTTP calls; **0 unmatched**. Coverage includes P10 wire/auth, pass-4 Grok selection, omitted empty-key affinity headers, UUID/body identity on 401 replay, provider-local overload retries, append/usage behavior, and provider-specific errors.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**: 419 tests passed, 1 platform skip, 0 failed; 3,474 assertions across 49 files. The skipped case is real Linux namespace/mount coverage, which cannot run on this macOS host.
- An earlier full-check run exposed a shared static-prefix fixture-version collision in the new test; the fixture versions were made unique and the complete check was rerun successfully. No official case was retried.
- No directly owned standard B-set exists. No external conformance case or public CLI request was run. `dist/kogen` is absent, so public Grok route acceptance is pending integration, not a pass.
- Grok wire adapter used fake HTTP and in-memory credential/filesystem/lock ports. No live provider, host credential, Grok CLI credential file, or keychain was accessed.
- Xspec replay: no mandatory hand cases assigned to packet 54; hands run `0`; seeds 17/23/41 not run; first divergence not applicable. The accounts diagnostic remains with packet 61.

## Pending integration and gaps

- The coordinator must compose the Grok attempt sender with the real provider/session flow and register the selected account/credential store. This worker did not edit central composition, CLI registration, or xspec registry files.
- Packet 61 owns the accounts diagnostic. I6 owns integrated Grok request acceptance and the common v1.3 reconciliation. The frozen v1.2 suite has no complete Grok wire/pass-4 oracle; this receipt makes no v1.3 suite parity claim and identifies no incompatible owned old assertion.
- Local Grok tests ran on macOS only. Linux adapter behavior remains unverified; the final full check’s Linux namespace test was skipped on macOS.
- Next owner: coordinator for public composition; packet 61 for accounts diagnostics; I6 for integrated acceptance.
