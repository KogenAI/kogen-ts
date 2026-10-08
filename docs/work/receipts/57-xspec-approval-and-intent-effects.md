# Packet 57 receipt: xspec approval and Intent effects

## Changes

Implemented a long-lived UTF-8 JSON-lines xspec process with strict `reset` and
`apply` requests, per-event full observations, fatal malformed-request handling,
and separate `approve` and `intent` slices. The fixture driver creates an
isolated real Git origin and checkout, reads and hashes exact source bytes,
commits approvals through the production approval transition, injects real
compare-and-swap races, and exercises tracked source removal. Late Intent and
acceptance mutations are injected on the production second read and must leave
the approval ref unchanged.

Symbolic fixture identities and their byte/hash mappings are documented in
`tests/xspec-approval/README.md`. The Quint `prefixOk` event field remains part
of the wire schema but does not drive fixture hash outcomes; the adapter
calculates prefix validity from source bytes.

Owned files:

- `packages/xspec/src/protocol.ts`
- `packages/xspec/src/main.ts`
- `packages/xspec/src/slices/approve.ts`
- `packages/xspec/src/slices/intent.ts`
- `packages/test-support/src/approval-fixture.ts`
- `tests/xspec-approval/fixture.test.ts`
- `tests/xspec-approval/README.md`
- `docs/work/receipts/57-xspec-approval-and-intent-effects.md`

## Revisions and environment

- Base: `147515cf5c1786bb3d20eabbd144dbe33deaedc8`
- Implementation commit: `14449a698ca13c73549f7143e5abb27408182c3b`
- Implementation head: `14449a698ca13c73549f7143e5abb27408182c3b`
- Host: macOS 26.7.1, arm64
- Model: Codex runtime; exact model identifier is not exposed to this worker.
- Active time: approximately 80 minutes by manual estimate, including the
  required real-Git replay wall time. The runtime exposes neither an exact active
  time counter nor token usage.

## Checks

- `bun --no-install test --max-concurrency 1 ./tests/xspec-approval`: **8
  passed, 0 failed, 38 expectations**.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **433 passed, 1 skipped, 1 failed**.
  The failure is outside this packet: `tests/approval-ref/commit.test.ts`,
  “missing public Git identity refuses without creating an approval ref,”
  expected `false` and received `true`. The exact isolated test also fails.
  With the fixture's empty HOME, disabled global/system Git config, and local
  identity removed, this host synthesizes
  `Almir Sarajčić <almirsarajcic@Almirs-Mac-Studio.local>` from account defaults.
  This test is owned by the approval-ref packet/coordinator and was not changed.
  Isolated diagnostic command:
  `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 --test-name-pattern 'missing public Git identity refuses without creating an approval ref' tests/approval-ref/commit.test.ts`.
- The host-specific Linux namespace/bubblewrap case was skipped on macOS.
- Xspec fixture HTTP requests: none; unmatched fake requests: **0**.

## Quint replay

Pinned Quint `@informalsystems/quint@0.33.0` dependencies were provisioned in
private scratch copies under `/tmp/kogen-xspec-57`; frozen repository bundles
were not modified. The copied
approve hand scenarios needed a scratch-only migration adding `baseTree` to the
event schema and representing baseline cache keys as `(baseTree, cacheKey)`.
Approve hand spec: **18/18**. Intent hand spec: **7/7**. Each generated replay
requested 500 traces × 25 steps for seeds 17, 23, and 41. Seed-separated copies,
golden inputs, and logs are kept in `/tmp/kogen-xspec-57/seed-copies` and
`/tmp/kogen-xspec-57/replays`.

Replay conform results and first divergences:

| Slice | Seed | Hand | Generated | Total conform | Steps | First divergence |
|---|---:|---:|---:|---:|---:|---|
| approve | 17 | 18/18 | 500/500 | 518/518 | 12,550 | none |
| approve | 23 | 18/18 | 500/500 | 518/518 | 12,550 | none |
| approve | 41 | 18/18 | 500/500 | 518/518 | 12,550 | none |
| intent | 17 | 7/7 | 430/500 | 437/507 | 11,870 | `g0017`, step 6: symbolic `abcd1234` with generated `prefixOk:false` and `race:"twice"`; model expects hash mismatch before CAS, fixture derives a matching source-byte digest and observes two real CAS losses. |
| intent | 23 | 7/7 | 429/500 | 436/507 | 11,885 | `g0017`, step 5: same generated `prefixOk:false` versus source-byte-bound hash behavior. |
| intent | 41 | 7/7 | 426/500 | 433/507 | 11,853 | `g0018`, step 8: same generated `prefixOk:false` versus source-byte-bound hash behavior. |

The full conformance command was run from the copied `quint/prototype` for each
seed-separated scratch tree, with `ROOT` set to this worktree:

```sh
XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py spec
XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
```

The Intent generated divergences are draft model/generator disagreements over
`prefixOk`; the adapter follows the requirement to derive hash behavior from
real source bytes. No projection or trace subset was used.

Approve generation retained the following accepted/refused event counts across
12,500 events per seed; all invariants held:

- Seed 17: 517 accepted, 11,983 refused.
- Seed 23: 516 accepted, 11,984 refused.
- Seed 41: 510 accepted, 11,990 refused.

## Compatibility and integration

The frozen v1.2 suite remains unchanged and was not run as v1.3 conformance.
The exact incompatible approval assertions use the v1.2 Intent-only digest:
`approval-01-card-golden.json`'s `SHA-256: {hash64:greet}` card,
`approval-02-hash-prefixes.json`'s prefix/ref trailer values, and
`approval-03-mismatch-before-checks.json`'s `{hash8:greet}` mismatch output.
The v1.3-draft approval digest includes exact Intent bytes, a NUL separator,
and acceptance/test bytes.

There is no executable public CLI in this bootstrap. This packet builds a
private `dist/kogen-xspec` executable only for replay. Registry/native
registration and public composition remain pending integration; the coordinator
owns that wiring. Linux behavior remains unverified because the current host is
macOS and the Linux namespace case skipped. No directly owned standard B-set
was run.

## Next owner

Coordinator: integrate the xspec registry/native registration and public
composition, resolve the host-derived identity behavior in the approval-ref
owner's scope, then run integrated acceptance on supported OSes.
