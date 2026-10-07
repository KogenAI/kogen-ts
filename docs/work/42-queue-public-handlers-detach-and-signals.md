# 42-queue-public-handlers-detach-and-signals

Goal: Queue public handlers, detach and signals. Limit: 90 active minutes.

Dependencies: 01,24,25,38,39,40

## Owned files

`packages/core/src/queue/drain.ts; packages/cli/src/handlers/{queue,signals}.ts; tests/queue-command/**`

## Goal

Bind public start/stop to Build, buffered/streaming output/exits, handshake detach, stop marker, SIGINT/TERM custody and counts. Never mark a reducer-only queue complete.

## Acceptance

B42; runnable happy Build, signal status and two-checkout ownership.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-42-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'build-38,build-42,cli-29,custody-05,state-18,v1.2-124-build-31,v1.2-65-build-33,v1.2-66-build-34' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/42-queue-public-handlers-detach-and-signals.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass. Required merged integration receipt: I1.
