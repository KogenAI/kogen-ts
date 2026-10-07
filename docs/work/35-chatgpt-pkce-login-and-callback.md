# 35-chatgpt-pkce-login-and-callback

Goal: ChatGPT PKCE login and callback. Limit: 90 active minutes.

Dependencies: 29,34

## Owned files

`packages/core/src/provider/auth/chatgpt/{login,jwks,callback}.ts; tests/chatgpt-login/**`

## Goal

Discovery, dynamic registration, PKCE/state/nonce, loopback1455 reuse, scopes/resource, JWKS RS256/issuer/aud/expiry/sub, fresh-registration repair.

## Acceptance

B35; fake OAuth only; failed callback and back-to-back login.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-35-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-32-provider-21-login-flow' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/35-chatgpt-pkce-login-and-callback.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
