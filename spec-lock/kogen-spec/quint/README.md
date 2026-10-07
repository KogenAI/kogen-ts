# Executable neutral specs: acceptance tests for language-agnostic specs

**Rewrite entry point (6 Oct review):** [CLASSIFICATION.md](CLASSIFICATION.md) marks every numbered spec section and slice; [REVIEW.md](REVIEW.md) records guaranteed-contract findings; [ADAPTER.md](ADAPTER.md) defines the private full-observation replay boundary; [PLAN-NEXT.md](PLAN-NEXT.md) orders builder work. The Elixir replay below is historical, not a release result for a rewrite.

Research of 5 October 2026, prompted by Almir's question: "Is there some way to write acceptance tests for language-agnostic specs? If not, we can invent it." Labels: [F] fact with a source, [M] measured here, [I] inference or opinion. Prototype: [`prototype/`](prototype/), run with `prototype/run.sh` (it took 41 s here).

**Research snapshot (5 Oct 2026):** the prototype and agent-authoring follow-up were complete; landing rebased and re-gated when the base moved; four prose/code differences in `Kogen.Resilience` awaited decisions at that point.

**Kogen core model (6 Oct 2026):** the prototype now sits alongside thirteen executable slices
for Intent lifecycle, queue, build orchestration, gates, landing/rebase, recovery, provider
resilience, cache/session behavior, status, and accounts. See [MODEL-PLAN.md](MODEL-PLAN.md),
[COVERAGE.md](COVERAGE.md), and [MISMATCHES.md](MISMATCHES.md) for slice scope, trace counts,
current-reference replay, and uncovered I/O seams.

## Summary
1. **Every piece already exists, but not the whole chain.** Quint and TLA+ run specs. Quint MBT replays spec traces into Rust (Informal Systems, quint-connect). toml-test, Bowtie and Maelstrom drive implementations in any language over JSON on stdio. [F]
2. **What is new in Almir's framing** is the chain end to end. One executable spec is the *source* that agents implement in several languages. Its scenarios are first checked against the spec. Then the same traces are replayed through one neutral adapter, roughly "toml-test for spec traces". I found nothing that does this. [I]
3. **Don't invent a spec language.** Use Quint, written as a pure `apply(State, Event)` plus `observe(State)`. Invent only the glue: neutral JSON scenarios, a JSON-lines adapter protocol and a generic harness of about 250 lines. [I]
4. **The prototype covers claim + landing CAS + crash recovery.** It has a 277-line spec, 18 hand-written scenarios and 1,000 generated traces. Checking the spec takes 1.1 s, and checking one implementation takes 1–2 s for 30,148 steps. [M]
5. **Three blind Sonnet agents** implemented the slice in Go, Rust and Elixir from the spec alone, in 72–83 s each. All three matched the spec on every step at the first try, and each returned 11–14 spec ambiguities. [M]
6. **Catch power.** Seeded implementation bugs: 18/18 caught (hand scenarios 17, generated traces 18). Seeded spec bugs: 4/4 caught (scenarios 4, invariants alone 2). Hand-written and generated scenarios catch different bugs, and so do scenarios and invariants. [M]
7. **Limits.** It checks only the pure core; git, clocks and real races need a second, real-I/O adapter tier. Generated traces explore only the declared universe: the agents diverge on `Start("")` and no trace covers it. [M]
8. **Kogen fit: yes, for logic-heavy slices.** An Intent Verify kind `scenario` would protect the spec and scenarios and check them *at approval*, so acceptance is itself tested before any Build. Start with §2.11 status/queue and this landing slice of `kogen-core-spec`. [I]

