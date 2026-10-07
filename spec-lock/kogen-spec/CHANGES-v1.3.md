# Changes for v1.3-draft — 7 October 2026

This draft implements the owner's accepted recommendations for independent-review BLOCKERS 1–3 and SHOULD-FIX 6, 7, 9 and 10. It explicitly supersedes the 5 October automatic acceptance-demotion default. Review: `/tmp/claude-501/reviews-astra/SPEC.md`, reviewing spec `1118f7fc0dbb042af8c8de2ffd1b85768cf9e2a0` and benchmark `58c9ca5ee40fb958c61c61e381191a922886f88f`. Benchmark paths below are relative to `kogen-bench-sot` at that revision. The review's evidence and limits are part of each decision; product defaults are not measured winners.

The version label is **v1.3-draft**. The conformance repository and frozen v1.1 suite are unchanged. Cases below MUST be implemented and frozen in a new suite before claiming v1.3 release conformance. Existing implementation parity results do not validate these changes. Historical v1.2 drift/review documents remain historical; the current normative clauses and this change record take precedence.

## 1. Observational Build auditor (BLOCKER 1)

**Change:** [§3.0 and §3.8](spec/03-build.md), [§2.3/§2.8](spec/02-formats.md) and the README now require observational auditing. Every approved acceptance item participates in verification, repair counts, ranking and landing. Advice may explain or suggest a repair, but cannot change those decisions; repaired bytes require verification. Default landing policy is `green`; legacy `green-or-advisory` has identical current eligibility. Audit receipts identify `observational`; `demoted` stays false and advisory items empty. `build.auditor_demotion: true` is explicitly experimental and refused until a versioned exact-policy frozen calibration and prospective confirmation qualify it. No calibration is admitted here; future parallel-rung demotion ordering remains unadmitted.

**Evidence:** `rounds/l6-auditor-replay/RESULTS.md` and `README.md`: 40 calls/model, Luna-max precision 56.25% and false demotion 35%; `gpt-6-sol/low` precision 66.67% and false demotion 25%. Reproduced with `reproduce/score_l6.py`; both fail the registered ≥90% precision/≤5% false-demotion point targets. L6 tested offline patch vetoes, omitted test source/failure output, and did not test this spec's `gpt-6.1-sol/high` acceptance demoter. It is evidence against assumed safety, not an exact-policy measurement.

**Quint:** `gate` retains `Demote` as an observational event that preserves item state, verdict, eligibility, offers and winner; invariant forbids demoted items in the current profile. Embedded `observationalTest` covers A1 passing and genuinely required A2 failing.

**Conformance cases:**

- A1 passes/A2 fails; `over_strict` or `contradicts` for A2 never permits landing under either land-policy value. Require a real passing verification after repair.
- Audit before/after selection leaves passing counts, repair counts, rank, winner and eligibility unchanged, including parallel rungs and subsequent rungs.
- Unknown/duplicate/garbled replies warn without changing gate state. No `acceptance_demoted` event; report fields remain false/empty.
- Default configuration is observational; explicit demotion true without admitted calibration fails project load with the specified diagnostic. Witness mode still skips the auditor.
- Replace historical `ladder` cases 5–11 in the next suite; do not reinterpret their old demotion assertions as current behavior. Migrate `gate/04-advisory` scenarios/goldens/adapters.

## 2. Independent verification-baseline key (BLOCKER 2)

**Change:** [§2.9](spec/02-formats.md) separates setup-product identity from the v3 approval-baseline identity. The latter always includes the exact checked base tree, full effective check definitions, setup identity, relevant environment/toolchain/platform and adapter version. Unestablished identities prohibit reuse; old keys miss. [§3.3](spec/03-build.md) requires checking the resolved base tree, using scratch checkout when necessary. `setup_inputs` narrows only setup reuse; exact approval bytes/hash are unchanged.

**Evidence:** review §2's deterministic counterexample: identical lockfile/setup inputs and check commands across a source-only base change can otherwise reuse a red baseline that excuses a reintroduced defect (§3.7.2). The original §2.9 and §3.3 key definitions contradicted one another; no benchmark inference is needed.

