# Commitment classification for the language-neutral rewrite

**Source of authority:** [CLI-RULE.txt](../CLI-RULE.txt), the [5–6 October decisions](/Users/almirsarajcic/Library/Mobile%20Documents/com~apple~CloudDocs/Areas/Kogen/careful-rebuild/build/DECISIONS-2026-10-05-06.md), and `spec/`. G = GUARANTEED, L = LIKELY, E = EXPERIMENTAL. A row classifies the **whole numbered section**; a mixed row names its guaranteed kernel. Later evidence may promote L/E only through a spec and test change. Dn refers to decision n in the ledger; F refers to its frozen-round decisions. The fixed CLI and the hash/queue/landing safety contract take priority over historical Elixir behavior. The current specification is **v1.3-draft**. The owner-accepted 7 Oct corrections in [CHANGES-v1.3.md](../CHANGES-v1.3.md) supersede the 5 Oct automatic-demotion default and universal warm-request cache interpretation. The frozen v1.1 suite cannot validate these changes; classification G states a required contract, not an implementation or empirical validation claim.

## Prose sections

| Section | Class | One-line reason |
|---|---|---|
| §1.1 Process model | G | D39 fixes one public CLI; process/output behavior is observable by conformance `cli`. |
| §1.2 Command tree | G | D39 and CLI-RULE fix every verb, flag, and the `chatgpt`/`grok` provider names on the existing provider commands. |
| §1.3 Argument grammar | G | The fixed CLI is unusable without deterministic argument refusal; black-box `cli` checks it. |
| §1.4 Help pages | G | The spec's byte-exact pages are part of the frozen CLI oracle. |
| §1.5 Exit codes and error lines | G | Callers and the frozen `cli`/`approval` tests rely on these outcomes. |
| §1.6 Project resolution | G | Approval refs, one origin claim, and base CAS require a single resolved project/base. |
| §1.7 Commands | L | Its verbs are G, while shape and status detail below contain research choices. |
| §1.7.1 Shape | L | D6 preserves shaping and tests, but D24 leaves the exact shaper/probe method unmeasured. |
| §1.7.2 Approve | G | D6 requires approvable Intents and §2.5 binds reviewed bytes to a CAS ref. |
| §1.7.3 Remove | G | Fixed CLI includes remove and §2.5 protects active/approved refs. |
| §1.7.4 Queue | G | D1–2 serialize shared work and make duplicate start harmless. |
| §1.7.5 Status | G | Fixed CLI exposes status; §2.11 is the observable state derivation. |
| §1.7.6 Provider | G | Fixed CLI includes list/login/logout/use for ChatGPT and Grok; both names use the existing provider commands. |
| §1.7.7 Version | G | CLI-RULE includes version and the help corpus fixes output. |
| §1.8 Signals and deprecations | G | A fresh process must report interrupt and moved forms consistently. |
| §2.1 Intent | G | D6 requires tested Intents before approval and §2.5 commits their bytes. |
| §2.1.1 Slug | G | Slug is a ref/path key; validation prevents aliasing and unsafe paths. |
| §2.1.2 Grammar | G | Approval and test ledger need a common parsed Intent; frozen `state` checks it. |
| §2.1.3 Hashes | G | The approval hash binds exact Intent and acceptance source bytes; frozen `approval` checks mutation. |
| §2.2 Lint | L | Structural validity is G; the style word lists and repair policy come from the Elixir-era shaping design. |
| §2.3 Project config | L | Origin/base and checks are G; the same section also freezes unsettled rung, edge and Grok config. |
| §2.4 Acceptance tests and adapters | G | D6 says no Intent without tests; test execution must be observable. |
| §2.4.1 Contract | G | A passing candidate must satisfy the approved test, independent of language. |
| §2.4.2 Adapter interface | G | A rewrite needs the same acceptance process boundary and result semantics. |
| §2.4.3 Built-in adapters | L | `command` is G for conformance; Rails/ExUnit recipes depend on selected stacks. |
| §2.4.4 Findings and identities | L | Stable findings are needed, but exact parser identities are reference-derived. |
| §2.4.5 Shape artefacts | L | Useful for traceability, tied to the unsettled shaping/auditor design. |
| §2.5 Approval, protection and refs | G | Hash-bound approval and protected landing are the central safety contract. |
| §2.5.1 Approval commit | G | Immutable package and CAS prevent an unreviewed test/Intent reaching a Build. |
| §2.5.2 Protected manifest | G | §3.9 must stop the builder changing approved inputs or gate programs. |
| §2.5.3 Refs | L | Approval, claim, incoming, and base refs are G; witness/candidate refs depend on E/L paths. |
| §2.5.4 Landing commit | G | CAS landing needs a single auditable commit with the approved files. |
| §2.6 Strict YAML subset | L | Portable parsing is needed, but the extensive exact rejection grammar is reference-derived. |
| §2.7 Machine state | L | ChatGPT and Grok account rows are specified; cross-provider precedence and host metadata still need validation. |
| §2.8 Run dir and journal | L | Durable run/landing records are G; rung/audit event catalog depends on L/E behavior. |
| §2.9 Setup cache | L | Setup reuse is L; independent exact checked-base-tree binding of verification baselines is G (§3.3), even with setup_inputs. |
| §2.10 Build report | L | Status JSON is G; rung/audit/selector fields reflect L/E recipes. |
| §2.11 Status derivation | G | Queue eligibility, landed precedence, and recovery must agree across processes. |
| §3.0 Rules | G | D6 and D20 require approved, testable work and persistent Build outcomes. |
| §3.1 Ladder recipe | L | D5/D19 chose the current ladder, while D18/D22/D40 discarded variants and the exact rungs remain an optimization. |
| §3.2 Shaping | L | D6 makes shaping real; D24 still calls for a held-out method study. |
| §3.2.1 Conversations | L | Model/session layout is a chosen recipe, not a product invariant. |
| §3.2.2 Pre-steps | L | Approval needs tests, but probe/setup choreography is still shaping design. |
| §3.2.3 Validation | L | Structural acceptance is G; ledger and test-auditor passes lack admission evidence. |
| §3.2.4 Repair message | L | Exact prompt wording has no black-box product guarantee. |
| §3.2.5 Results | G | Shape must either write a valid draft or report a failure; repair counts are L. |
| §3.2.6 Concerns and progress | L | D6 keeps concerns non-blocking, but exact progress text is recipe detail. |
| §3.2.7 Witness | E | D6 makes witness opt-in and §3.2.7 itself says pending measurement. |
| §3.2.8 Assumption recheck | L | Stale dependency protection is useful; this predicate scheme is unmeasured. |
| §3.3 Approval checks | G | Approval must test the accepted source and refuse red checks before ref mutation. |
| §3.4 Build orchestration | L | Claim/verify/land sequence is G; B3 witness and rung scheduling are not. |
| §3.5 Rung machine | L | D5/D19 support a ladder, not its exact repair caps and transitions. |
| §3.6 Developer messages | L | Model tool protocol is needed, but prompt/finish policy is adjustable. |
| §3.7 Verification and base-relative checks | G | A Build cannot land without comparing candidate results to the approved base. |
| §3.7.1 Composition | G | Approved acceptance plus configured checks define the gate. |
| §3.7.2 Check status and excusing | L | Green/red is G; flake excuses and exact finding rules need evidence. |
| §3.7.3 Feedback | L | Useful for repairs; exact clipping is not a safety invariant. |
| §3.7.4 Advice | E | Proposals and adoption reporting have no decision requiring them. |
| §3.8 Verdict, audit, selection | L | All approved acceptance items and observational auditing are G; future calibrated demotion is E and disabled; selector tie-breaks remain L. |
| §3.8.1 Verdicts | G | A candidate must satisfy all approved acceptance and checks; legacy advisory policy cannot weaken the current gate. |
| §3.8.2 Build auditor | E | Observational-only boundary is G. Automatic demotion is E, opt-in and refused pending exact-policy frozen calibration and prospective confirmation; L6 false demotion is 25–35% for different patch-veto policies. |
| §3.8.3 Selector | L | D12/13 demand preserved best output; exact ranking is unvalidated. |
| §3.9 Commit and landing | G | One guarded base CAS is the non-negotiable publication boundary. |
| §3.9.1 Commit | G | Candidate bytes and approved package must be committed together. |
| §3.9.2 Moved base | G | D20's persistence and §3.9 require re-verification before a later CAS. |
| §3.9.3 CAS | G | A moved base cannot be overwritten; crash phases and cleanup are modeled. |
| §3.9.4 Protection | G | Hash approval is meaningless if a Build can edit its inputs. |
| §3.10 Recovery | G | Preserve latest work durably before cleanup, retain the only candidate, retry failed preservation; dead claims/CAS outcomes still reconcile. |
| §3.11 Queue and drain | G | D1–2 and D20 require serial drain, safe restart, and failure-class handling. |
| §4.1 Provider port and seams | G | D44/49 require measurable requests and caching without using another CLI. |
| §4.2 ChatGPT wire | L | Responses request/auth and cache fields are G; optional Lite mode and exact controls remain adjustable. |
| §4.3 Streaming | G | D20/D38 require bounded, recoverable long streams. |
| §4.4 Error classes | G | The queue needs stable provider vs login/usage/outage outcomes. |
| §4.5 Deadlines/retries/waits | G | D20/D38 fix resilience and nonfatal per-Intent errors; exact backoff is L. |
| §4.6 Login and credentials | G | CLI-RULE exposes login/use; credentials must be Kogen-owned. |
| §4.7 Tools | L | Shell custody is G; the exact tool catalog and result formatting are adjustable. |
| §4.8 Fake provider | G | The read-only black-box suite drives deterministic HTTP/OAuth. |
| §4.8.1 Endpoints | G | Tests must replace external endpoints without credentials. |
| §4.8.2 Roles and turns | L | Marker sentences serve the current fake, while role layout may change. |
| §4.8.3 Script steps | G | Deterministic request/reply assertions are required for black-box tests. |
| §4.9 Requests and prompt caching | G | Owner ≥95% target requires a frozen feasible live replay with complete usage; arbitrary warm requests have block/content limits. Historical D44/49 holds retain their later cancellation. |
| §4.9.1 Conversation key | G | Persisted adapter affinity is stable within invocations; evidenced shared scope is allowed while cross-invocation thread identities remain distinct. |
| §4.9.2 Prefix | G | Generic instructions/tools must be static across independent Shapes and Builds for matching versions; variable data follows them. |
| §4.9.3 Tool-result budget | L | Useful context management, but the 2,000-token value is not a cache invariant. |
| §4.9.4 Upstream cut | G | D20/D38 require continued work after long streams and bounded requests. |
| §4.9.5 Usage | G | Raw weighted hit, block-aware eligible-prefix reuse and complete/incomplete measurement must be distinguished; no live qualification is claimed. |
| §4.9.6 Context checkpoint | E | Optional and not needed for the cache gate or basic Build. |
| §4.10 Grok | L | T99 was unmerged in the v1.2 source; the provider name is now admitted, while full login/request behavior still needs validation. |
| §4.10.1 Selection | L | Full provider/account precedence still needs provider-selection tests. |
| §4.10.2 Sign-in | L | The device-code flow is specified; its end-to-end implementation needs validation. |
| §4.10.3 Request | L | The specified wire shape still needs fake-provider replay cases. |
| §5.1 Process custody | G | Deadlines and child cleanup protect the user's machine; `custody` checks them. |
| §5.2 Environment | G | Child environment isolation and test seams make runs reproducible. |
| §5.3 Sandbox | G | Approved files, checkout, and credentials must remain protected. |
| §5.4 Workspaces and git | L | Isolation and base-relative tree identity are G; one clone per rung is recipe-specific. |
| §5.5 Black-box behaviours | G | These are observable custody acceptance criteria. |
| §6.1 Out of core | G | Fixed CLI and serial Builds define the boundary; deferred entries remain deferred. |
| §6.2 Implementer freedom | G | The rewrite must be free to use Rust or another language behind observable behavior. |
| §6.3 Never | G | These prohibitions preserve credential, approval, and commit integrity. |

