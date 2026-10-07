# Packet 03 — Anchored filesystem reads and traversal

## Source and ownership

Base SHA: `8a97a3c1a51ed399e477bf6e5c5d90ebaff9589c`
Head SHA: `8ccb15d9b2d666fd9137ce1e547e921113a170a1`
Branch: `kts/03-anchored-filesystem-reads-and-traversal`
Status: AWAITING_INTEGRATION

- Exact owned files:
  - `native/paths.c`
  - `native/paths.h`
  - `native/read.c`
  - `packages/core/src/fs/read.ts`
  - `tests/fs-read/read-driver.c`
  - `tests/fs-read/read.test.ts`
  - `docs/work/receipts/03-anchored-filesystem-reads-and-traversal.md`
- Active effort: approximately 20 minutes.
- Model/tokens: GPT-6 Codex; served variant and token count are not exposed by this worker interface.
- Host: macOS 26.7.1 (25G241), arm64; Darwin 25.6.0; Apple clang 21.0.0; Bun 1.4.2; Git 2.54.0.

## Behavior

Added a C17 filesystem boundary rooted at an opened canonical directory descriptor. Relative traversal uses directory descriptors, `openat`/`fstatat`, and no-follow flags. Controller reads reject symlink components and final links. Tool reads resolve at most 40 links and reject targets outside the root. Reads require regular files and use nonblocking open flags to avoid hanging on a raced FIFO. Directory enumeration returns byte names sorted by byte order and classifies links with `AT_SYMLINK_NOFOLLOW`, without following them.

`read.ts` encodes root and relative paths as bytes in operation `0x0301`; arbitrary filename bytes do not pass through Unicode decoding. It exposes controller reads, tool reads, bounded enumeration, and a `FileSystemPort.readFile` adapter. The native request payload and stable response status values are declared in the owned module boundary.

## Validation

- Named local acceptance: `bun --no-install test --max-concurrency 1 ./tests/fs-read/read.test.ts` — **7 passed, 0 failed, 27 assertions**. Covers controller parent/final symlink rejection, relative and absolute in-root links, outside links, the 40-link bound, link enumeration, nonregular directory/FIFO handles, byte-exact invalid-UTF-8 path requests, and a 10,000-request parent-link swap race with no outside file bytes returned.
- Invalid UTF-8 host detail: APFS rejected creating a filename containing `0xff` with `EILSEQ`. The fixture verifies that `read.ts` passes the byte path unchanged and the native layer safely reports the path unavailable. The same fixture reads/enumerates the raw name when the host filesystem supports it; Linux behavior remains unverified here.
- Required check: `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 119 tests, 0 failures, 1,615 assertions. Biome, TypeScript, shell syntax, frozen-input and dispatcher checks, warning-as-error C compilation, and the isolated test suite passed. An earlier run stopped at Biome formatting findings; they were corrected before the passing run.
- `git diff --check` — **PASS**.
- Standard conformance: no B-set is assigned to packet 03; **0 cases / 0 instances**. No fake provider request was made; unmatched fake requests: **0**. The bootstrap has no executable CLI and the helper operation is not registered yet, so integrated behavior remains awaiting integration acceptance.
- Replay: not assigned; hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.

## Pending integration and interface follow-up

The native helper's `main.c` is coordinator-owned. Integration must compile `paths.c`/`read.c` into the helper and dispatch `KOGEN_HOST_OP_FS_READ` (`0x0301`) to `kogen_fs_handle_read_request`. The local native driver invokes that same request handler; it does not establish public CLI wiring.

The current `FileSystemPort` contract has no directory-enumeration operation. `listDirectoryBytes` is available as a module boundary, but the coordinator should add a byte-preserving directory-listing method to the shared filesystem port before workspace snapshot callers depend on it. Packet 16 and the coordinator own that interface/composition change.

Only macOS arm64 was compiled and exercised. Linux remains unverified; packet 02's receipt records its Linux design gate as failed because no Linux runner was available, and calls for coordinator confirmation of its control-channel choice. The dependency commit is present in this base, but those OS/integration gaps are still open. No v1.3 oracle exists in this bootstrap; this packet has no v1.2 compatibility claim.

Next owner: coordinator/integrator for helper registration and the shared byte-path enumeration port, then Linux runner owner for C/helper validation on Linux.
