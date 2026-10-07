# 40-guarded-commit-and-landing-cas

Goal: Guarded commit and landing CAS. Limit: 90 active minutes.

Dependencies: 15,16,19,21,23

## Owned files

`packages/core/src/build/landing/{transition,commit,publish,sync}.ts; tests/landing-cas/**`

## Goal

Squash sole parent/verified tree; public signing; durable landing record then incoming/ref CAS; clean checkout race-safe update, dirty warning, nonfatal cleanup.

## Acceptance

B40; exact parent/tree/record ordering and SHA256 repo crash points.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

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

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/40-guarded-commit-and-landing-cas.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
