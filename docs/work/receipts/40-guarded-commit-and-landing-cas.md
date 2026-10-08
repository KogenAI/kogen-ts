# B40 — Guarded commit and landing CAS

## Revision and scope

- Base SHA: `1ec5fe7bd108408fe935f94fef4a001c244b2781`
- Tested implementation HEAD: `38eceb7263badfad217555ce09fdc820629c277a`
- Spec authority: v1.3-draft `e19dd1c`; frozen conformance suite: v1.2.
- Active time: approximately 25 minutes (estimate; no authoritative session timer was available; within the 90-minute limit).
- Model: GPT-6-based Codex; exact serving variant and token telemetry are not exposed in this session.

## Changed behavior

The landing commit is created from the verified tree with exactly the expected sole parent and normative title/`Kogen-Intent` message. It uses the public Git identity and signing configuration, requests `-S` when public `commit.gpgsign` is enabled, and bypasses hooks. A missing tree is transferred from the private metadata repository through a temporary ref.

Publication durably appends `commit_result`, then persists `landing_prepared` and `run.json.landing` before publishing `refs/kogen/incoming/<run_id>` and compare-and-swapping the target branch from the expected parent. SHA-1 and SHA-256 object formats are checked. Clean checkouts are updated with a race-safe Git tree operation; dirty or raced checkouts retain their edits and receive the specified warning. Incoming-ref cleanup failure remains landed, records `cleanup_failure`, and marks cleanup pending.

## Exact owned files

- `packages/core/src/build/landing/transition.ts`
- `packages/core/src/build/landing/commit.ts`
- `packages/core/src/build/landing/publish.ts`
- `packages/core/src/build/landing/sync.ts`
- `tests/landing-cas/landing.test.ts`
- `docs/work/receipts/40-guarded-commit-and-landing-cas.md`

## Checks

- `bun test tests/landing-cas`: **10 passed, 0 failed, 87 expectations**. Covers SHA-1 and SHA-256 sole-parent/tree/message checks, public identity and signing configuration, durable record ordering, SHA-256 crash points, checkout race preservation, lock refusal, and nonfatal cleanup.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**. Format, lint, types, shell, native checks, and full test suite passed: **413 passed, 1 skipped, 0 failed, 3472 expectations**. The skip is the Linux mount test, unavailable on this macOS host.
- Required frozen case `v1.2-67-build-43` was run once with the specified profiles, jobs, and time scale. Result: **0 passed, 0 failed, 1 error, 0 skipped, 0 unimplemented; 1 instance**. Harness error: `FileNotFoundError` for the absent `dist/kogen` executable. No provider request reached the fake server; unmatched fake requests: **0**. This is pending CLI integration, not a pass. Result file: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-40-iv8k8Y/results.jsonl`.

Exact invocation:

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-40-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-67-build-43' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Replay and integration gaps

- B40 replay was not run: this packet has no assigned mandatory xspec slice. Hand count and seeds 17/23/41 are **not run**; first divergence is **not observed**. B59 owns the landing/recovery xspec slice and must provide that replay evidence; no replay acceptance is claimed here.
- CLI wiring is absent (`dist/kogen` was not built). Next owner: coordinator/integration, then rerun the frozen case against the integrated CLI.
- Host: macOS 26.7.1 arm64; the Linux-only mount test remains unverified on Linux. The frozen suite identifies itself as v1.2, so this run provides no v1.3 conformance evidence.

Successful worker checks do not constitute integration acceptance.
