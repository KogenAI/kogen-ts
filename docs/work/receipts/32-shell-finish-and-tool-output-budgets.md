# 32 — Shell, finish and tool-output budgets receipt

**Status:** Implemented locally; awaiting I2 integration acceptance.

## Source and effort

- Base SHA: `98bb15412435b9c2fc66477f33c9dae4e09c8154`.
- Implementation commit/head SHA: `d5af85b3111d36b9a3c3431a8e815600df603629` (`Implement shell and tool output budgets`). This receipt is a separate follow-up commit.
- Dependency commits in the base: packet 06 `0a01ba3` (private script transport), packet 23 `6111327` (durable run/request journal and redaction), and packet 31 `f80f260` (tool schemas, dispatch, and file tools).
- Exact implementation files:
  - `packages/core/src/provider/tools/shell.ts`
  - `packages/core/src/provider/tools/finish.ts`
  - `packages/core/src/provider/tools/output.ts`
  - `tests/shell-tools/tools.test.ts`
  - `docs/work/receipts/32-shell-finish-and-tool-output-budgets.md`
- Active effort: approximately 7 minutes, estimated; about 2 minutes of test/conformance wait. Worker-time telemetry is unavailable.
- Model: GPT-6 runtime; serving submodel, effort label, and token count were not exposed.
- Host: macOS arm64; Bun 1.4.2 and Git 2.54.0. Linux was not available for this packet.
- Frozen target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.

## Behavior

- Shell commands are written through packet 06's private-script filesystem port at mode `0600`. The supervised child receives `sh` plus the short script path, an empty stdin stream, the workspace as cwd, and a fixed 120-second deadline (scaled only through the explicit harness seam). The model command is not placed in argv; stderr is merged into stdout by the script.
- Shell output appends the exit status, or starts with the fixed timeout notice. Invalid UTF-8 becomes the full-payload `[non-UTF-8 output, base64 encoded]` form. Process-log errors use the normative unavailable notice.
- Output is redacted before SHA-256 handle derivation. When clipping is needed, the full redacted text is written mode `0600` to `logs/tool-result-<sha256>.log`; the result uses UTF-8-safe head/tail byte ranges and the exact range notice. `tool_output` validates the lowercase digest, reads only a regular file through the safe filesystem port, and returns inward-aligned UTF-8 byte ranges.
- Finish exposes the exact finish-alone and text-continuation messages. Its pure evaluation allows a valid sole `{}` finish to run the gate, asks for implementation after the first unchanged finish, and permits the second unchanged finish to run the gate.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 ./tests/shell-tools`: **PASS**, 8 tests / 0 failures / 42 expectations. Covers a >300 KiB heredoc with exact file bytes on disk, private mode and argv bounds; timeout scaling with the fixed visible notice; exact 8,000-byte range notice and full output file; redaction-bound handles; UTF-8 boundaries; complete binary base64; regular-file/digest/symlink checks; finish-alone, text continuation, and first/second empty finish.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 361 tests / 0 failures / 1 OS-specific skip / 3,104 expectations. The skipped case is `real Linux mounts require Linux user namespaces and bubblewrap`; host was macOS arm64. Biome, TypeScript, shell syntax, input freeze, dispatcher checks, native compilation, and isolated tests passed.
- Exact B32 conformance command from the brief, selecting `v1.2-121-custody-08,v1.2-31-provider-23-tool-result-budget`: **not accepted**. The runner recorded 0 passed, 0 failed, 2 harness errors across 2 instances because `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/32-shell-finish-and-tool-output-budgets/dist/kogen` does not exist (`FileNotFoundError`). The fake provider received no requests; unmatched fake requests: **0**. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-32-sP9HEk/results.jsonl`.
- Replay: this packet owns no xspec slice; hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.
- Exact incompatible historical v1.1 assertions: `provider-23` expected the retired 10,000-character tail clip and partial base64 marker, and treated text as completion; `custody-08` treated text as completion and omitted `finish`. The frozen v1.2 profile supersedes these with the two requested replacement cases. No v1.3 suite is available, so this is not a v1.3 conformance claim.

## Pending integration and next owner

The coordinator/integrator owns I2 wiring and public Build acceptance. It must register these handlers with provider dispatch and pass the run/workspace paths, packet 06 child environment, supervised process and filesystem ports, and resolved output budget. The Build controller must consume `evaluateFinish` so only a valid sole finish reaches the gate and the empty-finish counter persists across turns. The public `dist/kogen` is not wired in this bootstrap, so both B32 cases remain pending. Linux parity and a matching v1.3 oracle also remain pending.