## Quint slices

| Slice | Class | One-line reason |
|---|---|---|
| `approve` | G | Hash-first approval/checks are G; baseline cache identity explicitly binds checked baseTree separately from opaque setup/check/env/adapter context. |
| `intent` | G | Draft/approval/removal lifecycle and ref CAS implement the fixed CLI. |
| `queue` | G | D1–2 and §2.11 require one ordered drain; priority is now modeled. |
| `orchestration` | L | B0 claim and terminal outcomes are G; its ladder/witness path is L/E. |
| `gate` | L | Base-relative checks are G; Demote events are observational no-ops on gate/rank; selector ranking remains L. |
| `rebase` | G | Landing record, incoming ref, moved-base verification, and CAS are core. |
| `recovery` | G | Preservation-before-cleanup and its failure/retry are modeled alongside CAS reconciliation; durable filesystem publication is an I/O follow-up. |
| `resilience` | E | This is a retained v1.1 policy; `stream` owns the current provider model. |
| `stream` | G | D20/D38 require retryable stream outcomes and bounded provider waits. |
| `session` | G | Stable threads/history, persisted run or shared affinity and cross-session static-prefix namespace identity are modeled; live cache efficiency is not. |
| `setup-cache` | L | File-backed setup reuse is separate from the prompt-cache release gate. |
| `status` | G | Fixed CLI plus §2.11 require deterministic observable state. |
| `accounts` | L | ChatGPT and Grok login/use are specified; the slice also models cross-provider precedence. |
| `prototype/landing` | E | It is a historical model with immediate park on lost CAS, superseded by `rebase`. |

