# 13-intent-parser-and-exact-byte-hashes

Goal: Intent parser and exact-byte hashes. Limit: 90 active minutes.

Dependencies: 11

## Owned files

`packages/core/src/intent/{parse,hash}.ts; tests/intent-parse/**`

## Goal

Required frontmatter/section grammar, Verify forms, slug/lint boundary; preserve raw Request/CRLF/non-UTF8 bytes and Intent-NUL-test SHA256.

## Acceptance

B13; actual rejected syn-06/syn-20 frontmatter fixtures.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-13-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'state-04,state-07' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/13-intent-parser-and-exact-byte-hashes.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
