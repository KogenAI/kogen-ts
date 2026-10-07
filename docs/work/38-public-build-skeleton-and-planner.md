# 38-public-build-skeleton-and-planner

Goal: Public Build skeleton and planner. Limit: 90 active minutes.

Dependencies: 20,21,24,29,30,32,33,34

## Owned files

`packages/core/src/build/{controller,planner,load}.ts; tests/build-entry/**`

## Goal

Wire B0 approval integrity/claim before provider, run/base/setup/base acceptance, one plan/difficulty and roles, happy-path B0-B10 with injected rung/landing ports.

## Acceptance

B38; real public command binding at I2; tampered approval sends no model request.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-38-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'build-39,build-40,state-10,v1.2-126-state-15,v1.2-37-build-02,v1.2-38-build-03,v1.2-56-build-22,v1.2-57-build-23,v1.2-69-ladder-01' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/38-public-build-skeleton-and-planner.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I1.
