# 15-supervised-git-port-and-trusted-metadata

Goal: Supervised Git port and trusted metadata. Limit: 90 active minutes.

Dependencies: 05,06

## Owned files

`packages/core/src/git/{command,repository,identity}.ts; tests/git-port/**`

## Goal

Bound every Git call and output; explicit argv/stdin; private object-format-aware metadata; suppress hooks/filters/fsmonitor/textconv/config redirection. Separate public identity/signing.

## Acceptance

B15; SHA1/SHA256, hanging Git/signing child, hostile config smoke.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-15-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'v1.2-122-custody-09' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/15-supervised-git-port-and-trusted-metadata.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
