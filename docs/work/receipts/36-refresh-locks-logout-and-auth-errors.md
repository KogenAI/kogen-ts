# Packet 36 — Refresh locks, logout and auth errors

## Source and effort

- Base SHA: `3da7beee2f2eff4feba911143ea46931a86a7057`.
- Implementation head SHA: `5a5be71864e7860ee527542254a393f615c3d036`.
- The receipt is committed separately after the implementation so the implementation SHA is exact.
- Active effort: approximately 15 minutes; this is a focused-time estimate, not an automatic timer reading. The 90-minute limit was not approached.
- Model: Codex based on GPT-6; exact deployment variant and token usage are not exposed in this session.

## Changed behavior

Added ChatGPT credential refresh and authenticated request policy. Expiring credentials take an owner lock, reread the saved bytes after acquisition, and refresh only if the latest credential still needs it. Waiters use the 25 ms poll and bounded, scaled 90 s wait. Stale removal compares the observed owner bytes and directory mtime; a failed owner publication is left to age out instead of risking removal of a replacement owner's lock. Successful refresh rotates and persists the token before reuse. An owned 401 forces one refresh only while the stored access token remains the rejected token, then replays the same request body and existing routing headers once. Injected auth is never read from the credential store or refreshed; its 401 maps to the Codex login outcome. A 403 maps to the ChatGPT login outcome without a forced refresh.

Added ChatGPT logout with same-origin OpenID revocation discovery. It attempts remote revocation before deleting a readable credential, then removes the local credential and marks the account signed out. An unreadable or malformed saved credential can still be removed locally; the result records whether remote revocation was confirmed and whether unreadable-credential recovery was needed.

The lock primitive is represented by `ChatGptRefreshLockPort`. Tests provide an in-memory implementation. The production anchored filesystem implementation and public CLI composition are coordinator-owned and are not wired in this packet, so these unit tests do not prove cross-process behavior.

## Exact owned files

- `packages/core/src/provider/auth/chatgpt/refresh.ts`
- `packages/core/src/provider/auth/chatgpt/logout.ts`
- `tests/chatgpt-refresh/auth.test.ts`
- `docs/work/receipts/36-refresh-locks-logout-and-auth-errors.md`

## Validation

- `bun test tests/chatgpt-refresh`: **7 passed, 0 failed, 34 assertions**. Covers concurrent in-memory refresh/re-read/token rotation, one owned 401 refresh and byte-identical replay, injected 401 with zero credential reads or refreshes, 403 without forced refresh, scaled lock timeout, unreadable-credential logout recovery, and revoke-before-delete logout.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, **352 passed, 1 expected platform skip, 0 failed**. The Linux namespace/bubblewrap mount case is skipped on this macOS host.
- Exact requested conformance command (`provider-10,provider-22`): **harness error**, provider-10 **2 instances / 2 errors**, provider-22 **1 instance / 1 error**; total **2 cases, 3 instances, 0 passed, 0 failed, 3 errors, 0 skipped**. The runner could not spawn `<worktree>/dist/kogen` (`FileNotFoundError`). No provider request reached the fake server; unmatched fake requests are not measurable because the executable never started. The command was run once and not retried.
- Frozen v1.2 incompatibility: provider-10 asserts exactly **“401 and 403: one refresh, then stopped provider/login, exit 4”** for both instances. The v1.3-draft §4.6 rule says refresh once after a **401**. The implementation follows the draft: 401 can refresh; 403 returns login without forced refresh. The official case did not launch, so this version conflict is reported from the frozen case text rather than a conformance observation.
- Replay: not assigned to B36. No replay hand counts, seeds, or first divergence were measured.

## Pending integration

- The public `dist/kogen` executable is absent, and no production `ChatGptRefreshLockPort` adapter is wired. Next owner: coordinator at I2. Wire the anchored lock effect and ChatGPT auth transitions into public composition, then run provider-10/provider-22 against the real CLI. In particular, provider-22 needs a separate-process observation before cross-process refresh can be accepted.
- Validation ran on macOS 26.7.1 arm64. Linux production lock behavior remains unverified; the repository check's Linux namespace case skipped on this host. Platform closure belongs to integration/I7.
