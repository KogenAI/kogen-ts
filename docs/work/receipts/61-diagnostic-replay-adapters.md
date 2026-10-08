# 61 — Diagnostic replay adapters

**Status:** Partial implementation; diagnostic and integration work remains pending.

## Revision and effort

- Base: `6cd8fe93f0d8e03ce96b7e71477c416eb4329cce`
- Adapter implementation commit: `36b093c0c73a0b50fecc1bed66dc684fc769c854`
- Branch: `kts/61-diagnostic-replay-adapters`
- Dependencies present as ancestors: 45 `a6f5d63`, 46 `f3c9ecf`, 54 `40a6d6a`, 57 `13a7868`.
- Active effort: approximately 25 minutes, manually estimated. Model: GPT-6 Codex (runtime variant not exposed); token count is not available in this interface.

## Changed behavior

Implemented full-observation adapters for accounts, gate, and setup-cache. They call production account parsing/selection, gate ledger/verification/audit/selector policies, and setup-cache key/fingerprint/cache policies with injected fixture effects. Event payloads use exact field schemas; unknown tags and unsupported fields fail with `invalid_event`. Gate fixture row/candidate sizes are bounded and oversized inputs fail before allocation.

The setup-cache fixture maps symbolic model bases `a`–`d` to deterministic SHA-1 tree identities, and injects setup stability through the cache publication port. Those mappings are diagnostic fixture effects, not production tree identities or claims about real I/O.

No `orchestration.ts` adapter was added. The production `runBuild()` API executes the controller as a whole, while the diagnostic model requires one observation after each B0–B10/rung/audit/landing event. There is no shared incremental production transition to call, and implementing the model transitions locally would duplicate policy. Coordinator interface amendment is required before this slice can be implemented faithfully.

No root/composition/registry, CLI, or build files were changed. `packages/xspec/src/main.ts` still registers only approve and intent; `dist/kogen-xspec` is absent. Orchestration and replay wiring therefore remain pending integration.

## Exact files

- `packages/xspec/src/slices/accounts.ts`
- `packages/xspec/src/slices/gate.ts`
- `packages/xspec/src/slices/setup-cache.ts`
- `tests/xspec-diagnostics/adapters.test.ts`
- `docs/work/receipts/61-diagnostic-replay-adapters.md`

The owned `packages/xspec/src/slices/orchestration.ts` path is intentionally not present pending the production transition interface described above.

## Review and checks

No `REVIEW-MIDBUILD.md` finding is assigned to packet 61. Finding #3 is assigned to packages 29/36/54; its credential first-byte deadline repair is recorded in I2, with integration follow-through in I6 outside this packet.

- `bun --no-install test tests/xspec-diagnostics/adapters.test.ts`: **PASS**, 6 tests, 10 expectations.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** — 604 passed, 1 skipped, 0 failed; 4,736 expectations across 605 tests/78 files. The skipped real Linux mount test requires Linux user namespaces and bubblewrap; this host is macOS.
- No fake HTTP requests were issued; unmatched fake requests: **0**.

## Diagnostic Quint replay

Copied `spec-lock/kogen-spec/quint` to `/tmp/kogen-xspec-61-20261008/provisioned/quint`, installed pinned `@informalsystems/quint@0.33.0` there, and ran from isolated per-slice/per-seed copies. Fresh hand observations were used for each seed copy; frozen generated observations were removed before generation. Logs and copies remain under `/tmp/kogen-xspec-61-20261008/`. These slices are diagnostic and do not increase the mandatory slice count.

Current classifications from `quint/CLASSIFICATION.md`: accounts **L**, gate **L**, orchestration **L** (witness path **E**), setup-cache **L**. No legacy `resilience` or prototype landing replay was run or counted.

| Slice | Hand scenarios | `spec` | `gen` seeds 17/23/41 | First divergence |
| --- | ---: | --- | --- | --- |
| accounts | 9 | PASS 9/9 | PASS 500 × 25 each; 12,500 events per seed | None in hand scenarios. |
| gate | 5 | FAIL 4/5 | PASS 500 × 25 each; 12,500 events per seed | `04-advisory`, step 8: `Demote(A2, over_strict)` expects `items.A2.demoted=true`, gets false. Step 9 repeats for `contradicts`; step 10 expects advisory verdict and landability but gets `unverified`/false; step 11 still expects the advisory verdict under `green`. |
| orchestration | 6 | PASS 6/6 | PASS 500 × 25 each; 12,500 events per seed | None in hand scenarios. |
| setup-cache | 7 | PASS 7/7 | PASS 500 × 25 each; 12,500 events per seed | None in hand scenarios. |

All 12 generation runs passed their model invariants (6,000 traces / 150,000 events total). Conformance was attempted with the required command for each slice/seed: 9 attempts exited 1 when `harness/xspec.py` could not launch the absent `dist/kogen-xspec`; the 3 gate attempts exited 2 because the failed gate `spec` correctly published no hand corpus. **Zero adapter instances were replayed; no first adapter divergence is available. This is not a conformance pass.**

The gate hand failure is a versioned model gap: the authoritative v1.3-draft `CHANGES-v1.3.md` and `CLASSIFICATION.md` say demotion is observational and cannot change item state, verdict, eligibility, offers, or winner, but the retained `gate/04-advisory` scenario still asserts automatic demotion. The model/scenario/golden migration must be resolved by the spec/coordinator owner; this packet did not edit the read-only bundle or weaken the target.

The orchestration model header still cites v1.2 (§3.0, §3.1, §3.4, §3.5); current CLASSIFICATION marks the slice L, with an E witness path. Its 6/6 hand result is only evidence about that diagnostic model, not v1.3 implementation parity.

The frozen v1.2 suite was not run or modified. Its incompatible demotion assertions are exact: v1.2 cases 73 and 75 expect `over_strict` A2 to be automatically demoted, require no repair, and finish landed with `green-with-advisory-tests`/`advisory_items=["A2"]`; case 74 expects a `land: green` run to park the demoted candidate with that advisory verdict; case 79 expects an audit after the ended rung to re-score and land without another repair/rung. Those expectations are superseded by v1.3-draft's observational-only audit policy. Cases 76 (valid advice remains upheld) and 77 (invalid JSON demotes nothing) do not assert the superseded auto-demotion outcome.

Other documented historical v1.2 mismatches remain diagnostic only: `quint/MISMATCHES.md` records the gate hand selector choosing rung 3 while the old production selector chose rung 2, and accounts differences around use after logout, missing-project selection, environment precedence, Grok support, and refusal codes. This packet makes no v1.2 or v1.3 parity claim.

## Pending work and next owner

The coordinator owns the next steps: provide/admit an incremental production orchestration transition interface; resolve the stale `gate/04-advisory` v1.3-draft scenario/golden; register diagnostic adapters and build `dist/kogen-xspec`; then rerun the exact matrix with full observations and report actual conformance instances/divergences. Linux namespace/mount coverage also remains unverified on this macOS host.
