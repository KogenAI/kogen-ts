# 30-canonical-sessions-and-wire-shapes

Goal: Canonical sessions and wire shapes. Limit: 90 active minutes.

Dependencies: 12,23,29

## Owned files

`packages/core/src/provider/session/{transition,history,wire,keys,prefix}.ts; tests/session/**`

## Goal

Persist run affinity/distinct threads; canonical static controls/input-last immutable items, full schemas+role authorization, owned/injected controls, model-switch reasoning removal, cross-run static prefix.

## Acceptance

B30; three-turn raw-byte prefix, identical retry, independent Shape/Build prefixes.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-30-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-03-consecutive-request-byte-prefix,v1.2-04-cache-key-session-headers,v1.2-05-missing-usage,v1.2-104-provider-01,v1.2-105-provider-02,v1.2-106-provider-03,v1.2-107-provider-04,v1.2-117-provider-20' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/30-canonical-sessions-and-wire-shapes.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
