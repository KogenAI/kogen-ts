# 06 — Child environment and script transport receipt

**Status:** Implemented; awaiting integration acceptance.

## Source and effort

- Base SHA: `c638629cabcded56d79ccc4470de69633c3139ea`
- Implementation commit/head SHA: `e10c290fad410a1c2d7d43056098ce895873a5a2` (`Implement child environment and script transport`). The receipt is a separate follow-up commit.
- Dependency 05 is present in the base, including its TypeScript supervisor and native supervisor source.
- Exact owned files changed:
  - `packages/core/src/process/environment.ts`
  - `packages/core/src/process/script.ts`
  - `tests/environment/environment.test.ts`
  - `docs/work/receipts/06-child-environment-and-script-transport.md`
- Active effort: approximately 10 minutes; estimated because worker-time telemetry is unavailable. Check runtime was brief.
- Model: Codex/GPT-6. Serving variant, effort label, and token count were not exposed by the runtime.
- Host: macOS arm64; Bun 1.4.2 and Git 2.54.0. Linux was not available for this packet.
- Frozen target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.

## Behavior

- Child environments start from the §5.2 allowlist: standard locale/user/shell values, proxy variables, `GIT_*` and `MISE_*`; `MIX_HOME` and `HEX_HOME` are admitted for ExUnit. Host `KOGEN_*`, provider credentials, editor/runtime variables, and the host `TMPDIR` are not copied. Bun runtime directories are removed from inherited `PATH`; callers can specify additional runtime paths.
- `TMPDIR` points into the run directory. When mise is found on the host `PATH`, the builder invokes `mise env -C <workspace> --json --quiet` through the process port with a fixed 30-second timeout, independently of `KOGEN_TIME_SCALE`. Its state/cache and trusted config paths are scoped to the run, and mise's binary directory is prepended to the returned `PATH`.
- Mise output is validated as a bounded UTF-8 JSON string map. The project environment is merged last; a project `PATH` is returned byte-for-byte as supplied, and project `KOGEN_*` variables are refused.
- Shell commands are atomically written through the filesystem port under a unique, short path in the run directory with mode `0600`. The process receives only `sh` and that path in argv. Script bytes and optional stdin are copied without truncation, and the supplied project timeout is passed directly to the process port without scaling.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 ./tests/environment`: **PASS**, 4 tests / 0 failures / 32 expectations. Covers host allowlisting and runtime-path removal, mise timeout/state/cache/trust/PATH precedence, a 300 KiB private script plus stdin byte preservation and unchanged project timeout, and rejection of project Kogen controls.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: final run **PASS**, 181 tests / 0 failures / 1,893 expectations. Biome, TypeScript, shell syntax, frozen-input and dispatcher checks, warning-clean native compilation, and the isolated suite passed.
- One preceding full-check run had 180 passes and one unrelated packet 05 timing failure: escaped-session `durationMs` was 518 ms against a 600 ms lower bound. The separate diagnostic command `GIT_CONFIG_GLOBAL=/dev/null bun test --max-concurrency 1 ./tests/custody/supervise.test.ts -t 'an escaped session is outside group custody and cannot hold output open forever'` passed 1/1; the subsequent full check passed. No packet 05 files were changed.
- No direct B-set is assigned to packet 06; **0 black-box cases / 0 instances** were run. There is no executable `dist/kogen`, so missing public wiring is pending integration, not a pass. No fake HTTP/provider requests were made; unmatched fake requests: **0**.
- Replay is not assigned to this packet: hand cases **0**, seeds 17/23/41 not run, first divergence not applicable.
- No incompatible frozen v1.2 assertion was assessed because this packet owns no black-box cases.

## Pending integration and next owner

The owned tests exercise injected filesystem and process ports. The native helper currently has no product registration for filesystem publication (`0x0302`) or process supervision (`0x0303`), and the bootstrap has no CLI composition or `dist/kogen`. The coordinator/integrator owns native registration and wiring at I0; public Build and shell behavior remain for I2. Recheck on Linux is also pending. This packet is implemented locally, not integration-accepted and not a v1.3 conformance claim.
