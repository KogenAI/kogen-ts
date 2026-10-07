# Packet 24 receipt — queue scheduler, claim and ownership

**Status:** Queue policy and Git claim CAS implemented; public-command acceptance awaits I2.

## Source and ownership

- Base SHA: `196005c8f5e676afd8f0953517b7328d3598ff9d`
- Source implementation head SHA: `b4c2722324c61fb630e82be60127deaf22b3e3ec` (the receipt is a docs-only follow-up).
- Dependencies present in the base: packet 12 `faf71abdbea676765614146f369852af239784e1`; packet 15 `03ca83b0112f99faf753dcd755d1363af7cdb9cd`; packet 23 `6111327ac4af6c7605792e67f03b0f502903051b`.
- Spec authority: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; read-only v1.2 conformance suite.
- Owned files changed:
  - `packages/core/src/queue/transition.ts`
  - `packages/core/src/queue/claim.ts`
  - `packages/core/src/queue/lock.ts`
  - `tests/queue-policy/transition.test.ts`
  - `tests/queue-policy/claim.test.ts`
  - `tests/queue-policy/lock.test.ts`
  - `docs/work/receipts/24-queue-scheduler-claim-and-ownership.md`
- Effort: approximately 20 active minutes, estimated because session-time telemetry is unavailable. Model: Codex / GPT-6 family; exact variant and effort were not exposed. Token count was unavailable.

## Behavior

- `selectQueue` filters to approved, unlanded Intents whose dependencies are delivered. It blocks unknown, invalid, undelivered, and cyclic dependency lists. Queue order is descending priority, ascending approval commit time, then UTF-8 slug order; a re-approval supplies a new tie-break time.
- The deterministic drain transition tracks each slug once per drain. It continues after ordinary failed Builds, removes skipped Intents without counting them as Builds, honors stop only after the current Build, and retains a drain-stopped approval for retry with the specified exit class.
- Queue lock policy compares PID and process start identity, treats dead or reused PIDs as stale, refuses takeover when identity is unknown, bounds stale takeover to two CAS attempts, and only releases for the current owner identity. The storage seam requires atomic owner publication/takeover with stop-marker clearing, plus stop-marker publication only while that exact owner remains current.
- Project claims use `refs/kogen/claim` and a parentless commit containing only `.kogen/claim` with the 32-hex run ID. Creation, stale takeover, and release use `git update-ref` create/CAS operations. Claim reads validate the commit/tree/trailer, stale takeover consults the saved owner identity, and an old claim handle cannot remove a replacement. SHA-1 and SHA-256 repositories are covered.

## Validation

- `bun test --max-concurrency 1 ./tests/queue-policy`: **PASS**, 19 tests, 68 assertions. Includes the synchronized real Git claim race and SHA-256 claim create/release.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: final invocation **PASS**, 251 passed, 1 skipped, 0 failed, 2,273 assertions. The skip is the Linux namespace/bubblewrap-only fixture on macOS. One preceding invocation timed out the existing `tests/fs-read/read.test.ts` parent-link race at its 5,000 ms limit; the subsequent exact invocation passed without source changes.
- Required B24 conformance invocation:

  ```sh
  ROOT="$(git rev-parse --show-toplevel)"
  SUITE="$ROOT/spec-lock/kogen-conformance"
  RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-24-XXXXXX")"
  chmod 700 "$RESULTS"
  mkdir -p "$RESULTS/work"
  "$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
    --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
    --case 'build-01,build-32,build-35,build-41' --jobs 3 --time-scale 0.02 \
    --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
  ```

  Result: **ERROR**, 0 pass / 0 fail / 4 errors / 0 skipped; each case expanded to 1 instance. All four errors are `FileNotFoundError` because `$ROOT/dist/kogen` does not exist. Results are at `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-24-nR3IyC/results.jsonl`. No Kogen process started and no fake provider request reached the server; unmatched-request assertions could not run. These are harness errors, not behavioral failures or passes.
- Replay: not owned by B24; hand scenarios run: 0; seeds 17/23/41 not run; first divergence: not applicable. Packet 58 owns the queue/status xspec adapter and replay closure.

## Pending integration and next owner

- There is no executable CLI or public queue drain in this bootstrap. I2 coordinator / packet 42 must wire the production transition, implement the atomic `QueueLockStorage` and process PID/start identity effects, and build `dist/kogen`. Then rerun B24 once against that integrated executable. The lock and process identity seams were exercised locally with deterministic fixtures; their host adapters are not claimed as integrated here.
- No incompatible v1.2 assertion could be evaluated because the executable was missing; no v1.3 parity claim is made. A versioned v1.3 queue oracle/replay remains under the spec and packet 58 process.
- Host: macOS 26.7.1 arm64. Linux queue behavior and real OS PID/start inspection remain unverified; `make check` skipped its Linux-only namespace fixture on this host.
- Next owner: I2 coordinator / packet 42 for wiring and host effects; packet 58 for mandatory queue/status replay; B24 closure owner for the named cases after I2.
