# Packet 04 — safe publication, restore and removal

Status: **IMPLEMENTED, AWAITING INTEGRATION ACCEPTANCE**

Base SHA: `13617acef5c0d0fe1cd8865ee930c0fd7aba7443`

Implementation head SHA: `ab18393` (`Implement safe filesystem publication and restore`).
This source SHA was checked before the receipt-only commit.

Branch: `kts/04-safe-publication-restore-and-removal`

## Owned files

- `native/publish.c`
- `native/publish.h`
- `packages/core/src/fs/publish.ts`
- `packages/core/src/fs/restore.ts`
- `tests/fs-publish/publish-driver.c`
- `tests/fs-publish/publish.test.ts`
- `docs/work/receipts/04-safe-publication-restore-and-removal.md`

Active effort: approximately 10 minutes.

Model: GPT-6 Codex; exact serving variant and token count are not exposed by this worker interface.

Host: macOS 26.7.1, arm64; Apple clang 21.0.0 (`clang-2100.1.1.101`); Bun 1.4.2; Git 2.54.0.

## Behavior

- Added filesystem host operation `0x0302` and a bounded request handler. Each parent component is opened from the anchored root with `openat` and `O_NOFOLLOW`; `.`/`..`, absolute paths, symlink parents and non-directory parents are refused.
- Atomic regular-file writes use a same-directory `O_CREAT|O_EXCL` temp, start at mode `0600`, set the private final mode to `0600` or executable `0700`, `fsync` the file, rename it into place, then `fsync` the parent. A final symlink is rejected by ordinary writes and replaced as a link entry by restore without following it.
- Append uses `O_APPEND`, an advisory exclusive lock, file `fsync`, and parent `fsync`. First creation uses a private exclusive temp and no-clobber `linkat`, so readers do not see a partial new file.
- Restore supports regular files, symlinks, directories and absent entries. Regular files retain executable state with private `0600`/`0700` modes; symlink target bytes are retained and never followed; directories are restored to `0700`. Removal unlinks final symlinks themselves and syncs the parent. Directory removal is limited to empty directories.
- `restore.ts` and `publish.ts` expose the byte-path helpers and the `FileSystemPort` writer/remover adapter. A conditional `expectedSha256` write is refused because this primitive does not implement compare-and-swap hashing.

## Validation

- Named local acceptance: `bun --no-install test --max-concurrency 1 ./tests/fs-publish/publish.test.ts` — **PASS**, 7 cases, 0 failures, 72 assertions. Cases cover private atomic modes and executable state, append, symlink parents/finals, external sentinel preservation, regular/link/directory restore and removal, five rename crash points, and a racing parent-link publication attempt.
- Rename crash matrix: failpoints after temp creation, data write, file `fsync`, rename, and parent `fsync`. The first three retain the old complete target; the last two expose the complete new target. Temporary files left before rename remain private mode `0600`.
- `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 158 tests, 0 failures, 1,766 assertions. Biome, TypeScript, frozen-input and dispatcher checks, warning-as-error native compilation, and the isolated suite passed.
- `git diff --check` — **PASS** before commit.
- No directly owned B-set: assigned **0 cases / 0 instances**. Fake provider requests: **0 unmatched**; no provider requests were made. Replay is not assigned: hand cases 0, seeds 17/23/41 not run, first divergence not applicable.

## Pending integration and gaps

`native/main.c` and native registration belong to the coordinator. The new `0x0302` handler is exercised through the owned native driver, but the product helper does not yet dispatch it; a `HostBridge` call will remain unhandled until registration and helper linking are integrated. The bootstrap has no executable CLI, so public-command behavior is pending integration and is not claimed as a pass.

Validation was on macOS arm64 only. Linux compilation/runtime and cross-platform filesystem semantics remain open for the coordinator's I0 filesystem integration gate. No v1.2 black-box parity claim is made. The frozen target remains v1.3-draft `e19dd1c`.

Next owner: coordinator/integrator to register and link operation `0x0302`, then run I0 safe-filesystem integration on macOS and Linux.
