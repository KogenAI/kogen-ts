# 26-recovery-preservation-before-cleanup

Goal: Recovery preservation before cleanup. Limit: 90 active minutes.

Dependencies: 16,23,24,40

## Owned files

`packages/core/src/recovery/{transition,recover}.ts; tests/recovery/**`

## Goal

Dead-owner/start-time check; preserve all unsnapshotted workspace trees as create-only unverified recovery refs/archive before removal; persist recovery_preserved/run.json.recovery, adopt complete prior publication, retain differing progress separately, retry terminal cleanup_pending and owner-only release.

## Acceptance

B26; draft D3 matrix, preservation failure retains workspace.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-26-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'build-36,build-37,state-21,v1.2-06-crash-after-base-cas' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/26-recovery-preservation-before-cleanup.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
