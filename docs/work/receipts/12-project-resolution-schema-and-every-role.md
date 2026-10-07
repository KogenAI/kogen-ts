# Packet 12 receipt — Project resolution, schema and every role

- **Base:** `e7c2d1d65d857213694eddff0ae8ef01a32b6185`
- **Implementation commit:** `faf71abdbea676765614146f369852af239784e1`
- **Branch:** `kts/12-project-resolution-schema-and-every-role`
- **Host:** macOS 26.7.1, arm64; Bun 1.4.2; Git 2.54.0
- **Effort:** approximately 13 active minutes. The serving model variant and token count are not exposed in this session's telemetry; the runtime identifies the agent as GPT-6.

## Owned files

- `packages/core/src/project/resolve.ts`
- `packages/core/src/project/schema.ts`
- `packages/core/src/project/roles.ts`
- `tests/project/resolve.test.ts`
- `tests/project/schema.test.ts`
- `tests/project/roles.test.ts`
- `docs/work/receipts/12-project-resolution-schema-and-every-role.md`

## Behavior

- Resolves relative and symlinked project paths to a canonical Git checkout, selects an explicit/local origin without fetching, and resolves the selected base branch/ref and 40- or 64-character commit ID. Computes the state-root key from the canonical checkout.
- Parses closed project and machine config schemas, applies project-field diagnostics together, reports YAML line diagnostics, validates check lists and safe setup paths, and refuses `build.auditor_demotion: true` with `build.auditor_demotion has no admitted calibration`.
- Defines the six admitted user roles, resolves project > machine > default independently for `model` and `effort`, reports requested/effective values and their sources, rejects cross-provider assignments, and exposes `fallback_shaper` only as an alias of the effective shaper. A configured `fallback_shaper` remains an unknown role.

The Grok table defaults all roles to `grok-4.6/high` to honor §4.10.1's rule that every role stays on Grok. The draft names Grok defaults specifically for builder and shaper, so applying Grok defaults to planner, auditor, reviewer, and context is an interpretation for coordinator review. The draft also names overload fallbacks for reviewer/context but does not separately state their primary defaults; this table uses Sol-high primaries and Sol-medium fallbacks on ChatGPT.

## Verification

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**. Biome, TypeScript, shell/native checks passed; 232 tests passed, 0 failed, 1 skipped (the real Linux mount test requires Linux user namespaces and bubblewrap); 2,205 assertions.
- Project local acceptance: `bun --no-install test --max-concurrency 1 ./tests/project`: **PASS**, 22 tests, 91 assertions, 0 failures.
- Required B12 command with cases `cli-23,state-03,state-13,state-16,v1.2-35-state-02-schema-errors`: **not executed against Kogen**. The runner returned 5 case errors across 7 instances because `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/12-project-resolution-schema-and-every-role/dist/kogen` does not exist. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-12-9h6lgq/results.jsonl`. No Kogen process started, so there were 0 fake requests; unmatched-request status is not applicable. These cases are pending public CLI wiring, not passes.
- Replay hand cases, seed counts, and first divergence: not run; packet 12 does not own an xspec slice.

## Version and integration gaps

`state-03` is incompatible with the v1.3-draft closed role/schema target: it expects `kogen status` to succeed with `build.ladder`, `build.budget_ms`, `build.fallback`, and legacy role names `fallback_shaper`, `rung2`, and `rung3`. The target explicitly keeps `fallback_shaper` unknown and the admitted role table has six names. This is a known fixture/spec version conflict from inspection; the missing executable prevented an official observed assertion result. No other named case was classified as incompatible.

Public CLI wiring and real Git integration remain pending. The coordinator owns project/CLI composition at I0; I0/I2 must wire this resolver and rerun B12 before packet acceptance. Linux host validation is also pending; `make check` ran on macOS and skipped its Linux-only real-mount test. No xspec replay or v1.3 conformance claim is made.