**Quint:** `approve` binds `(baseTree, cacheKey)`, keeping opaque environment/setup/check context separate from the checked tree. `baseTreeCacheTest` changes the tree with identical context, reruns the baseline and reuses only the subsequent identical tree. The committed slice abstracts a single retained baseline slot; cache capacity/publication are I/O concerns. `setup-cache` remains unchanged, deliberately permitting narrowed setup-product keys.

**Conformance cases:**

- `setup_inputs: [lockfile]`: source-only base change hits setup but misses baseline, reruns checks, and replaces old red rows with new green rows. A candidate reintroducing that failure must not use the old baseline.
- Same checked tree and effective context reuse card/hash baseline; changed checks, deadlines, environment, toolchain or adapter version miss. Unknown toolchain identity prevents reuse; legacy baseline keys miss.
- Dirty/stale checkout cannot be recorded as the checked base; checks execute against the exact resolved tree.
- Add `baseTree` to `approve` events and migrate cache-key observation shape in scenarios/goldens/adapters, especially `09-baseline-cache`.

## 3. Preserve crashed work before cleanup (BLOCKER 3)

**Change:** [§3.10](spec/03-build.md) now stops run-owned writers and durably preserves each workspace's latest tracked edits/deletions, untracked non-ignored files, modes and symlinks before deleting it or its sole candidate ref. [§5.4](spec/05-sandbox-custody.md) binds workspace cleanup to this preservation requirement. Recovery snapshots/archives and their base/identity are recorded as **unverified** in [§2.5.3/§2.8](spec/02-formats.md). Prior snapshots cannot excuse losing later work. Failed preservation retains workspace and existing refs, emits `cleanup_failure`, and marks cleanup pending for retry even after terminal outcome. Recovery never overwrites or removes the only preserved candidate. Preservation grants no landing permission; automatic Build retry remains out of scope.

**Evidence:** review §3 compares recovery's unconditional destruction with normal budget-exhaustion snapshotting (§3.4), candidate refs (§2.5.3), “Diffs are never discarded” and D13's best-candidate direction. A kill after an edit but before the first snapshot otherwise destroys the only implementation; later unsnapshotted repair work is also lost.

**Quint:** `recovery` adds work/preserved/publication-result/cleanup-pending state, nondeterministic preservation outcomes, terminal cleanup retry, and a no-loss invariant across `Recover`. Embedded tests cover failure retaining work/ref, later successful preservation, idempotence, and preservation even after a landed CAS. Filesystem completeness/durability and create-only publication are explicit real-I/O boundaries.

**Conformance cases:**

- Kill before first snapshot, during repair after a snapshot, and after snapshot publication. Recover the exact latest contents, deletions, untracked non-ignored files, executable bit and symlink target; retain the earlier snapshot too.
- Kill between recovery publication and run-record publication, then repeat recovery: adopt complete existing preservation without duplication or overwrite. If later work differs, preserve it separately.
- Force ref and archive preservation failures: terminal outcome recorded, owned claim released, workspace and sole candidate retained, precise cleanup failure/pending state. Later recovery retries; re-approval must not allow retained-work destruction.
- Recover twice after success: same terminal outcome and preservation identity, no lost ref. Live owner remains untouched. Post-CAS recovery stays landed and preserves any later work as unverified.
- Migrate `recovery` event/observation fields, hand scenarios, goldens and adapters; add real-git/filesystem fault injection rather than counting abstract traces as durability proof.

## 4. Executable Shape accounting and fallback boundaries (SHOULD-FIX 6)

**Change:** [§3.2.1/§3.2.5](spec/03-build.md) names provisional `shape-v1.3`: two conversations, each ≤3 counted validation passes, ≤60 shaper logical turns, ≤2 free style repairs. Defines finish guards, combined validation repairs, separate auditor turns, per-request HTTP attempts/continuations, resets and success at the last allowance. Primary turn **or** pass exhaustion starts the fallback once; fallback exhaustion exits 1; provider/environment failures keep their exits. A scratch `shape-accounting.json` receipt tracks role/model/effort, conversations, logical turns, all attempts, passes, repairs, tokens/unknown usage and all-in elapsed time on success/failure. [§1.7.1](spec/01-cli.md) points to it without changing CLI output/flags.

