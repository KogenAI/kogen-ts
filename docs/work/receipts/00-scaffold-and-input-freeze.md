# Packet 00 — Scaffold and input freeze

Status: AWAITING_INTEGRATION
Base SHA: `041bc2ace953ab6e648b3041402034a6030822d2`
Head SHA: `48fae4be3bc3437b0ce820aeb574a8cec87f5cd1`
Active effort: approximately 30 minutes
Model: GPT-6; exact serving variant and token count are not exposed by this runtime.

## Changes

- Enforced the existing Bun, Git, TypeScript, Biome, and declaration pins from
  `toolchain.lock.json` during hermetic checks, including recorded binary hashes on
  the locked host.
- Added `tools/freeze.ts` to verify the e19dd1c v1.3-draft source, the dirty-tree diff,
  `CHANGES-v1.3.md`, `CLI-RULE.txt`, and every included source hash. The input manifest
  hash is `0a87fe0ef2ce82f61fef6e6da063622e25a1fda54dff1c229c6cc30c451437c5`;
  `CHANGES-v1.3.md` is `848b40d20be1900494302d318f4b6b106daa37279d4796212a75ec5242b99840`.
- Preserved the recorded hashes for two ignored generated `attempts.log` artifacts as
  explicit exclusions. Their bytes were absent from the bootstrap bundle. The verifier
  confirms all 896 included source files and requires both exclusions to remain absent.
- Added typed effect ports, clock, result/error, and effect event contracts. These are
  interfaces only; no reducer or runtime stub is counted as behavior acceptance.
- Added a read-only TypeScript DAG planner. It checks queue/package consistency and
  cycles, and counts a dependency only when its committed receipt names a merged or
  accepted commit reachable from the current HEAD. The dry-run does not launch workers,
  push, or remove worktrees. Worker-launch and integration hooks remain for later rounds.
- Made `make check` verify the source bundle and dispatcher state as part of its local,
  no-install check path.

## Owned files changed

- `Makefile`
- `package.json`
- `spec-lock/README.md`
- `spec-lock/manifest.json`
- `packages/core/src/contracts/clock.ts`
- `packages/core/src/contracts/errors.ts`
- `packages/core/src/contracts/events.ts`
- `packages/core/src/contracts/ports.ts`
- `tools/check.ts`
- `tools/freeze.ts`
- `tools/dispatch.ts`
- `docs/work/receipts/00-scaffold-and-input-freeze.md`

## Validation

- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS. Bun 1.4.2, locked Git 2.54.0,
  Biome, strict TypeScript, shell syntax, freeze check, dispatcher check, and all four
  local tests passed; 0 failures and 1,252 assertions.
- Blank-HOME/no-network smoke: PASS using a fresh empty HOME and
  `sandbox-exec -p '(version 1)(allow default)(deny network*)' /usr/bin/make check`.
- `make freeze`: PASS; 896 included files verified, with two documented ignored-log
  exclusions.
- `make dispatch-dry-run`: PASS; after the packet receipt was committed, packet 00 was
  awaiting integration and the other 65 were blocked by unmerged receipts or gates. No
  worker started.
- Local cases: `Bash 3 dry-run respects every DAG dependency and performs no dispatch
  writes` (PASS); `integration rejects a red check, preserves work, and admits the
  repaired commit` (PASS); `isolated checks never inherit user Git signing or identity`
  (PASS); `frozen source bytes still match their receipt` (PASS).
- Packet 00 has no B-set. Official conformance: not run; assigned cases/instances: 0;
  unmatched fake requests: 0 (no provider endpoint was used).
- Replay: not run by this packet; hand scenarios 0; seeds 17, 23, and 41 not run;
  first divergence: not applicable.

## Pending integration and version gaps

- Public CLI composition, xspec registration, and the actual worker/integration hooks
  are not present in this scaffold. They remain pending integration and are not passes.
- The frozen oracle remains v1.2; no v1.3 conformance claim is made. The inspected
  incompatible assertions are `v1.2-73-ladder-05` (expects A2 demotion and default
  landing), `v1.2-74-ladder-06` (expects an advisory verdict after demotion), and
  `v1.2-79-ladder-11` (expects demotion to make the R1 candidate land). The draft keeps
  audits observational, `demoted: false`, advisory items empty, and refuses
  `build.auditor_demotion: true` without admitted calibration. Other audit-related
  assertions remain for packet 45/I6 to classify against the actual scripts.
- The frozen bundle records open CHANGES-v1.3 findings 4/5/8/11–16 and un-migrated
  approve/recovery/session/gate observations. Prompt/effective-role experiment tables
  also remain to be frozen before experiments.
- Validation ran on macOS 26.7.1 (25G241), Apple silicon, with Bun 1.4.2 and Git 2.54.0.
  Linux tool-binary hashes and Linux acceptance remain pending a Linux host.

Next owner: coordinator for serialized integration and I0 wiring. After this packet is
merged, the DAG's next ready packets are 01, 02, 09, and 27.
