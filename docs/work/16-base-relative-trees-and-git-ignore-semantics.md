# 16-base-relative-trees-and-git-ignore-semantics

Goal: Base-relative trees and Git ignore semantics. Limit: 90 active minutes.

Dependencies: 03,04,15

## Owned files

`packages/core/src/workspace/{snapshot,ignore,clone}.ts; tests/workspace/**`

## Goal

Fresh local no-hardlink clone; snapshot saved base paths regardless of builder HEAD; nested ignore/negation engine through trusted Git, raw index entries and link/mode/deletion handling.

## Acceptance

B16; tracked-ignored retained, untracked-ignored omitted; non-ignored edits retained.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-16-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-123-custody-10,v1.2-64-build-30' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/16-base-relative-trees-and-git-ignore-semantics.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
