# 19-protected-manifests-and-restorers

Goal: Protected manifests and restorers. Limit: 90 active minutes.

Dependencies: 12,14,16,18

## Owned files

`packages/core/src/gate/{manifest,protect,scope}.ts; tests/protection/**`

## Goal

Effective gate program paths/globs/absent literals, stale checkout, changes_gate; restore after batches and guard before verify/commit; scope advice only.

## Acceptance

B19; hostile symlink/type replacements and 4th-restore rule.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-19-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'approval-14,approval-15,approval-16,v1.2-127-build-10,v1.2-44-build-09,v1.2-55-build-21' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/19-protected-manifests-and-restorers.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
