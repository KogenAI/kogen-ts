# 46-separate-setup-and-approval-baseline-caches

Goal: Separate setup and approval-baseline caches. Limit: 90 active minutes.

Dependencies: 04,12,16,18,20

## Owned files

`packages/core/src/cache/{setup,baseline,keys}.ts; tests/cache/**`

## Goal

Canonical setup products, input stability, CoW/LRU3/atomic complete/no failed hits; v3 baseline `{v,checked_base_tree,setup_key,checks,child_env,toolchain,os,arch,adapter_version}`; unknown identities prohibit reuse, old keys miss.

## Acceptance

B46; D2 source-only base change reuses setup but reruns checks.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-46-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'state-28,v1.2-133-state-26,v1.2-134-state-27' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/46-separate-setup-and-approval-baseline-caches.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
