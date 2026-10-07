# 22-remove-lifecycle

Goal: Remove lifecycle. Limit: 75 active minutes.

Dependencies: 21,24

## Owned files

`packages/core/src/approval/remove.ts; tests/remove/**`

## Goal

Draft commit of own paths; force/ref CAS/active-build/untracked checks; preserve unrelated user changes and normal identity.

## Acceptance

B22; active-build case closes after queue integration.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-22-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'approval-22,approval-23,approval-24' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/22-remove-lifecycle.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