**Evidence:** review §6 distinguishes six passes from two 60-turn allowances; finish guards/style/auditor calls/retries were undefined resources. `hypotheses/f01-shape-intent-plan.md` keeps H02/H04 unresolved and H13 not established. D6/D24's 20-minute/60,000-output-token limits concern probe work only. The reported 42–102 calls has no reproducing receipt in the review: retain it as a measurement task, not proof of an optimal cap. Ordinary Shape still has no total wall cap; finite attempts are not a wall guarantee.

**Quint:** no existing slice models end-to-end Shape counters. `stream`'s logical-request attempt policy and Shape provider exit behavior are unchanged; this draft does not claim a modeled counter guarantee.

**Conformance cases:**

- Primary reaches turn 60 without valid completion: exactly one fresh fallback with counters reset and files/last failure retained. Fallback turn exhaustion exits 1; valid completion on the last available turn/pass succeeds.
- Three failed counted primary passes trigger fallback slots 4–6; early primary turn exhaustion leaves unused slots without inflating actual validation totals.
- Missing-file finish guards spend turns, not passes/repairs. Style repairs spend turns and their two-repair allowance, not counted passes; leftovers warn. Coverage/audit requests and combined repair feedback have separate accurate counters.
- Identical resend/partial-stream continuation consumes attempts under one logical turn; failed/unknown-usage attempts remain in accounting. Provider/environment failure does not invoke fallback; elapsed time includes setup, validation and waits.
- Probe caps apply only to an actual probe path. Publish the receipt on failure as well as success. Measure the operational cohort and smaller-budget challenger on completion, yield, cost and time before adopting tighter total limits.

## 5. Provider-aware Shape fallback (SHOULD-FIX 7)

**Change:** [§2.3](spec/02-formats.md) resolves internal `fallback_shaper` from the effective configured shaper/provider/model/effort after overrides. It is not a separately accepted role key. [§3.2.1](spec/03-build.md) calls the default a fresh Sol-high retry, and [§4.10.1](spec/04-provider.md) keeps Grok's second conversation on Grok. Reject role models from another selected provider. This fresh conversation is distinct from overload-triggered provider model switching; Grok has no such model switch.

**Evidence:** review §7 finds an absent schema role, fixed Sol-high fallback and Grok-only rule in conflict. D34's Sol support profile is a product/benchmark rule; H13 provides no complementary-model advantage. The old review response claiming a configured `fallback_shaper` is historical and superseded by this explicit alias rule.

**Quint:** effective role resolution is not modeled; `stream` models overload fallback, which is unchanged.

**Conformance cases:**

- Default ChatGPT uses Sol-high in both Shape conversations with distinct thread identities. Project/machine shaper model and effort overrides propagate to the fallback.
- Grok reaches pass 4 or primary turn exhaustion: fresh Grok conversation, same effective shaper, no ChatGPT request/account fallback.
- Explicit `fallback_shaper` config remains an unknown role; cross-provider role override fails project load. Verify the fixed Sol-high benchmark profile is identified as a default, not model diversity.

## 6. Feasible frozen cache replay, block-aware diagnostics (SHOULD-FIX 9)

**Change:** [§4.9/§4.9.5](spec/04-provider.md) removes the universal warm-request gate. Freeze a feasible smoke workload, versions/endpoint, minimum/block rules, namespace/affinity, retention, token counts, appended budget and designated warm requests. Require theoretical eligible-input ratio ≥95%, complete telemetry and observed cached/total input ≥95% on each designated request; the owner's threshold is retained. Other workloads report weighted hit rate and eligible-prefix reuse, not a universal pass/fail. Unknown eligibility/usage is incomplete measurement, distinct from an observed miss; weighted totals with missing attempts are partial.

**Evidence:** review §9's arithmetic: perfect 4,096-token reuse with 1,000 appended tokens gives 80.38%, so ≥95% cannot be universal. The supplied 1,024-token block size is adapter-specific, not established as a universal guarantee. `rounds/t98-cache-smoke/README.md` describes interim figures without reproducible public request records; no qualifying live result is claimed. D44/D49 are historical decisions and their later cancellation remains acknowledged.

