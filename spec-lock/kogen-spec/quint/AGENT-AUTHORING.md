# Can agents write the Quint specs and scenarios from plain English?

Follow-up of 5 October 2026 to [README.md](README.md), prompted by Almir: "Quint is obscure; can agents reliably write these specs and scenarios from the plain-English spec, or would we need our own language? And how does it all fit together?" Labels: [M] measured here, [F] fact from the source, [I] inference. Work copy: `xspec/` in the session scratch; kept here: [`slices/`](slices/) (both new slices, with logs) and [`landing-rebase.patch`](landing-rebase.patch).

## Answer in five lines
1. **No new language.** Two fresh Sonnet agents wrote a Quint spec plus 17 scenarios each, from one plain-English excerpt, a style example and the adapter protocol. Both specs passed `quint typecheck` **first try**, in 219 s and 223 s. [M]
2. **Typecheck is the easy part.** The hard part is *meaning*. One spec had a real latent bug that its author's own 200-trace simulation missed and a 500-trace run found on all 5 seeds. Both agents had to guess 15 and 16 times where the prose was silent. [M]
3. **The pipeline is mechanical once the prose is settled:** prose -> Quint model -> JSON scenarios -> adapter -> implementation. Only the first arrow needs judgement. [I]
4. **The chain already paid for itself on the real code:** against the real `Kogen.Resilience` modules, the spec-derived scenarios exposed four prose/code differences within minutes, including the one Almir remembered (fallback after 2 overloads; the prose says 3). [M]
5. **Landing conflict fixed in the copy.** `landing.qnt` parked a candidate when the base moved. It now rebases and re-gates, and parks only when that is impossible. Spec, 4 scenarios and all three implementations updated: 1,021/1,021 traces agree in Go, Rust and Elixir. [M]

## 1. How it fits together
```
plain English (kogen-core-spec, reviewed by humans)
      |  agent writes; a second agent reviews coverage     <- judgement, not checkable
      v
Quint model: pure apply(State, Event) -> State, observe(State) -> Obs
      |  quint typecheck; scenarios replayed in the Quint simulator; invariants on every step;
      |  random simulation (quint run) with the same invariants          <- checkable
      v
golden traces (JSON): events + full observations, from the spec's own run
      |  neutral JSON-lines protocol (PROTOCOL.md): reset / apply(event)
      v
adapter (40-115 lines, one per language)  ->  real implementation core
      |  harness compares every observation, reports first divergence per trace
      v
conformance report (divergence classes by event and field)
```
- **Plain English** says what and why. **Quint** says exactly what happens for every event, including refusals. **Scenarios** are small readable cases whose expected values come from the prose, not from the model. They protect against a model that is consistent but wrong. **The adapter** is the only per-language code and contains no policy. [I]
- Who writes what: the shaper agent writes spec delta and scenarios; the human reviews scenarios (JSON) and the ambiguity list; the builder agent writes the implementation and adapter; the harness judges. [I]

## 2. Experiment: two new slices, fresh agents [M]
Each agent got only: its prose excerpt (`PROSE.md`, verbatim from `kogen-core-spec`), `PROTOCOL.md`, `landing.qnt` as a style example, two example scenarios and the harness docstring. No answer, no implementation, no Kogen source. Every `quint` call went through a logging wrapper (`qt`), so the counts are from logs.

