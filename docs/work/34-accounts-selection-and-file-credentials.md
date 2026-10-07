# 34-accounts-selection-and-file-credentials

Goal: Accounts, selection and file credentials. Limit: 90 active minutes.

Dependencies: 04,11,12

## Owned files

`packages/core/src/provider/accounts/{select,format,profiles}.ts; packages/core/src/provider/auth/{store,injected}.ts; tests/accounts/**`

## Goal

Provider/account precedence, profiles/host UUID, strict accounts YAML atomic serialization; Kogen-only private file store, injected JWT expiry and reread/no refresh.

## Acceptance

B34; empty both-provider rows, no source-repo credentials.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-34-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'provider-19,v1.2-24-state-14-grok-account-row,v1.2-34-format-11-account-selection' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/34-accounts-selection-and-file-credentials.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
