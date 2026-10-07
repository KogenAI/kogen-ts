# B31 — Read/search/write/edit tool boundary

## Source and ownership

- Base: `5585601ad1be8cac5b8daa8e3cda92078399d5e8`
- Implementation commit: `8d535f3ab8273b1fa28d9ca9f954f7c308d51c37`
- Authority: spec v1.3-draft `e19dd1c`; Rust used only as read-only structure/failure evidence.
- Owned files changed:
  - `packages/core/src/provider/tools/schema.ts`
  - `packages/core/src/provider/tools/files.ts`
  - `packages/core/src/provider/tools/dispatch.ts`
  - `tests/file-tools/tools.test.ts`
  - `docs/work/receipts/31-read-search-write-edit-tool-boundary.md`
- Active work: approximately 45 minutes, estimated; exact active-time telemetry was unavailable.
- Model and token count: not exposed by the execution environment.

## Behavior

Added a canonical immutable tool-schema union and a closed schema guard. Resolved role/recipe allowlists gate read, search, edit, write, shell, finish, and tool-output tools. Unknown and disallowed tools return `tool_not_allowed`; invalid arguments return `invalid_arguments`. Dispatch requires a complete successful response assembly, so incomplete/failing proposals and in-progress tool calls do not reach handlers.

Read and search use anchored safe filesystem operations, bounded reads, line formatting, and clear approved-path errors. Search invokes `rg` with argument arrays and has a safe `grep` fallback. Writes publish complete content atomically; edits require one exact unique match. Shaper write paths and the 200-line limit are enforced. Safe in-root links are supported for read/search. The existing atomic publication port is no-follow, so writing/editing through a symlink destination fails closed; supporting such writes needs a safe-fs write-resolution interface from integration.

## Checks

- `GIT_CONFIG_GLOBAL=/dev/null make check` — PASS. Format, lint, types, shell, native units, and isolated tests passed: 348 passed, 0 failed, 1 skipped; 349 tests across 39 files and 3004 expectations. The existing Linux namespace/bwrap test was skipped on macOS.
- `bun --no-install test tests/file-tools` — PASS: 8 tests, 32 expectations.
- File-tool coverage includes role allowlists, schema guard, read limits and errors, safe/outside symlinks, search paths, write limits and full-byte publication, exact-match edits, protected paths, unknown/disallowed calls, and rejection of incomplete or in-progress proposals.

## Named conformance run

Ran the exact brief command with profiles `cli,state,approval,shape,build,ladder,provider,custody,format,v1.2` and cases `provider-24,provider-26,v1.2-118-provider-25` (jobs 3, time scale 0.02). The runner process exited 0, but none of the cases passed: all failed to start because `<worktree>/dist/kogen` does not exist.

- `provider-24`: 10 instances, 0 passed, 10 harness errors.
- `provider-26`: 1 instance, 0 passed, 1 harness error.
- `v1.2-118-provider-25`: 1 instance, 0 passed, 1 harness error.
- Total: 12 instance errors; no case passes, assertion failures, skips, or unmatched fake requests. No provider request reached the fake server.
- Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-31-aWLWgr/results.jsonl`.

This is pending public CLI/build wiring, not a pass. The coordinator owns that integration. The frozen suite is v1.2; these results do not claim v1.3 parity.

## Replay, environment, and integration status

B31 does not own xspec/replay acceptance. Replay hand counts, seeds 17/23/41, and first divergence are not applicable here and were not run. Host: macOS 26.7.1 arm64. Linux acceptance remains pending.

The supplied prior receipt and integration-log paths were absent when checked. The retained worktree was clean at the stated base; no rebase was in progress. Per the task handoff, earlier dispatcher attempts 0 and 1 were externally terminated with their launching Codex process group. This resumed run completed the implementation and local checks. Public conformance remains pending the missing `dist/kogen` integration.
