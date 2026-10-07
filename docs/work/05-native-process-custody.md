# 05-native-process-custody

Goal: Native process custody. Limit: 90 active minutes.

Dependencies: 02,04

## Owned files

`native/{supervisor.c,supervisor.h}; packages/core/src/process/supervise.ts; tests/custody/**`

## Goal

Session/group exec, output pumps/tail, monotonic wall deadline, TERM/200ms/KILL, normal-exit grandchildren, parent-death control pipe. Linux subreaper and macOS process identity.

## Acceptance

B05; real chatty/TERM/grandchild/SIGKILL tests, no argv element >4KiB.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-05-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'custody-01,custody-02,custody-03,custody-04' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/05-native-process-custody.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
