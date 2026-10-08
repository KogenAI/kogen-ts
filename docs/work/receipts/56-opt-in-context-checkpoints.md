# Packet 56 — Opt-in context checkpoints

**Status:** Implemented locally; awaiting I6 Build wiring and integration acceptance. Local reducer/effect-port tests are not public Build acceptance.

## Source and ownership

- Base SHA: `365f0e3861a6dc44e01ddad904845992fb7c90b5`
- Implementation commit: `9dfa887a861d78198990f90e94214a294cfd77c6`
- Dependency implementations are present in the base tree: packet 30 `118544e6e0a3a13ec11ea9c1bbc4169fead765c2`, packet 33 retry source `cf50258db4ebb833a6f7e709c818794d269674d6` (same source diff as its receipt's final `277be712514de6e608098123766cc7566f2a5610`), and packet 39 `04825712a8c7755c74095ecc52a5a79abaaab9b0`.
- Contract authority: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`, §4.9.6 and P13.
- Owned implementation and test files:
  - `packages/core/src/build/checkpoint.ts`
  - `tests/checkpoint/checkpoint.test.ts`
  - `docs/work/receipts/56-opt-in-context-checkpoints.md`
- Active effort: approximately 15 minutes, manually estimated; about 2 minutes of full-check wait. Model: GPT-6 Codex. The runtime did not expose the exact serving variant, effort setting, or token count.

## Behavior

- `build.context_bytes` omission disables checkpoints. Values below 16,000 are rejected; the threshold uses serialized history item bytes and array separators.
- At the threshold, one logical request uses the same builder model, role, prompt prefix, and run affinity in epoch `checkpoint-<turn>`. Its wire request has `tool_choice: "none"`; the current history plus a summarization instruction are sent to the developer port.
- A dispatched summary consumes its current turn. The result reports the next turn, retains the configured caps and repair progress, and receives the current remaining Build and rung budgets. It does not recreate approval, plan, or workspace state.
- Acceptance requires a complete text response with internally consistent raw response items, no tool calls/refusal, a nonempty summary, and a single user text item beginning with `Continuation of the same approved Build.\n\n`. The original approved request and plan bytes remain the continuation base. Their compacted history plus the checkpoint must fit `context_bytes`.
- Only after validation does the session move to the SHA-256 digest epoch for the canonical checkpoint item. The thread changes; cache affinity and protocol session identity stay the same. Invalid, empty, corrupt, or oversized output returns `continuation_failed` without replacing the active builder session.

## Validation

- Named local acceptance: `bun test --max-concurrency 1 tests/checkpoint` — **PASS**, 4 tests / 76 assertions. Covers P13 threshold/opt-in, no-tool wire request, summarizer and digest epochs, affinity, retained approved bytes/plan/worktree/caps, consumed turn accounting, and corrupt/empty/oversized stop behavior.
- Required final check: `GIT_CONFIG_GLOBAL=/dev/null make check` — **PASS**, 510 passed / 1 skipped / 0 failed across 511 tests (4,033 assertions). The skip is the existing Linux-mount case, requiring Linux user namespaces and bubblewrap. The final check ran after the final implementation changes. Earlier intermediate invocations stopped at formatting and then TypeScript errors; those were corrected before the passing run.
- Host: macOS 26.7.1, build 25G241, arm64, Darwin 25.6.0. Linux execution remains unverified.
- No directly owned standard B-set. Public P13 conformance was not run: `dist/kogen` is absent, and the packet owns no external B cases. **0 external cases / 0 instances launched**; no fake endpoint was used, so unmatched fake requests are **not applicable**. This is not an external conformance pass.
- Replay: packet 56 owns no mandatory xspec slice. Hand cases run: 0; seeds 17/23/41: not run; first divergence: not applicable.

## Pending integration and version gaps

- The helper is not yet called from the public rung/Build loop. I6 must invoke it before the next builder turn, persist `checkpoint_accepted` and continuation counts in the run journal, and expose the count through status. No root/composition/status files were changed under this packet's allowlist.
- The v1.2 frozen P13 CLI case was not exercised, and there is no frozen v1.3 executable oracle. No old assertion incompatibility was observed because no public case assertion ran; v1.2 compatibility and v1.3 parity are not claimed.
- The Linux host gate and public fake-provider request path remain unverified. No unmatched-request count can be claimed until the integrated fake-provider route runs.

**Next owner:** I6 coordinator for public Build wiring, journal/status integration, and P13 execution through the real fake-provider path; then the Linux integration owner for host coverage.
