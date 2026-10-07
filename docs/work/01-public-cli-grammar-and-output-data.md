# 01-public-cli-grammar-and-output-data

Goal: Public CLI grammar and output data. Limit: 90 active minutes.

Dependencies: 00

## Owned files

`packages/cli/src/{argv,output}.ts; packages/cli/data/**; tests/cli-boundary/**`

## Goal

Fixed moved/tree/options/positional/value precedence, exact help and exits; both provider names. Public parser does not prevalidate slugs.

## Acceptance

B01; grammar table and byte-exact help.

Always run `GIT_CONFIG_GLOBAL=/dev/null make check` plus named local cases.

```sh
ROOT="$(git rev-parse --show-toplevel)"
SUITE="$ROOT/spec-lock/kogen-conformance"
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-01-XXXXXX")"
chmod 700 "$RESULTS"
mkdir -p "$RESULTS/work"
"$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --case 'cli-10,cli-15,cli-18,cli-19,cli-20,cli-22,format-06,format-09,v1.2-01-fixed-cli-help-and-grok,v1.2-07-cli-03-unknown-command,v1.2-08-cli-04-unknown-subcommand,v1.2-09-cli-05-unknown-option,v1.2-10-cli-06-missing-positionals,v1.2-11-cli-07-unexpected-argument,v1.2-12-cli-08-option-needs-value,v1.2-13-cli-09-boolean-takes-no-value,v1.2-14-cli-11-unknown-provider,v1.2-15-cli-12-watch-with-json,v1.2-16-cli-13-double-dash,v1.2-17-cli-14-options-before-command,v1.2-18-cli-16-short-option,v1.2-19-cli-17-help-bad-topic,v1.2-20-cli-21-invalid-slug,v1.2-21-cli-24-help-after-positionals,v1.2-33-shape-json-is-unsupported' --jobs 3 --time-scale 0.02 \
  --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

## Notes

Read PLAN.md, QUEUE.md and WORKER-RULES.md. Dependencies must be merged. Root/composition/registry edits belong to the coordinator except packet 00 and the documented initial packet 02 transfer. Add a receipt at docs/work/receipts/01-public-cli-grammar-and-output-data.md. No executable CLI exists in this bootstrap; missing wiring is pending integration, never a pass.
