# 07-macos-confinement

Goal: macOS confinement. Limit: 90 active minutes.

Dependencies: 06

## Owned files

`packages/core/src/sandbox/{policy,macos}.ts; tests/sandbox-macos/**`

## Goal

SBPL generation and capability probe; hide secrets, checkout/origin write denial, allowed network/cache paths; warning/off/already-confined semantics.

## Acceptance

B07 on macOS; real confinement and forced-unavailable integrity fixtures.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-07-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-119-custody-06,v1.2-120-custody-07' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/07-macos-confinement.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