## 1. Prior art [F]
| Family | What exists | What it lacks for this idea |
|---|---|---|
| Executable spec languages | **TLA+/PlusCal** with TLC and Apalache (Apalache writes ITF traces); **Quint** (`quint test` runs `run` scenarios, `quint run` simulates, `--out-itf` and `--mbt` export traces; github.com/informalsystems/quint); **P** (p-org.github.io/P); **Alloy**; **Dafny**, which compiles to C#, Go, Python, Java and JS; **Lean**; **Event-B** | They check the spec itself. Apart from Dafny compiling its own code, none of them has a built-in path to an independently written implementation. |
| Spec → implementation conformance | **Quint MBT**: Malachite replays Quint traces into Rust, and quint-connect (Dec 2025) supplies `State`/`Driver` traits. quint.sh/posts/llm_era (Nov 2025) describes AI editing the spec, validating it, writing the code, then checking it with MBT. quint.sh/posts/quint_connect_emerald (Feb 2026) has AI write the spec and the MBT driver. **TLA+ trace validation**: Cirstea et al. 2024 (arxiv 2404.16075); etcd raft; CCF "Smart Casual Verification" (arxiv 2406.17455). **PObserve** checks production logs against P monitors. | One language and an in-process driver (Quint). A per-project log mapping (TLA+, PObserve). PObserve watches passively and never drives the system. |
| Reference model as oracle | **Cedar**: Lean model plus differential random testing against Rust (github.com/cedar-policy/cedar-spec). **S3 ShardStore** (SOSP 2021): Rust reference models with property tests, which prevented 16 issues. **Wasm**: an OCaml reference interpreter plus `.wast` scripts. **MongoDB "eXtreme Modelling"** (VLDB 2020, arxiv 2006.00915): trace checking was too costly, test generation from the model worked. | Mostly a single language with an FFI or in-process harness. The reference is code, not a spec. |
| Neutral conformance kits | **toml-test**: the decoder takes stdin and writes tagged JSON. **Bowtie/IHOP**: JSON-Schema validators in containers speaking JSON over stdio. **protobuf conformance**: stdin/stdout. **Maelstrom**: any-language nodes speak JSON over stdio and are checked for linearizability. **CommonMark** `spec_tests.py --program`. **yaml-test-suite**, **test262**, **Smithy** protocol tests (cases live in the model), **Exercism** canonical-data, **WPT**, **Kubernetes** conformance, **JCK**. I found no official conformance suite for LSP. | The oracle is fixed fixtures or a fixed checker. There is no user-written executable spec that generates new cases. |
| In-language model-based testing | **Hypothesis** RuleBasedStateMachine, **PropEr**/**eqc** statem, Jepsen **Elle** | The model is written in the test language, so it is neither neutral nor shared. |
| Gherkin/BDD | Cucumber scenarios in neutral text | Step definitions are written per language. No model checks the expected outcomes, so scenarios can contradict each other without anyone noticing. |
| LLM-era spec → code | **Quint LLM Kit** (`quint-execute-spec` skill), **Kiro** (requirements → Hypothesis properties), **GitHub Spec Kit** (prose specs, nothing checked), **Clover**, **AlphaVerus**, **Vericoding** (arxiv 2509.22908: Dafny 82%, Verus 44%, Lean 27%), **DafnyBench**, **VERINA**, **CLEVER**, **Specula** (code → TLA+), **Syzygy** (C → Rust with equivalence tests) | These are proof-oriented, with spec and code in one verifier language, or prose-only. Nothing gives several independent implementations a behavioural acceptance gate. |

**Closest match:** Informal Systems' Quint + LLM Kit + quint-connect has everything except (a) a language-neutral process adapter and (b) implementing one spec in several languages on purpose. Maelstrom and Bowtie have (a) and many implementations, but no executable spec acting as the oracle. The survey had no web search budget left, so read "not found" as not found, not as proven absent.

## 2. Design: `xspec`
**Spec language: Quint, used in a constrained style.** [I]
- *Why not a custom DSL:* the novelty is in the glue, not the language. A new DSL would need its own interpreter, docs and model checker, and agents would have no training data for it.
- *Why not TLA+:* Quint is TLA+ semantics with programmer syntax, so agents read it like code. Its simulator runs on Node/Rust, so no JVM is needed except for Apalache. `quint test` and `--out-itf` already exist.
- *Why not Python as the reference:* then it is just one more implementation, and agents would transliterate it.
- **The constraint:** write the spec as a pure transition function `apply(State, Event) -> State` and a pure `observe(State) -> Obs`. The state machine (`var st, ev, obs`; `fire(e)`) is three lines around them. This is the shape every implementation's core must have anyway, and it puts the event and the observation into every trace state. That makes ITF ↔ scenario conversion trivial and keeps the harness spec-agnostic.

**Rule: every source of nondeterminism is an event parameter.** That covers run ids, commit times, the gate verdict (which stands in for the model and the checks), crash points, SIGTERM and other pushers. A scenario therefore fully determines a run, in the spec and in every implementation.

Pipeline (`prototype/harness/xspec.py`, 250 lines; nothing in it is specific to Kogen):
1. **Scenarios** (`scenarios/*.json`): `{"do": ["Approve", {"slug":"alpha","time":1}], "expect": {...}}`. `expect` is a *subset* of the observation, so authors pin only what the step is about.
2. **Test the spec** (`xspec spec`): scenarios are generated into Quint `run` tests, with `.expect(invariant)` after every step. `quint test --out-itf` runs them. The harness compares each step's expectations with the spec's observation and writes **golden traces** (events plus full observations, in neutral JSON).
3. **Explore** (`xspec gen`): `quint run --invariant` simulates. Every trace has its invariants checked and becomes a golden trace. A coverage line counts outcomes, phases and reasons, to show whether deep paths were reached.
4. **Test the implementations** (`xspec conform -- <adapter>`): every golden trace is replayed through the adapter (`PROTOCOL.md`: `{"op":"reset"}` / `{"op":"apply","event":E}`, one observation line back each time). The harness compares *full* observations and reports the first divergence with the preceding events. It also groups failures into divergence classes (first differing event → fields). Implementations need no Quint; only spec authors do.

The adapter is the only per-language code: 43 lines in Rust, 57 in Elixir and 115 in Go.

## 3. Prototype: claim, landing CAS and crash recovery [M]
- **Slice:**
  - claim ref create-only;
  - Landing recorded in run.json before the base moves (§2.8.2);
  - incoming ref → base CAS → incoming delete (§2.5.4);
  - parking on a moved base;
  - status derivation including the interrupted post-pass, and queue order by (approval time, slug) (§2.11);
  - recovery: a dead run is `landed/reconciled` if its Landing is recorded *and* its commit is on the base, otherwise `failed/interrupted`. Recovery also removes the run's incoming ref and the claim it owns.
- §3.12 and §3.13 are not written in `kogen-core-spec` yet, so the recovery rules here are a **proposal** for them.
- **Spec:** `spec/landing.qnt` (277 lines). It has 9 events and a phase per atomic step (building → built → recorded → pushed → based → cleaned), where each boundary is a crash point. It defines 7 safety invariants: no double landing; every Kogen commit was a CAS from its expected parent; landed implies on the base; the claim belongs to a running run; at most one live owner; incoming refs only for running runs; the CAS never precedes the Landing record. There is also a post-condition for recovery.
- **Scenarios:** 18, about 260 lines of JSON. They cover the happy path, a red gate, re-approval as retry, three queue-order rules, parking on a moved base, a push after the CAS, crashes at each of the 5 phase boundaries, SIGTERM, recovery inside `queue start`, two landings in a row, 8 refusals, and "landed is final". I wrote them from the prose in §2.5.4, §2.8.2 and §2.11, not from the Quint code, so they test the spec rather than echo it.
- **Spec checks:**
  - 18/18 scenarios agree with the spec, in 1.1 s.
  - Simulation found one bug in the spec at once: the recovery post-condition was too strong, because a *live* Build may hold an incoming ref during recovery. After the fix, 20,000 traces of 40 steps passed in 22 s.
  - Apalache did not run: there is no JRE on this machine, and I did not install one.
- **Generation:**
  - Uniform random events rarely finish a 5-step landing. With uniform choice, 4 of 18 implementation mutants survived the generated traces, 3 of them on the deep landing/recovery path. Weighting the event groups without guards still reached the `cleaned` phase in only 61 of 9,300 states.
  - Guarded `any` branches fixed that: Gate(true) only while building, Step only while landing, plus one unguarded branch so refusals are still exercised. With them, 1,000 traces (30,000 events, 39% refused) took 3.9 s and reached `reconciled` 499 times.
- **Blind implementations:** I gave a Sonnet agent per language only `landing.qnt` and `PROTOCOL.md`, with no scenarios and no harness.
  - Go: 410 + 115 lines, 83 s. Rust: 370 + 43 lines, 72 s. Elixir: 253 + 57 lines, 74 s.
  - **All three agreed with the spec on 1,018 traces and 30,148 steps at the first run**, in 0.9 s, 1.3 s and 2.1 s.
  - Their unprompted lists of spec ambiguities are the most useful by-product. Each item below was flagged by at least two of the three agents:
    - the `""` sentinel makes `Start("")` create a run whose claim reads as "no claim";
    - `claim_held` is unreachable;
    - `Step` during `building` gives the generic `nothing_to_step`;
    - parked refs are never cleared;
    - re-approving a SIGTERM'd Intent whose dead run still holds the claim makes it derive as `building`;
    - the protocol has no error shape.
- **Seeded implementation bugs** (18, in Go, `harness/mutate.py`):
  - **Hand scenarios caught 17.** They missed "latest run chosen by id order, not start order" because hand-written ids always increase.
  - **Generated traces caught 17 at first.** They missed "an external commit may reuse a run id" because run ids and external ids came from disjoint universes. Making the universes overlap (`r1` in both) brought this to 18/18.
  - Typical feedback a builder would get:
    `12-crash-after-cas: diverges at step 9 … runs.r1.status: want "landed", got "failed"`.
- **Seeded spec bugs** (`harness/spec_mutants.py`):

| Spec mutant | Scenarios | Invariants (and simulation) |
|---|---|---|
| no CAS (land on a moved base) | 07 fails | S2 violated |
| record Landing after the CAS | 8 fail | S7 violated |
| queue tie reversed | 05 fails | silent |
| recovery ignores the Landing record | 12, 13 fail | silent |

  Invariants catch *unsafe* specs without anyone writing expected values. Scenarios also catch *safe but wrong policy*. Both are needed.

## 4. Evaluation
**Effort per spec.** [M/I]
- The spec is roughly the size of one implementation (277 lines against 300–420), and the scenarios add about 260 lines of JSON.
- Writing spec plus scenarios took about an hour of agent time here, including the one spec bug found by simulation and the generator tuning.
- The harness is a one-off. Each new language costs one adapter (40–115 lines), and in this run an agent wrote it in about 80 s.
- The recurring cost is keeping the scenarios honest. They must be written from intent (prose, decisions), not read off the spec.

**What it catches.**
- Wrong transitions, missed cleanups (refs, claims), ordering and tie-breaks, crash-recovery mistakes at every fault point, wrong refusal codes, and status-derivation drift.
- These are exactly the bugs that make implementations diverge silently.
- It also catches **spec** bugs before any code exists. Implementing agents surface ambiguity as a side effect, so the spec gets sharper with each language. [M]

**Limits.** [M/I]
- **I/O.** Only the pure core is checked; git, the filesystem and processes sit behind the adapter. A second tier must map the same abstract events onto real effects:
  - Start → `kogen queue start` in a temp repo;
  - Crash → SIGKILL at a named fault point (e.g. `KOGEN_FAULT=after:recorded`);
  - PushExternal → a push from a second clone;
  - observe → read the refs, `run.json` and `status --json`.

  MongoDB's experience says this state projection is where the real cost lies.
- **Timing.** The spec has no clock. Time is an input, so timeouts, latency budgets ("status < 1 s") and retry delays are out of scope.
- **Concurrency.** It is modelled as interleavings of atomic steps that the scenario chooses. Implementations must expose the same atomic granularity as fault points, which is FoundationDB-style deterministic simulation. True parallel races in a real build need the real-I/O tier with controlled scheduling, or Maelstrom/Jepsen.
- **LLM nondeterminism.** Model output enters as events (`Gate(bool)`). The spec covers the control plane around the model, never the model's quality.
- **Universe bias.** Generation explores only the declared strings and ids:
  - the Go/Rust vs Elixir divergence on `Start("")` (accept vs `invalid_id`) is invisible to all 1,018 traces;
  - the id-collision mutant survived until the universes overlapped.

  Remedy: run cross-implementation differential fuzzing outside the universe and turn each divergence into a spec rule.
- **Quint quirks.**
  - Strings have no ordering or concatenation, so slugs are ranked through a pre-sorted universe list.
  - `quint test` stops a run at the first failing `expect`.
  - Map reads on missing keys rely on lazy evaluation.
  - `run` and `next` are reserved words.
  - Apalache needs a JVM.
- **Common-mode risk.** A wrong spec makes every implementation wrong in the same way, and agents copy spec quirks faithfully (Go and Rust reproduce the `""` sentinel bug). Scenarios written independently from the prose are the defence.
- **When it is not worth it.** Pure functions with I/O pairs (Intent parse and lint, YAML errors) need only CommonMark-style example tables replayed through an adapter, not Quint. Quint pays off when there is state, faults and interleaving.

## 5. Fit with Kogen
**For the core rebuild** (`kogen-core-spec`): ship a `conformance/` folder next to the prose. [I]
- **Example tables:** §2.1/§2.2 Intent parse + lint and §2.6 YAML errors (exact messages).
- **Quint specs:** §2.11 status + queue, and the claim/landing/recovery slice from this prototype, which can become §3.12/§3.13.
- **A derivation:** the §2.9 setup cache key.

Then "Rust vs Go vs Elixir" becomes a measurement: the same golden traces, the same adapter protocol, divergences reported per field. The agents' ambiguity lists should feed the prose spec.

**For Intents** (a language-agnostic acceptance gate). [I]
- **A new Verify kind:** `- A3: scenario landing/12-crash-after-cas`, next to `test` and `test keep`.
- **At approval:**
  - `xspec spec` must pass (scenarios agree with the spec, invariants hold, generation finds no violation);
  - the spec, the scenarios and the golden traces enter the protected manifest (§2.5.2).

  **This tests the acceptance itself before any Build exists**, which `test` items cannot do today.
- **Red on base carries over:**
  - a change scenario must diverge on the base implementation;
  - a keep scenario must pass on it.
- **At the gate:** `xspec conform` runs through the project's adapter, declared once in `project.yaml`. The adapter is a command file, so it is protected (§2.5.3).
- **Shaping:** the shaper edits the spec delta and the scenarios, and the human reviews the scenarios (readable JSON) instead of test code.

Use this only for state-machine logic. Product Intents (UI, CRUD, prose) keep `test`. This fits `verification-beyond-tests/`, whose item 3, "model-based tests of landing against real git refs before P3", is the real-I/O tier above with the same traces. Its "TLA+ needs a JRE" cost no longer applies to Quint's simulator.

## 6. Next steps (if adopted)
1. Fix the spec ambiguities the agents found. Replace the `""` sentinel with an option type, and give `Start("")` a defined refusal.
2. Add `xspec diff`, which fuzzes outside the universe across ≥2 implementations.
3. Add trace shrinking for readable failures.
4. Write the §2.11 status/queue spec and the parse/lint example tables for `kogen-core-spec`.
5. Prototype the real-git adapter tier against the Elixir core with fault-point injection.
6. Only then propose the `scenario` Verify kind as a decision.

## Files
`prototype/`:
- `spec/landing.qnt` is the spec, and `PROTOCOL.md` the adapter protocol.
- `scenarios/` holds the 18 scenarios, and `golden/hand/` their neutral traces. Generated traces are rebuilt by `run.sh`.
- `harness/` contains `xspec.py`, `mutate.py` and `spec_mutants.py`.
- `impls/{go,rust,elixir}/` are the agent-written cores with their adapters.
- `run.sh` runs everything. It needs node (Quint 0.33 via npm), python3, Go 1.27 (via mise), cargo and Elixir 1.20.
