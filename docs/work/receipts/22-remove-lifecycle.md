# Packet 22 — Remove lifecycle

## Source and ownership

- Base: `4afcf9545b3bfe543200b71167f887fdeb52f420`.
- Tested implementation head: `f5b09414d518165c95564fdfc017ce2de144125b`.
- Packet 21 and packet 24 dependency commits are in the base ancestry.
- Owned files: `packages/core/src/approval/remove.ts`, `tests/remove/remove.test.ts`, and this receipt.
- Worker effort: approximately 15 active minutes; automated wait was about 2 minutes and is excluded.
- Model: GPT-6; exact model variant and effort are not exposed by the session. Token usage is not exposed by the tool interface.

## Behavior

Added the removal transition and effects for draft, landed, approved, failed, parked, and interrupted Intents. Removal refuses an active Build even with `--force`; requires `--force` for a current approval unless the Intent is landed; refuses an untracked Intent/test pair; removes the Intent directory and acceptance source; creates one path-limited commit through the public Git port; and compare-and-deletes only the approval ref value observed during preflight. A ref race leaves the newer ref intact. The public commit path does not override the user's identity or signing settings. Tests use only temporary repositories with fixture-local identity and signing settings.

The lifecycle observer is an integration port. This packet does not add public CLI composition or a production observer; the coordinator must bind it to queue ownership, run/status state, and landed state during integration. Local policy tests do not close the public active-Build case.

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** — 391 passed, 0 failed, 1 skipped, 3,285 assertions across 392 tests in 46 files. The skipped case requires Linux user namespaces and bubblewrap; this run was on macOS. Formatting, lint, TypeScript, shell, freeze/dispatch checks, native compilation, and isolated tests passed.
- `GIT_CONFIG_GLOBAL=/dev/null bun test tests/remove/remove.test.ts`: **PASS** — 8 passed, 0 failed, 26 assertions.
- Exact brief conformance command: **not accepted; 3 cases errored**. `approval-22`, `approval-23`, and `approval-24` expanded to 6 instances: 0 passed, 0 assertion failures, 3 case errors, 0 skipped, 0 unimplemented. Every instance stopped with `FileNotFoundError` because `$ROOT/dist/kogen` does not exist. The runner reports that no provider request reached the fake server; fake requests sent: 0, unmatched: 0. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-22-wCyjWf/results.jsonl`.
- Host for this run: macOS 26.7.1 arm64 (suite metadata), Git 2.54.0, Bun 1.4.2. Linux B22 acceptance was not run.
- Replay: no replay slice is assigned to packet 22. Packet 57 owns approve/intent replay; no hand traces, seed matrix, or divergence were run here.

## Pending closure

- Public CLI and lifecycle-observer wiring, a built `dist/kogen`, and all three B22 public cases remain pending integration. In particular, `approval-24` closes after queue integration (I2); rerun the exact B22 command then. Next owner: coordinator/I2 integrator.
- No B22-specific v1.2/v1.3 assertion conflict was identified. The frozen suite is v1.2; no v1.3 overlay was exercised, so this receipt makes no v1.3 conformance claim.
- Linux removal/conformance coverage remains open. The single make-check skip is the platform-specific sandbox mount test, not a B22 case.