## Deferred work and promotion evidence

- **Ladder and selector:** pin a small, successful recipe only after same-model controls and hard-task results; retain best-candidate reporting, then update `orchestration`, `gate`, and black-box `ladder` cases.
- **Shaping ledger, probes, witness, auditor, edge generation:** measure held-out yield and false demotion; D40 discarded the tested edge lever, and §3.2.7 already gives a witness promotion bar.
- **Grok:** CLI-RULE admits the provider name. Keep the profile/use and wire cases aligned with §4.10; validate them through provider replay and a versioned black-box suite.
- **Setup cache and strict YAML:** validate cross-language canonical bytes and representative invalid input classes before freezing exact diagnostics.
- **Historical `resilience` and prototype landing:** retain as research artifacts, never count their trace passes as rewrite conformance.

## v1.3-draft model boundaries and evidence

- `gate`: current profile forbids demotion; its retained `Demote` event records an observation only and preserves item state, verdict, landability, offers and winner. The embedded regression uses A1 passing/A2 failing. Future experimental gate semantics are deliberately unmodeled until admission.
- `approve`: cache identity is `(checked baseTree, contextKey)` (the committed slice abstracts one retained baseline slot); SHA-256, full environment/toolchain identities and check execution remain adapter inputs. `setup-cache` is unchanged: declared inputs may narrow setup products only.
- `recovery`: work/preserved/publication-result/cleanup-pending inputs model successful preservation, failure retaining work, retry and post-CAS preservation. Completeness of untracked files, modes/symlinks, durability, create-only publication and crash windows require real-I/O fault cases.
- `session`: permits run-scoped or evidenced shared affinity and rejects changed static-prefix identity in an unchanged provider/model/adapter/prompt namespace. Actual HTTP content ordering, account partitioning, tokenization, block rounding, retention and measurement require adapter/replay cases.
- Shape counters and conversation exhaustion (§3.2.1) have no existing modeled slice. `stream` continues to own request attempts/retries and Shape provider exits; its overload fallback is distinct from the fresh Shape conversation. Shape role resolution and end-to-end accounting require new black-box cases; no stream transition changed.
- Evidence joins: [CHANGES-v1.3.md](../CHANGES-v1.3.md) records review findings 1–3, 6, 7, 9 and 10, L6's exact-policy caveat, unresolved H02/H04/H13 and required follow-ups. There is no matching frozen executable v1.3 conformance release. Existing slice adapters/scenarios/goldens must be migrated before claiming parity.
