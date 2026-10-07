# 39-develop-verify-repair-rung-machine

Goal: Develop/verify/repair rung machine. Limit: 90 active minutes.

Dependencies: 18,19,32,38

## Owned files

`packages/core/src/build/{rung,develop,repair}.ts; tests/rung/**`

## Goal

Persistent conversation, finish/text/empty semantics, six repairs/count progress/unchanged/protected restores, final verify/snapshot on turn/wall/budget cap.

## Acceptance

B39; verified tree identity survives model commits and controller notes.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-39-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-39-build-04,v1.2-40-build-05,v1.2-41-build-06,v1.2-42-build-07,v1.2-43-build-08,v1.2-97-ladder-29' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/39-develop-verify-repair-rung-machine.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
