# 21-immutable-approval-commit-and-cas

Goal: Immutable approval commit and CAS. Limit: 90 active minutes.

Dependencies: 20,15

## Owned files

`packages/core/src/approval/{commit,transition}.ts; tests/approval-ref/**`

## Goal

Byte snapshot/manifest/schema2/trailers, identity, late re-read, one lost-CAS retry and parent chain. Production transition exposed for xspec.

## Acceptance

B21; late Intent/test mutation and two concurrent approvers.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-21-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'approval-02,approval-04,approval-05,approval-06,approval-07,state-08,state-09,state-29,v1.2-02-approval-hash-intent-and-test-bytes' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/21-immutable-approval-commit-and-cas.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
