# Packet 02 — Host bridge feasibility and protocol

Status: **FAILED DESIGN GATE — Linux acceptance unavailable**

Base SHA: `1e5d4cd54c6adedf7a1578112742722448324d21`
Implementation head SHA: `d7b308eb395b0f8645ce9e00e79c06a43744d33a`
Active effort: approximately 30 minutes
Model: GPT-6 Codex; exact serving variant and token count are not exposed.

## Implementation

- Added a version 1 binary frame protocol: a 4-byte big-endian body length,
  followed by version, operation, request ID, and arbitrary payload bytes. The
  body is capped at 1 MiB, including the 8-byte header. Unknown versions,
  partial frames, undersized frames, and over-limit lengths fail before payload
  allocation. Unknown operations return a bounded error frame.
- Added a Bun host client that uses private stdin/stdout pipes for frames, drains
  bounded stderr, serializes concurrent requests, validates the helper handshake,
  and finds `kogen-host-<platform>-<arch>` beside a compiled executable (with a
  source-tree location for development).
- The dedicated parent-death descriptor is an inherited anonymous Unix stream
  socketpair on fd 3, created through Bun's caller-owned `socket-fd` stdio slot.
  The helper marks it close-on-exec. The protocol data stays on separate pipes.
- Added a test-only (`KOGEN_HOST_TESTING`) process-group probe. It starts a
  TERM-resistant leader and grandchild, waits for control EOF, sends TERM, then
  KILL after 200 ms and reaps the leader. An exec fixture confirms fd 3 does not
  leak into the child. The product helper does not include this test operation;
  packet 05 owns production process supervision.

## Owned files

- `native/main.c`
- `native/protocol.c`
- `native/protocol.h`
- `native/host.h`
- `packages/core/src/process/host.ts`
- `tests/host-bridge/host.test.ts`
- `tests/host-bridge/parent-kill-driver.ts`
- `tests/host-bridge/probe-worker.c`
- `docs/work/receipts/02-host-bridge-feasibility-and-protocol.md`

## Validation

macOS host: macOS 26.7.1 (25G241), Apple silicon; Darwin kernel 25.6.0; Apple
clang 21.0.0 (`clang-2100.1.1.101`); Bun 1.4.2; Git 2.54.0.

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 11 tests, 0 failures,
  1,275 assertions. Biome, TypeScript, C17 warning-as-error compilation, frozen
  input check, dispatcher check, and isolated tests passed. Two earlier
  implementation iterations stopped on import ordering and Bun stdio type
  narrowing; both were fixed before this final pass.
- `bun --no-install test --max-concurrency 1 ./tests/host-bridge/host.test.ts`:
  **PASS**, 7 cases, 0 failures, 23 assertions:
  - compiled sibling helper lookup and platform naming
  - maximum bounded binary echo with NUL bytes
  - unknown operation rejection and next-frame synchronization
  - concurrent request serialization and byte preservation
  - test-only supervisor operation absent from product helper
  - undersized, truncated, oversized, and unknown-version rejection
  - Kogen-parent SIGKILL, control EOF, fd close-on-exec, and process-group cleanup
- `git diff --check`: **PASS**.
- Mac helper was compiled and run from its compiled-executable sibling directory.
  The process-group fixture was also compiled and run on macOS.
- No B-set is assigned. Conformance was not run: the bootstrap has no executable
  CLI or public registration. Assigned cases: 0; instances: 0; unmatched fake
  provider requests: 0.
- Replay was not run by this packet: hand scenarios 0; seeds 17, 23, and 41 not
  run; first divergence not applicable.

## Design gate and pending work

Linux acceptance is **unavailable**, so the required macOS+Linux design gate
fails. There is no local Docker, Podman, QEMU, Multipass, or UTM runner. Read-only
SSH probes to `192.168.50.204` and `192.168.1.204` both timed out. Benchmark
hosts were not used, following PLAN.md. The helper was not compiled or run on
Linux; no cross-OS claim is made.

The spike used Bun's separate anonymous protocol pipes plus a control
`socketpair`, rather than a literal control pipe. Its EOF and fd-inheritance
behavior is proven on macOS; the coordinator should confirm this interface
choice before packet 05 builds production supervision on it.

`host.ts` is not wired into a CLI, the helper is not part of a compiled artifact
or build manifest, and native registration remains coordinator-owned. These
are awaiting integration, not acceptance. The frozen oracle is v1.2 while the
target is v1.3-draft; no parity claim is made.

Next owner: coordinator/integrator for a Linux runner and the control-channel
interface decision; packet 05 for production process supervision after that
interface is settled.