**Quint:** existing `session` does not model tokenization/usage efficiency; replay/accounting is an adapter/measurement boundary.

**Conformance cases:**

- 4,096 repeated +1,000 new tokens: report 80.38% raw reuse without a production gate failure. Synthetic 1,024-block fixture exercises rounding, minimum eligibility, zero-eligible requests and appended-token limits.
- Missing usage/unknown eligibility produces incomplete measurement; observed zero cached input with full usage is an observed miss. Partial totals must be identified as partial.
- Reject infeasible smoke definitions before running; distinguish complete measured failure from incomplete qualification. Preserve ≥95% on designated feasible warm requests and publish request-level counts.
- Fake-provider accounting tests are separate from a frozen live release replay; results name spec, adapter, prompt and replay versions.

## 7. Cross-session static prefix (SHOULD-FIX 10)

**Change:** [§4.9.1/§4.9.2](spec/04-provider.md) requires byte-identical generic instructions/tool schemas for matching adapter/prompt/tool versions across independent Shapes, Builds and Shape-to-Build. Variable task/run data follows them. Threads remain distinct. Persisted run affinity remains allowed; evidenced safe shared affinity is also allowed with separate provider/model and security boundaries. [P2](spec/CONFORMANCE-v1.2-CASES.md) no longer requires a different affinity key for every Build. This does not assert shared routing always improves reuse, nor resolve the separate HTTP serialization finding 8.

**Evidence:** review §10: existing tests scoped prefix stability to one Build and required different affinity for every Build; neither covers separate invocations. Run-specific timestamps/metadata in static content could previously pass. No evidence establishes an optimal shared-affinity scope.

**Quint:** `session` adds optional shared affinity and a provider/model/adapter/prompt-to-static-prefix identity map; rejects changed bytes under unchanged versions. `crossSessionPrefixTest` checks separate run identity, permitted shared affinity and timestamp pollution refusal. Actual prefix order/serialization and security partitioning require request fixtures.

**Conformance cases:**

- Compare two Shapes, two Builds and Shape-to-Build at matching versions: identical generic instructions and complete tool definitions; task/run/time/path data follows them; distinct conversation identities.
- Changed prompt/tool/adapter version may alter static prefix; stable versions may not. Provider/model/account boundaries remain distinct and do not leak private task history.
- Run-scoped and evidenced shared-affinity policies both work and survive restart; change P2's distinct-run key assertion. Compare same-session/separate-session request telemetry before adopting shared affinity.
- Migrate `session/07-run-affinity`, event/observation fields, goldens and adapters for optional scope and prefix map. These model changes do not freeze real hash bytes.

## Implementation and validation follow-ups

- Implement observational gate/audit/report/config behavior, independent v3 baseline keys and exact-base checking, durable recovery publication and pending-cleanup retry, Shape counters/receipts/provider resolution, and cache replay/report/prefix contracts.
- Migrate affected Quint adapters/scenarios/goldens independently from prose; implement real-I/O crash cases and provider request inspection. Do not treat model-only passes as filesystem/provider or end-to-end implementation conformance.
- Freeze a new executable suite with the cases above; retain v1.1 unchanged as historical parity and report exact spec/suite/implementation revisions. No conformance-repository edits were made here.
- Run exact-policy frozen/prospective auditor calibration before considering demotion; measure Shape challengers and same-session/separate-session cache policies; publish a feasible live cache replay with complete telemetry.
- Independent-review findings 4, 5, 8 and 11–16 remain separate follow-ups: complete post-CAS synchronization/durable record reconciliation, unify provider terminal policy, reconcile serializer/tool-choice rules, shaping citations/coverage, failure comparators, remaining config/status schema, executable release freeze, decision provenance and full pipeline receipts. This draft does not claim to close those broader findings.

**Validation of this change:** L6 public scorer reproduced both false-demotion rates and ineligibility. All four changed Quint slices typecheck; five embedded regression tests pass; each slice's invariant simulation passes 1,000 traces of up to 30 steps (seed 1307, TypeScript backend). The isolated commit versions of `approve` and `session` were checked separately to preserve pre-existing working-tree edits. No live provider, implementation adapter or frozen conformance pass is claimed.
