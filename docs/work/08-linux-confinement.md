# 08-linux-confinement

Goal: Linux confinement. Limit: 90 active minutes.

Dependencies: 06

## Owned files

`packages/core/src/sandbox/linux.ts; tests/sandbox-linux/**`

## Goal

bwrap namespace/mount plan, secrets hidden, network allowed, capability probe and equivalent observable fallback.

## Acceptance

Recheck B07 on Linux; mount and missing-user-namespace tests. No macOS-only acceptance.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

No directly owned standard B-set; run the local acceptance below. Integrated behavior remains an integration/release gate.

Recheck B07 on Linux; macOS is insufficient.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-08-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-119-custody-06,v1.2-120-custody-07' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/08-linux-confinement.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
