# Packet 29 receipt — HTTP, deadline and sticky routing port

**Status:** Implemented; awaiting I2 composition and B33 retry acceptance.

## Source and ownership

- Base SHA: `e55cb2ef51f4278c5549855a517aece9cf629430`
- Implementation head SHA: `c09e13cb78f83b91417f1eb710b67a65ab637733`
- Dependencies 23 and 28 are present in the base: packet 23 implementation `6111327ac4af6c7605792e67f03b0f502903051b`; packet 28 implementation `934e4592d8e110e1cf06e98cd57db860faf965c1`.
- Inputs: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`, frozen `CLI-RULE.txt`, and v1.2 suite snapshot `0f93bad988fb8d7a8eff4e94954d1db0a046c89d`.
- Owned files changed:
  - `packages/core/src/provider/http/transport.ts`
  - `packages/core/src/provider/http/deadline.ts`
  - `packages/core/src/provider/http/routing.ts`
  - `tests/http/transport.test.ts`
  - `docs/work/receipts/29-http-deadline-and-sticky-routing-port.md`
- Effort: approximately 22 active minutes; estimated because this session exposes no worker-time telemetry. Model variant/effort and token usage were not exposed, so no Luna/max or token-count claim is made.

## Behavior

- Adds a Fetch-backed `HttpPort` that streams successful response chunks instead of buffering them. The first non-empty body chunk is awaited before returning the response; headers alone do not satisfy first-byte timing. Any non-empty chunk counts, including SSE comments and keepalives.
- Adds a deadline scope that callers can start before credential/auth work and pass to the transport. It exports the frozen 120 s first-byte, 90 s idle, and 20 min total defaults, enforces per-request limits with inclusive exact boundaries, and aborts fetch and pending body reads on timeout or caller cancellation. Stream failures retain typed timeout/stall/transport causes for the later retry policy.
- Buffers non-2xx response bodies only up to 64 KiB by default, cancels the remainder, and preserves the status and response headers for provider classification. Endpoint resolution accepts injected local HTTP test URLs while rejecting non-HTTP(S) URLs and userinfo.
- Adds a reusable routing context. ChatGPT Responses keeps `session-id` affinity and `thread-id` continuity; Lite uses its distinct `session_id`; Grok uses `x-grok-conv-id` and `x-grok-session-id`. Repeated requests retain the same routing headers, and starting another conversation changes only the thread identity.

## Validation

- `bun test ./tests/http/transport.test.ts`: **PASS**, 15 tests / 15 instances, 59 assertions. Covers slow headers, slow first body byte, comment bytes, idle stall, total cap, cancellation before and after streaming starts, bounded error bodies, endpoint seams, and routing continuity.
- The injected `FetchPort` fixtures made 11 scripted fetch calls; **0 unmatched**. No live network/provider was used.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**; formatting/lint, TypeScript, native compilation, freeze/dispatch checks, and all repository tests (**183 passed, 0 failed across 16 files; 1,883 assertions**). An earlier check stopped on a local Biome naming collision; it was corrected before this passing run.
- Packet 29 has no directly owned standard B-set. No black-box CLI case was run because `dist/kogen` and public provider wiring do not exist yet; this is pending integration, not a pass. No official case was retried.
- Replay is not owned by this packet: hand cases `0`, seeds `17/23/41` not run, first divergence not applicable.

## Pending integration

- The bootstrap has no executable CLI or composed provider/auth/session path. The coordinator/I2 owner must register `HttpTransport`, begin the deadline before auth/credential work, and pass the `KOGEN_PROVIDER_URL` seam through the provider composition. Packet 30 consumes the persistent routing context; packet 33 owns retry classification and the B33 cases.
- The v1.3-draft is frozen at `e19dd1c`; no packet-29-specific v1.3 black-box IDs are available. Integrated first-byte/stall/total behavior remains a release gate; this packet does not claim B33 closure.
- Validation ran on macOS 26.7.1 arm64. Linux behavior remains unverified.
- Next owner: I2 coordinator for public HTTP/auth/session wiring; packet 33 and the integration owner for retry/B33 closure.
