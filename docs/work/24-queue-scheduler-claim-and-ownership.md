# 24-queue-scheduler-claim-and-ownership

Goal: Queue scheduler, claim and ownership. Limit: 90 active minutes.

Dependencies: 12,15,23

## Owned files

`packages/core/src/queue/{transition,claim,lock}.ts; tests/queue-policy/**`

## Goal

Priority/time/slug, dependencies/cycles, per-origin claim, owner PID/start identity, stale locks, once-per-drain and stopped semantics.

## Acceptance

B24 after I2; deterministic transition and real claim-race smoke now.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-24-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'build-01,build-32,build-35,build-41' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/24-queue-scheduler-claim-and-ownership.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
