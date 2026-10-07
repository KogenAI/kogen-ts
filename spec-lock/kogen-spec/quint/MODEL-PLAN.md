# Quint model plan

Rewrite authority: [CLASSIFICATION.md](CLASSIFICATION.md), [ADAPTER.md](ADAPTER.md), and [PLAN-NEXT.md](PLAN-NEXT.md). The Elixir seam and replay notes below are historical diagnostics. New implementations expose the private JSON-lines `kogen-xspec` adapter, run full observations, and never treat a projected or `no_seam` result as a pass.

The executable model is divided into slices with pure `apply(State, Event) -> State` and
`observe(State) -> Obs` transitions. Hand scenarios are neutral JSON. The generic harness
uses `quint test` for scenario expectations and invariants, `quint run --mbt` for generated
invariant-checked traces, and an xspec/1 JSON-lines adapter for implementation replay.

## Sources and method

- Read `README.md`, `AGENT-AUTHORING.md`, `slices/*`, and `prototype/` before authoring.
- Normative prose is `../spec/` v1.2 (6 Oct 2026); re-read the relevant sections before
  each slice because the spec was being updated during this work.
- Fixed command grammar and output: `../CLI-RULE.txt`.
- Behaviour comparison: `~/Areas/Kogen/careful-rebuild` library replayed at
  `0d3ff7290aed98b439d120dde4d5bf0ce89295ca`; current HEAD is
  `f98073684280da3f4eb97c940638386d70830ab3` (only benchmark and end-to-end test files
  changed since replay);
  provider cache rules: `~/Areas/Kogen/careful-rebuild-wt/T98` at
  `3644d35d7b83f171cf4461f931885daccad1014a`. Both checkouts are read-only.
- An adapter uses a real pure Kogen seam where one exists. Where the behavior requires
  private CLI state, Git, a process, or network effects, it answers the protocol but reports
  the missing seam in `MISMATCHES.md`; that is not counted as a pass.

Run from `prototype/` (the harness defaults to the original prototype):

```sh
XSPEC_SLICE=../slices/<name> python3 harness/xspec.py spec
XSPEC_SLICE=../slices/<name> python3 harness/xspec.py gen --traces 500 --steps 25 --seed 17
XSPEC_SLICE=../slices/<name> python3 harness/xspec.py conform --project <fields> -- ../slices/<name>/adapter/run.sh
```

## Kept slices

| Slice | Sections | Coverage |
|---|---|---|
| `prototype/landing` | §2.5.3, §3.9–3.10, §3.11 | Claim ownership, five-phase landing CAS, crash points, recovery, and queue ordering. The historical prototype parks immediately on a lost CAS; `rebase` below models the v1.2 rebase/re-gate path. Go, Rust, and Elixir implementations remain intact. |
| `slices/approve` | §1.7.2, §2.5.1, §3.3 | Hash-first approval, baseline cache, lint, witness refusal. The private CLI `decide/2` has no pure apply seam. |
| `slices/resilience` | §4.4–4.5 (historical v1.1 reading) | Original retry-policy slice retained. Current v1.2 provider behavior is modeled by `stream`; differences are recorded rather than silently rewriting this slice. |

## Core slices

| Slice | Sections | Logic owned |
|---|---|---|
| `intent` | §1.7.1, §1.7.3, §2.5.1, §3.2.5 | Shape never approves; remove/force rules; approval refs bind the hash and use create/update-ref CAS with one lost-race retry. |
| `queue` | §1.7.4, §3.11 | Start/stop lock, safe second start, stale-owner takeover, serial drain, continue/stop outcomes, and stop-after-current-Build. |
| `orchestration` | §3.0–3.5 | B0–B10: plan, setup/base gate, build, verify, repair loop, `hard` parallel start, ladder rungs, fresh attempts/workspaces, budget, best candidate, claim and final state. |
| `gate` | §2.4.1, §3.7–3.8 | Pre-existing base failures and excuse predicate; candidate checks; acceptance ledger; auditor demotion; verdict, landability, deterministic candidate selection. |
| `rebase` | §2.8, §3.9 | Landing record before CAS, incoming ref, retries, base rebase, re-gate/repair, controller failures, and final park/land. |
| `recovery` | §2.5.3, §2.11, §3.10 | Dead/live claims, Landing-record reconciliation, landed/interrupted/crashed outcomes, incoming-ref cleanup, and queue eligibility. |
| `stream` | §4.3–4.5, §4.9.4, §4.9.6 | Retry cap/backoff/fallback, first-byte/idle/total limits, silence, upstream cut classification, partial-stream continuation, checkpoint bounds, login/usage pause state. |
| `session` | §4.1–4.2, §4.9.1–4.9.2 | Cache-key identity (stage/attempt/rung/epoch), stable turns and repairs, fallback key, accepted-checkpoint epoch, byte-stable prefix, Lite session id, and never sending `previous_response_id`. |
| `setup-cache` | §2.9 | Setup key-material identity, base-tree versus declared-input keys, reuse, copy-on-write restore, input recheck before publication, failed-setup nonpublication, opt-out, and three-entry LRU. The digest is abstract in Quint; the adapter compares actual cache outcomes. |
| `status` | §1.7.5, §2.11 | Status precedence, interrupted override, queue ordering, overview sections, empty sections, landed window, slug/watch output and exit. |
| `accounts` | §1.7.6, §2.7, §4.6, §4.10 | Provider list, login/logout profile state, default/project `use`, label validation, account resolution precedence, environment/provider choice, missing/broken records, and no second-account fallback. |

## Effect boundaries

The model covers the transition rules at these boundaries. Actual Git mutation, process
liveness, shell execution, HTTP/OAuth exchanges, and filesystem publication remain external
effects and are exercised through adapters where feasible. The setup-cache key is modeled as
its equality-relevant material rather than a SHA-256 value because Quint has no SHA-256
primitive; its adapter calls the real file-backed cache in temporary directories. Provider
OAuth itself is represented by account profile effects. These limits and every adapter
projection are listed in `MISMATCHES.md`.

Parse/lint/YAML diagnostic tables are data, not state machines. R4 remains out of core v1.