| | (a) `intent approve`: card, hash, baseline | (b) provider resilience policy |
|---|---|---|
| Prose given | 01-cli 1.5, 1.7.2, 02 2.5.1, 03 3.3 (72 lines) | 04-provider 4.4, 4.5 + constants (40 lines) |
| Wall time (agent total) | 223 s | 219 s |
| Tool calls / tokens | 10 / 65k | 7 / 70k |
| `quint typecheck` first try | **yes** | **yes** |
| Logged quint invocations | 1 (exit 0) | 1 (exit 0) |
| Typecheck fix rounds | 0 | 0 |
| Spec size / scenarios | 166 lines / 17 | 184 lines / 17 |
| Scenario vs spec disagreements | 0 (one `xspec.json` coverage edit) | 1 (the agent's scenario 10 was wrong, spec right) |
| Constructs that tripped them | none reported | none; avoided string concatenation (not in Quint) with a lookup function |
| Ambiguities written down | 15 | 16 |
| My re-run: 17/17 scenarios agree | yes | yes |
| Simulation, 5 seeds x 500 traces x 30 steps | invariants hold (2,500 traces) | **violated on 5/5 seeds**; the agent's 200 traces passed by luck |

- **Why the first-try typecheck is only weak evidence.** The agents had a finished 277-line example in the same style, and each spec is under 200 lines of records, `if` chains and `fold`. Earlier, the prototype notes list Quint quirks that an author hits sooner or later: no string ordering or concatenation, `run` and `next` are reserved words, lazy map reads, `quint test` stops at the first failing `expect`. None came up here because both slices avoided them. A harder slice (ordering, text, big state) will cost fix rounds; I did not measure that. [I]
- **The latent bug in (b).** The shaping cap of 8 attempts is checked after the login branch, so a login refresh after attempt 8 gives attempt 9 and breaks the spec's own invariant (`attempts <= 8`). Moving one line fixes it (verified: 3 seeds x 500 traces clean). Prose reading: "at most 8 attempts per request" argues for the fix. Lesson: the author's simulation budget must be set by us (>= 500 traces x 5 seeds), not by the agent. The fixed copy is not stored; the agent's spec is kept as authored.
- **Spec mistakes vs scenario mistakes.** The one disagreement was in the scenario, not the model. Because both are written by one agent, they share blind spots. The checks below are what compensates.

### Independent coverage review (a second agent, prose + scenarios only, no model)
| | rules found | covered | uncovered | invented rules | wrong-looking |
|---|---:|---:|---:|---:|---:|
| (a) approve | 28 | 23 | 5 | 7 | 0 |
| (b) resilience | 34 | 22 | 12 (8 are HTTP classification, outside the event vocabulary) | 7 | 1 (outage window vs a 1 h usage wait) |

- The reviewers took 41 s and 60 s. They found real gaps: (a) CAS retry after a lost race, baseline statuses `unavailable`/`timeout`/`mutating`, stale witness, `base_sha` resolution; (b) no streak-breaking error in the middle of a streak, no exact 30-minute boundary, no deadline miss on a failing result.
- "Invented rules" are what the author guessed and then wrote scenarios for. They are the same items as the ambiguity lists, seen from the other side, and they are the most useful output: each one is a sentence the prose should have contained.

## 3. Replay against the Quint spec and against real code
**Quint replay.** `xspec spec` runs each scenario as a Quint `run` with the invariant after every step and checks the `expect` subset: 17/17 for (a), 17/17 for (b) (about 1.3-1.5 s each). [M]

**(b) against the real Elixir modules.** `slices/resilience/adapter/adapter.exs` loads the read-only `Kogen.Resilience.Policy` and `Retry` from `careful-rebuild/lib/kogen/resilience/` (compiled in memory, nothing written there; 83 lines). The harness got a `--project` option, because the real core exposes only a partial view (model, overload streak, decision kind, delay, reason). Result on the 17 hand scenarios: **2/17 agree as-is, 4/17 with `max_attempts` and the fallback threshold bent to the spec's values.** Differences found:

| # | Prose (04-provider 4.5) | Real code | Note |
|---|---|---|---|
| 1 | Switch after **3** consecutive errors | `overload_fallback_after: 2` | Almir's recollection ("after 2 overloads") matches the code, not the prose |
| 2 | Streak counts **overload and timeout** | Counts overload only; any other class resets it | |
| 3 | Retry without a count limit until the 30 min outage window | `max_attempts: 4`, then stop | the outage window and the 600 s cap live elsewhere (Exchange wall deadline) |
| 4 | Fixed ladder 2, 4, 8, 16, 32, 60 s | Same ladder with jitter (half to full ceiling) | the adapter reports the ceiling when the delay is inside the jitter range; unjittered it would diverge on every retry |
| 5 | `usage_limit` waits, `login` refreshes (this slice) | `Retry.next` stops on them; waiting happens in `Steer`/`Policy.waitable?` | not a bug: the pure core covers a part of the slice. The spec's event model needs a matching seam |
| 6 | Silent: delay on a switch | 0 (switch resends at once) | the agent chose the ladder delay; prose should say which |

- **What this shows:** drift between prose and code is found mechanically and quickly, with the exact event and field. **What it cannot show:** which side is right. Rows 1-4 each need a human decision (change the prose, or change the code).
- **Limit of the adapter:** it re-implements request-level bookkeeping (deadline to timeout, which the real code does in its HTTP layer) and keeps the switched model across requests the way the spec says; the real `Exchange.respond` starts each request from the model the caller passes. 83 lines is "quick", not a proof of fidelity. [I]

**(a) against the real code: not feasible as an adapter.** The approve logic is `Kogen.Kernel.Approval.prepare` (reads files, resolves git refs, runs setup, checks and acceptance) followed by a private `decide/2` in `Kernel.CLI.Runner`. There is no pure `apply(State, Event)` to wrap; a real-I/O tier (temp git repo, fake checks) is needed, as the README says. Reading the code did show one divergence from the prose: `prepare` runs the baseline and acceptance checks **before** the hash is compared, while 1.7.2 says "compute the hash first; mismatch -> exit 1, nothing run" (the spec's `ran: false` on mismatch, scenarios 02, 03, 16). Whether a cache hides the cost is not checked. [I]

## 4. Where the prose was ambiguous: the shaping lesson
Both agents flagged the same kinds of gap. The prose names steps and constants but not **order, scope, boundaries and error names**:
- **Order of refusals** (a): hash before parse/lint? identity before checks? Each agent derived one order; the prose gives none. Scenarios 12, 13, 14 and 16 rest on it.
- **Missing error line** (a): invalid `--by` has a rule but no error code. **Which baseline statuses warn** (a): only `red` is stated.
- **Cache scope** (a): one entry or many; flip-flop keys differ.
- **Boundaries** (b): "until the usage limit has lasted 6 h in total, then stop": stop on the error that reaches 6 h, or on the next one? "No success for longer than 30 min": do backoff waits count? usage waits?
- **Scope** (b): "lasts for the rest of the stage": per request or per stage? What does a switch wait?
- **Silences** (b): budget exhausted; the exit code of every stop; the journal field values (`rung`, the `provider_wait` stage).

**Shaping rule that follows [I]:** every rule in the prose should state (1) its order relative to its neighbours, (2) its scope (request, stage, Build), (3) whether limits are inclusive, (4) its error line or event name. A shaper agent can check these four per sentence, and the ambiguity list from the spec author becomes the shaper's review checklist.

## 5. The landing conflict (task 3)
- **Conflict.** `landing.qnt` scenario 07 parked the candidate when the base moved, so a re-approval was needed. Almir's rule: an approved Build must finish, with no return to shaping. Kogen today (and the core spec, 3.9.2): fetch the tip, rebase in the workspace, re-run the guard and a full verification; a conflict or red result becomes a repair; only "not landable afterwards" parks.
- **Proposed spec text for the model:** *"A lost CAS does not end the Build. The Build keeps the claim, drops its incoming ref, rebases onto the new tip and re-gates. Green restarts landing from the new tip; the CAS parent is the new tip. An impossible rebase or a red result after repairs parks the candidate (`parked/base_moved`) and releases the claim."* The prose spec already says this; the prototype model was the part that disagreed with it.
- **Change** (`landing-rebase.patch`, 536 lines incl. harness): new event `Rebase(bool)` (true = rebased and re-gated green, false = impossible after repairs); new phase `moved`; `Step` in `moved` is refused (`rebase_required`), `Rebase` elsewhere is refused (`not_moved`). The old `Step`-parks behaviour moved into `Rebase(false)`. Safety invariants unchanged and still hold.
- **Scenarios:** 07 now rebases and lands on top of the foreign commit; **19** keeps the old behaviour (impossible rebase parks, then re-approval retries); **20** the base moves twice; **21** the owner dies while waiting to rebase (recovery: failed/interrupted, claim and incoming ref released). 21/21 agree with the spec; 1,000 generated traces (30,000 events) keep the invariants.
- **Implementations:** Go +33/-8 lines (plus 6 in the adapter), Rust +25/-6, Elixir +19/-3 (plus 1). Before the change they diverged on 870 of 1,022 traces, naming `Rebase` (809) and `Step` (61) as the first differing event; after it, **1,021/1,021 in each language**.
- **Not modelled:** the landing retries at 1, 2, 4 s before the moved-base path, and a cap on repeated moves; `Rebase(false)` bundles conflict, red re-gate and exhausted repairs. The candidate id stays the run id across the rebase. The seeded-bug studies (`mutate.py`, `spec_mutants.py`) were not re-run.

## 6. What can be checked deterministically, and what cannot
**Checked by machine (no judgement, same result on every run):**
- The model is well-formed and typechecks. Its safety invariants hold on every step of every scenario and of N random traces.
- Each scenario's expected values agree with the model (so scenarios and model cannot contradict each other unnoticed).
- Every implementation, through its adapter, gives the same observation as the model for every golden trace: same state, refusals, error codes, events. Divergences are reported per event and field.
- Prose-vs-code drift, as in section 3, **once the prose is expressed as model and scenarios**.

**Only reviewed (a human or a second agent reads):**
- That the prose says the right thing: Quint cannot tell whether "3" or "2" is intended.
- That the model means what the prose means. Both are produced by one agent; a second agent reading the scenarios against the prose found 5 and 12 uncovered rules and 7 and 7 invented ones (section 2). This is a review, with no pass/fail oracle.
- That the scenarios cover the prose (there is no coverage measure from prose to scenarios; the reviewer's list is it).
- That the event vocabulary and the abstraction (what is an event, what is hidden) are the right ones. Real HTTP classification, git, clocks and LLM output sit outside the pure core.
- What the prose contributes that is not checkable: the **why** (decisions, trade-offs), user-facing text, naming, and every rule that lies outside the modelled slice. Plain English stays the source of intent; Quint and scenarios are its checked, narrower projection. [I]

## 7. Recommendation [I]
1. Use Quint plus JSON scenarios for state-machine slices; do not invent a language. Agent-writability is adequate for slices of this size (two first-try typechecks, ~220 s each). Budget fix rounds when a slice needs ordering or text.
2. Make the authoring loop three roles: author (model plus scenarios from prose), reviewer (prose plus scenarios only, no model: the coverage list), runner (harness with >= 500 traces x 5 seeds, set by us).
3. Treat each author's ambiguity list as a diff against the prose spec, and fix the prose first. Today's 31 items are ready to feed back; items 1-4 of the resilience table need a decision from Almir.
4. For the real-code tier, give the pure core a seam first (approve has none); then adapters like this one are an afternoon's work.

## Files
- [`slices/approve/`](slices/approve/), [`slices/resilience/`](slices/resilience/): `PROSE.md`, `spec/*.qnt`, `scenarios/`, `AMBIGUITIES.md`, `PROTOCOL-NOTES.md`, `attempts.log` (logged quint calls), `TIME.txt`; `slices/resilience/adapter/` is the Elixir adapter over the real modules; `slices/qt` is the logging wrapper.
- [`landing-rebase.patch`](landing-rebase.patch): the landing change (spec, scenarios, three implementations, PROTOCOL.md) and the harness changes (`XSPEC_SLICE`, `conform --project`), against `prototype/`.
- Run a slice from a copy of the prototype: `XSPEC_SLICE=slices/approve python3 harness/xspec.py spec`.
