# Packet 58 receipt — xspec queue and status

## Source and ownership

- Base SHA: `cfc9340c898b15e2485461597eea41aa8ab45f2d`
- Implementation commit: `92b8575` (`feat(xspec): add queue and status replay slices`)
- Spec authority: v1.3-draft source `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Frozen Quint input copied from `spec-lock/kogen-spec/quint`: 366 files,
  aggregate SHA-256 `36ecb7808cde7dc5b9968fef4aab64c967487be8a8c99c836cda54b8f680f262`.
- Host: macOS 26.7.1 (25G241), arm64. Linux behavior was not run.
- Active effort: approximately 13 minutes by elapsed-session estimate. Model:
  Codex GPT-6; exact serving variant and effort were not exposed. Token usage
  was unavailable.
- Exact owned files:
  - `packages/xspec/src/slices/queue.ts`
  - `packages/xspec/src/slices/status.ts`
  - `tests/xspec-queue-status/slices.test.ts`
  - `docs/work/receipts/58-xspec-queue-and-status.md`

Dependencies 24, 25, and 57 are present at the supplied base.

## Behavior

- Queue events use exact closed schemas and feed `Enqueue`, `Start`, `Halt`,
  `Outcome`, and refresh behavior through the shared queue scheduler. In-memory
  owner/process effects call the shared queue-lock acquire, stop, liveness, and
  release policies. Observations retain the complete ordered queue, owner,
  current-build, count, stop, line, and exit fields. Finished drains clear the
  attempt set for the next drain while retaining approvals after provider stops.
- Status `Row` and `Raw` events inject approvals, reachable landing refs, run
  records/journals, claim ownership, owner liveness, queue state, and agents into
  the shared `deriveStatus` input. The adapter also calls the shared status
  renderer and returns all 21 model observation fields. Queue order, sections,
  next item, landed history, elapsed bucket, watch status, and exit are not
  reduced to a projected subset. Typed blocked reasons are rendered using the
  frozen Quint text forms; scheduling-error text is supplied by the fixture row
  because `StatusInput` has no scheduling-error field.
- Unknown tags, extra/missing fields, and wrong field types raise
  `XspecProtocolError`. The shared protocol path reports malformed JSON,
  unknown operations, and unknown events with exit 70.

## Local validation

- `bun --no-install test --max-concurrency 1 ./tests/xspec-queue-status`:
  **PASS**, 8 tests, 34 expectations.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**, 463 passed, 1 skipped,
  0 failed, 3,687 expectations. The skip is the existing Linux namespace and
  bubblewrap fixture on this macOS host.
- Scratch process checks for invalid JSON, an unknown operation, and unknown
  queue/status event tags each exited **70**. No HTTP requests were made;
  unmatched fake requests: **0**.
- No standard B-set is directly assigned to packet 58. No standard CLI case was
  counted as a pass.

## Mandatory Quint replay

Pinned `@informalsystems/quint@0.33.0` was provisioned in the private copy before
checks. The frozen bundle was not changed. Hand `spec` runs passed **queue 9/9**
and **status 8/8**. Each seed has a separate copied Quint tree and generated
corpus under `/tmp/kogen-xspec-58/seed-copies/{slice}-{seed}`; logs are under
`/tmp/kogen-xspec-58/logs`.

The copied hand tree was `/tmp/kogen-xspec-58/hand/quint/prototype`; each
`gen` and `conform` ran from its named seed copy. Quint's `node_modules` came
from the private exact-version install.

```sh
HAND=/tmp/kogen-xspec-58/hand/quint/prototype
cd "$HAND"
XSPEC_SLICE="../slices/queue" python3 -B harness/xspec.py spec
XSPEC_SLICE="../slices/status" python3 -B harness/xspec.py spec

ROOT=/tmp/kogen-xspec-58/adapter-root
for slice in queue status; do
  for seed in 17 23 41; do
    COPY="/tmp/kogen-xspec-58/seed-copies/${slice}-${seed}/quint/prototype"
    cd "$COPY"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed "$seed"
    XSPEC_SLICE="../slices/$slice" python3 -B harness/xspec.py conform -- "$ROOT/dist/kogen-xspec" "$slice"
  done
done
```

| Slice | Seed | Generation events accepted / refused | Hand | Generated | Conform total | Compared steps | First divergence |
|---|---:|---:|---:|---:|---:|---:|---|
| queue | 17 | 7,901 / 4,599 | 9/9 | 500/500 | 509/509 | 12,544 | none |
| queue | 23 | 7,909 / 4,591 | 9/9 | 500/500 | 509/509 | 12,544 | none |
| queue | 41 | 7,899 / 4,601 | 9/9 | 500/500 | 509/509 | 12,544 | none |
| status | 17 | 12,500 / 0 | 8/8 | 500/500 | 508/508 | 12,533 | none |
| status | 23 | 12,500 / 0 | 8/8 | 500/500 | 508/508 | 12,533 | none |
| status | 41 | 12,500 / 0 | 8/8 | 500/500 | 508/508 | 12,533 | none |

All final `conform` runs compared full observations, with no `--project`, seam
substitution, or observation-field filtering. Since this packet does not own
`packages/xspec/src/main.ts` or `registry.ts`, the private replay command used a
temporary scratch executable that imports the two slice factories and shared
protocol directly. Its passing results validate these adapters and their shared
transitions; they do not establish central registration or release integration.

## Pending integration, version, and platform gaps

- The repository xspec `main.ts`/registry still selects only `approve` and
  `intent`; `dist/kogen-xspec` is not built from a registered queue/status
  entrypoint, and there is no public `dist/kogen`. Central registration and
  composition belong to the coordinator. Queue/status public behavior remains
  pending I1/I2/I3 integration; this receipt is not integration acceptance.
- The frozen v1.2 status case `v1.2-132-state-23-slug-reuse.json` conflicts with
  v1.3-draft §2.11: it expects an edited Intent under a still-reachable
  `Kogen-Intent: greet` trailer to become draft, queued, and buildable again.
  Under the target, the reachable trailer wins and status remains landed. The
  case was not run because the public executable is absent; this is a version
  conflict, not a target pass or failure.
- macOS was the only host used. Linux slice, public CLI, and release behavior
  remain unverified. Next owner: coordinator for registry/composition and I3
  integration, then the assigned public-case owners once `dist/kogen` exists.
