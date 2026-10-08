# B50 — Optional witness proof and reuse

## Status and source

**Implementation prepared; public/integration acceptance is pending.** The
branch started at base `999a78cde4c4c0dec2f65ff509c468355562075e`. The code and
test commit is `2b7c58d` (`Add optional witness proof and reuse`). Dependencies
39, 44, 45 and 48 are ancestors of that commit. The required I2 receipt still
states “prepared for coordinator review; I2 has not been accepted,” and this
worktree has no executable `dist/kogen`; this receipt does not claim B50 or I2
integration acceptance.

## Changed behavior

- Shape can run the real R1 witness gate in a throwaway workspace; hard
  difficulty explicitly requests parallel R1/R2. The witness path cannot
  demote a rung. Red results enter a bounded, tool-less auditor adjudication
  loop. Only complete, unambiguous advice can select test-side or
  witness-side repair; test edits are revalidated, and witness-only repair is
  rejected if it changes acceptance bytes. Invalid or unresolved evidence
  remains unproven and cannot produce a witness record.
- A proven record binds the commit, raw binary diff SHA-256 and base SHA. The
  witness ref is create-only; a conflicting ref refuses proof. Build checks
  approval metadata, the exact ref and diff, applies the witness commit in a
  throwaway workspace on the current base, then invokes the sandboxed gate
  with model calls and auditor demotion disabled. A stale ref/diff or red
  recheck returns `ladder`, so the caller can enter the ordinary ladder. A
  green result returns its verified workspace as the witness Build candidate.
- The modules expose effect ports for production composition; the public CLI
  does not yet call them in this bootstrap. Therefore the local tests verify
  policy behavior, not a public real-gate or landing pass.

## Owned files

- `packages/core/src/shape/witness.ts`
- `packages/core/src/build/witness.ts`
- `tests/witness/witness.test.ts`
- `docs/work/receipts/50-optional-witness-proof-and-reuse.md`

The B50 row has no finding assigned in `docs/work/REVIEW-MIDBUILD.md`. Finding
#7 is assigned to packages 38/44 and coordinator package 23; the serialized
writer and interleaving regression are already recorded in the B44/I2 work.
No additional B50 change was needed for that finding.

## Checks

Local witness tests:

```sh
GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/witness
```

**PASS:** 12 tests, 45 expectations, zero failures.

Required repository check:

```sh
GIT_CONFIG_GLOBAL=/dev/null make check
```

**PASS:** format, lint, TypeScript, shell, native and isolated test checks;
632 passed, 1 skipped, 0 failed, 4,895 expectations across 633 tests in 81
files. The skipped case is the Linux-only real mount test on this macOS host.

Named frozen conformance command, run once as specified:

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-50-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-100-ladder-32,v1.2-101-ladder-33,v1.2-135-shape-26' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

**Harness errors before launch, not assertion results:** 3 cases, 4 instances;
0 pass, 0 assertion failures, 3 case errors, 0 skipped or unimplemented.
`v1.2-100-ladder-32` and `v1.2-101-ladder-33` each have one launch error;
`v1.2-135-shape-26` has two. All four report `FileNotFoundError` for the
missing `$ROOT/dist/kogen`. No provider requests reached the fake server and
there were 0 unmatched fake requests. Results:
`/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-50-CZIuf2/results.jsonl`.

### Frozen v1.2 assertion incompatibility

The named suite could not execute assertions because the CLI binary is missing.
By inspection, first-request `turn: 1` expectations in these frozen cases are
incompatible with the required v1.3 initial developer input item:

- `v1.2-100-ladder-32`: `shape.write` (shaper) and `wit.edit` (builder).
- `v1.2-101-ladder-33`: `shape.write` (shaper), `wit.edit` (builder), and
  `b1.start` (builder).
- `v1.2-135-shape-26`: in both rows, `write` (shaper), `plan` (planner), and
  the builder's first step (`edit` or `c1`).

The frozen runner's `fake_server.py::compute_turn` returns turn 1 only when the
request has exactly one input item and exactly one user message. The required
developer input item makes those initial requests contain more than one item,
so the frozen turn assertion cannot match. This is the same v1.2/v1.3 conflict
documented by I2; the frozen suite was not modified.

## Replay, effort and remaining integration

- Mandatory hand/replay slices: none assigned to B50. Hand count 0; seeds
  17/23/41 not run; first divergence N/A. No xspec closure is claimed.
- Host: macOS 26.7.1 arm64, Git 2.54.0, Bun 1.4.2. Linux validation remains
  open in `docs/work/DEFERRED-LINUX.md`.
- Effort: approximately 15 active minutes; about 2 minutes were unattended
  check time. Agent: GPT-6 Codex; exact deployed model identifier and
  token accounting were not exposed by the runtime.
- Pending: coordinator acceptance of I2 and production binding of the effect
  ports to the real Shape/Build gate, durable create-only witness ref and
  landing flow. Public Shape composition is assigned to I5. Re-run the exact
  named conformance command once the coordinator produces `dist/kogen`; its
  current result is not a pass. The v1.2 turn-counter conflict remains a
  frozen-version gap, and Linux remains unverified.
- Next owner: coordinator for I2 composition/acceptance and executable CLI;
  I5 for public Shape composition. B50's modules alone are not integration
  acceptance.
