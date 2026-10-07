# 36-refresh-locks-logout-and-auth-errors

Goal: Refresh locks, logout and auth errors. Limit: 90 active minutes.

Dependencies: 33,35

## Owned files

`packages/core/src/provider/auth/chatgpt/{refresh,logout}.ts; tests/chatgpt-refresh/**`

## Goal

Cross-process owner lock/re-read/one refresh/replay, provider-only login outcomes, token rotation, unreadable saved-credential recovery and owned/injected headers.

## Acceptance

B36; concurrent refresh, injected401 no refresh and bound auth hangs.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-36-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'provider-10,provider-22' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/36-refresh-locks-logout-and-auth-errors.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
