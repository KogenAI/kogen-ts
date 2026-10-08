# B48 — Shape validation, ledger, and audits

## Status

Package implementation is committed. Public CLI/composition integration is pending I2; this receipt does not claim end-to-end acceptance or v1.3 parity.

- Base commit: `321e2a173387f4e52318a0d79b9706d09f691ed3`
- Implementation head: `fda5979` (`Implement Shape validation ledger and audits`)
- Branch: `kts/48-shape-validation-ledger-and-audits`
- Active time: approximately 55 minutes, estimated; this worker did not expose an active-time counter.
- Model: Codex GPT-6; exact deployment variant and token usage are not exposed in this environment.

## Changed behavior

Added a Shape validation callback that normalizes the Intent while preserving Request bytes, parses and lints it, checks gate declarations, invokes the configured formatter and acceptance checks, stages the configured adapter’s test, evaluates the base acceptance ledger, and reclassifies Verify lines from the observed base results. Reclassification changes only the Verify marker bytes and groups warnings by direction.

Requirement-ledger parsing validates the closed JSON shape, known item mappings, and Request number/backtick/quoted literals. Each eligible traversal requests both the requirement auditor and the test auditor even if requirement coverage has gaps. A cited test-audit finding and a coverage gap share one exact repair message; remaining gaps and uncited/non-valid advice become ordered warnings. The auditors use separate tool-less sessions. Audit advice does not alter test results.

Ledger and warning artifacts bind their approval hash to exact Intent and acceptance bytes and are written through the anchored filesystem port with mode `0600`. Stale artifacts are removed on the first validation callback. Formatter-unavailable is progress-only and is filtered from the persisted warning document.

No finding in `docs/work/REVIEW-MIDBUILD.md` was assigned to B48.

## Exact owned files

- `packages/core/src/shape/validate.ts`
- `packages/core/src/shape/ledger.ts`
- `packages/core/src/shape/audit.ts`
- `packages/core/src/shape/artifacts.ts`
- `tests/shape-validation/shape-validation.test.ts`
- `docs/work/receipts/48-shape-validation-ledger-and-audits.md`

## Checks

- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS — 593 passed, 1 skipped, 0 failed; formatting, lint, TypeScript, shell/native checks passed. The skipped case requires Linux user namespaces and bubblewrap; this run was on macOS 26.7.1 arm64.
- `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/shape-validation`: PASS — 11 passed, 0 failed.
- Frozen conformance command from B48: 0 passed, 0 assertion failures, 6 harness errors across 5 requested cases / 6 instances. The harness could not start `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/48-shape-validation-ledger-and-audits/dist/kogen` because it is absent. No provider requests reached the fake server; all 28 scripted fake requests remained unmatched.
  - `shape-15`: 1 harness error.
  - `shape-16`: 2 harness errors (`red`, `127`).
  - `shape-17`: 1 harness error.
  - `shape-18`: 1 harness error.
  - `shape-21`: 1 harness error.
- Xspec replay slices: not assigned or run. Hand-case counts: 0; seeds 17/23/41: not run; first divergence: not applicable.
- Frozen v1.2 assertions reviewed for these five cases show no identified incompatibility with the v1.3-draft behavior. The absent executable prevented execution, so this is not a parity result.

## Pending integration and next owner

`createShapeValidationWorkflow` is available for composition, but B48 does not own root composition or CLI registration. The coordinator owns I2 integration: resolve and inject the configured adapter and auditor role, wire the callback into the public Shape route, build `dist/kogen`, then rerun the exact frozen cases and record the merged I2 receipt. Linux host acceptance also remains unverified here.
