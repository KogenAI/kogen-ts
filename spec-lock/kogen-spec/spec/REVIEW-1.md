# REVIEW-1: Kogen core v1 specification (5 Oct 2026)

Independent review of README, 01–06 and CONFORMANCE against features/24-cli.md, Almir's owner rules, the four resolved calls and research/beat-codex.

## Summary
1. The CLI, formats, provider wire and custody chapters are strong. A good agent could implement §1, §2, §4 and §5 in Rust or Go with few questions.
2. §3 (the ladder) cannot be implemented as written. There is no Build-level sequence, rung `acceptance` modes conflict with the verdict, and roles, events and budgets contradict §2.3.
3. Two of the four resolved calls are implemented the other way round: (1) advisory landing defaults to *no*, and (4) Linux *refuses* to build without a sandbox. README Q1–Q4, LD-03 and SB-08 all encode the old answers.
4. Combined with call (1), the verdict rule as written would land an R3 or R4 candidate that passes **zero** acceptance items, because every item counts as "advisory" on those rungs (§3.10).
5. Some rules still stop the gate from ever going green, which breaks the "lane-keeping, not walls" rule. These are the §3.7.2 exit-level heuristics, unparseable base-red output, checks unavailable on the base, and checks that mutate the tree. They reproduce beat-codex classes C and L.
6. Shaping is now the single point of failure (call 2). It keeps the quirk behind 207× `generated_file_missing`, has a single model, and burns its repair cap on style lint.
7. The suite has good coverage of trivia but misses about 20 behaviour cases. Some cases cannot discriminate (backoff timing at scale 0.01) or cannot be run (no Linux seam). The cases, runner and fake server exist only as a catalogue.
8. Size: about 46 pages could be about 32 pages plus data files. Cut the reference annotations, the sandbox detail, the `direct*` recipes, the judge and legacy report fields. Move help pages, word lists and YAML messages into machine-readable files.

**Verdict: needs revision.** One focused pass on §3, the four calls and the suite gaps; no rewrite. Fixes 1–8 block a fair multi-language implementation.

## Prioritized fix list
**P1: blocks implementation or violates an owner rule**
1. **Apply the four calls.** (1) Default to landing `green-with-advisory-tests`, recorded in `finished`, the report and the `landed … (advisory: A2)` line; `build.land: green` can stay as an opt-out. (4) Build unconfined on a host without sandbox support: print `kogen: warning: sandbox unavailable: <reason>; building unconfined` on stderr (add it to the §1.1 allowlist), record a `sandbox_unavailable` event, add a report field. Close README Q1–Q4; fix README summary 7, LD-03/LD-04 and SB-08.
2. **Separate steering from the verdict.** Delete the rung field `acceptance: blocking|audited|advisory` (§3.1, §3.11.2); every rung feeds failing items back and counts them, and only a per-item auditor demotion changes the verdict. A landable verdict needs at least one *undemoted* change item passing, so the auditor cannot vote a candidate in. State whether `infeasible` lands like `over_strict` (call (1) names only over-strict). After each audit, re-score the rung that just ended and land it if now landable; any landable verdict stops the ladder (§3.11.2 says only `green` does).
3. **Make `environment` a narrow class (§3.7.2).** Today a candidate's infinite loop (timeout → level 3), test output containing `No such file or directory` or `not found`, and "a recognised tool with no findings" all end the rung with no feedback: beat-codex class L ("compile errors labelled check_unavailable"). "Usage text", "nothing ran" and "recognised tool" are also undefined across stacks. Replace with: unavailable = 126/127/not-found/no exit status or an adapter-declared signal; timeout = red and fed back when the check did not time out on the base; any other non-zero exit = red with GNU findings plus the raw tail.
4. **Make base-relative gating lane-keeping (§3.8, §3.11.6, §5.4).** Excuse a check that is red with unparseable output, unavailable, or tree-mutating on the base (compare exit status, and identities when they exist), record it, and still allow `green`. Today "no identities = no excuse" and "unavailable on base → never green" are walls; beat-codex: 17 of 25 never-green cells had format-red bases. Define GNU line → `(path, kind, id)` exactly, including whether `symbol` (the test name) is part of `id`; otherwise two kt tests in one file share an identity and a new failure gets excused.
5. **Make shaping robust; call (2) makes it the only route to a Build.** (a) End a pass on a response with no tool calls, not on the first successful write (§3.2.3); the current rule forces a `generated_file_missing` repair whenever the two files are written in separate turns (beat-codex: 207×). (b) Give shaping its own ladder: shaper role for 2 repairs, then a fresh `gpt-6.1-sol/high` conversation for 3 more. (c) Style lint (banned words, hedges, sentence length) must not consume repairs: auto-repair outside the cap, or warn, the same way at approve. (d) Test audit at shaping time: see §(c).
6. **Write the Build orchestration down as one table:** rung entry → rung end → audit → re-score → next rung | selection → commit → landing → finish, with the required event order (cases assert `events_subsequence`). Also define: `failed` vs `parked`; `finished.attempt` under the ladder; R4 repairs (the `Rung` record has `base: 2`, §3.11.2 says none); whether landing and §3.12.2 moved-base repairs sit inside the budget (R4 takes "rest of budget", so they can never run after R4); what `budget.output_tokens` does; every item already green on a moved tip (empty diff → `none` or `green`?).
7. **Provider outages must not fail Intents (§4.5, §3.13).** Today `usage_limit` retries until the 60-minute budget runs out, so every queued Intent burns an hour, becomes `failed` and needs re-approval. On `usage_limit`, wait for the reset (`retry-after` or reset fields) with the budget clock paused, or stop the drain and leave the Intent queued. Same for `provider/login`: nothing about the Intent was judged.
8. **Fix the contradictions:** roles `rung2..4` (§3.11.2) are rejected by §2.3 ("unknown role"); `provider.fallback` (§4.5) is not in the project.yaml schema; `login` is `environment` in §3.5 but a provider class in §4.4; CLI-06 expects `missing <name>` for `provider login`, whose usage line has a literal `chatgpt`; `bad_slug` lint is unreachable because the CLI rejects the slug first (FM-05 counts it); FM-06 says 58 banned items, the list has 65 (40 words, 25 phrases); feedback cites `(--all)`, a flag that doesn't exist; §1.1's environment list omits `KOGEN_AUTH_URL` and `KOGEN_TIME_SCALE`.

**P2: success rate, speed, discrimination**

9. **Make the suite real and discriminating.** Freeze the runner, the fake server and the case files before any implementer starts, and validate them against the reference. Today the cases exist only as a catalogue, and whoever writes them first will fit them to their own implementation. Add the cases listed in §(b).
10. **Simplify the Build.** Keep one recipe, `ladder`, with `build.ladder.max_rungs` for benchmarks (R1 alone = plan-shell). Drop `direct` and `direct-shell`, and with them the builder's `edit`/`write`/`diagnose` tools (shell-only is the measured winner, `build.builder-tools`). Drop the judge: selection never picks something that lands, because landable candidates land the moment they appear. Drop R4 unless measured; R3 already sees the Request and has repairs.
11. **Use what the planner already says.** On `Difficulty: hard`, enter at R2 (Sol). This costs nothing extra and targets the E3 Luna-class misses (Codex Luna 6/20, Sol 19/20).
12. **Don't anchor later rungs on R1's plan.** R2 and R3 reuse it (§3.11.2), and a bad plan is a common reason R1 fails. Give them no plan or a fresh one.
13. **Never discard a diff.** When the budget runs out with only non-compiling candidates, still emit the best one as `unverified`. Legitimate stops should be only login, setup twice and controller (§3.11.6).
14. **Retry transient landing failures.** A `.lock` present or a lost CAS after a landable candidate gets a few backoff retries (the provider-retry lever), not a terminal failure (BD-30).
15. **Avoid redundant approval work.** Cache the approval baseline by (base_sha, checks, setup). Today the card and the hash call each run setup and every check (§3.3). Compare the hash *before* running checks.

**P3: correctness edges and clarity**

16. **Specify the YAML subset (§2.6) as a grammar** with error precedence, or have FM-01 test only `line <n>:` plus the class. The 24 messages cannot be matched one-to-one without a grammar: which of the two "anchors…" messages applies, and when does "list item in a value position" win?
17. **Let the approval hash cover the acceptance test bytes too.** Today a test can change between the card and the approve without a mismatch (§2.1.3, §1.7.3).
18. **Fix slug reuse.** `landed` = "any `Kogen-Intent: <slug>` commit reachable" (§2.11), so a reused slug is landed forever and never builds. Require the landing tree's `intent.md` to equal the current one.
19. **Make the tree hash start from the build base, not HEAD (§5.4).** The builder may commit or move HEAD. Use `read-tree <build_base>; add -A; write-tree` on a private index.
20. **Key the setup cache on the constructed child env (§5.2), not "the process env" (§2.9).** `PWD`, `SHLVL` and `TERM` would otherwise invalidate the cache on every shell.
21. **Let a lost approval-ref CAS re-read and retry once** instead of exiting 70; it is not a Kogen bug.
22. **List every constant `KOGEN_TIME_SCALE` scales** (shell deadline, check timeouts, login wait, lock staleness, watch poll). §4.1 and C.2 disagree.
23. **Define the fake's `turn` and the tools of tool-less roles.** Say what a "fresh conversation" is (input holds one user message). For planner, auditor and judge, say whether `tools`/`additional_tools` is omitted or sent empty.
24. **Specify `Concerns:` handling (§3.2.7):** parsed from every pass or only the last, deduplicated or not, and allowed in the same response as a write or not.

## (a) Implementability: other ambiguities
- **§3.5.1 progress credit.**
  - The rule says "total repairs granted ≤ 6". Whether the base 2 count toward that total is decided only by BD-12; say it in the text.
  - A "level-1 *test* command" cannot be identified without findings.
  - Lint-only progress earns nothing. Simpler: count all distinct finding identities plus failing items.
- **§3.11.4 selector.**
  - "Suite green" is ambiguous, because the verification includes acceptance (§3.7.1). Beat-codex meant project checks only.
  - "Compiles" relies on a tool named `compile` that only the exunit parsers emit.
  - With 3 or more ties, the pairwise judge order is undefined.
- **§3.6 messages.**
  - Does R4 get the "Earlier attempts" summary?
  - The raw tail has "`$TMPDIR` and `$HOME` substituted", but the spec doesn't say with what.
  - R2 and R3 under fallback: "the other family" names an effort only for Luna → Sol.
- **§2.10 report keys.** `escalation`, `escalations`, `excused_flakes` and `last_gate` are named but never defined. Implementers will emit `null`; cut them.
- **§1.7.5 queue start.** The exit code ignores `skipped` Intents. Say whether they count.
- **§1.10 overclaim.** It says the help pages are fixed by 24-cli, but 24-cli contains no help text. The pages are this spec's UX call. That's fine, but say so.
- **Exit 2 widened.** Exit 2 now also covers `not_found` and `identity` cases, and `status <unknown>` exits 2 where 24-cli lists "0; 3". This is a defensible UX call; record it as one.

## (b) Conformance suite
- **Missing behaviour cases.**
  - **CLI and status:**
    - `status` overview and slug text goldens; `--watch` has no case at all (frames, return rule, exit 1);
    - SIGINT → 130;
    - the `queue: stopped because …` line;
    - the `intent remove` variants for failed, parked and interrupted.
  - **Landed tree and gate:**
    - a landed tree after the builder deletes, renames, sets `chmod +x`, adds a symlink, or commits itself (reset --soft);
    - a candidate infinite loop → repair with feedback;
    - base-red without parseable findings;
    - a check that mutates the tree on the base.
  - **Ladder and provider:**
    - every item already green on a moved tip;
    - slug reuse after a landing;
    - a usage limit in the middle of a drain;
    - the budget running out during landing;
    - auditor demotes everything → not landed;
    - R1 re-scored after the audit → lands;
    - owned-mode Builds (today every Build case runs in injected mode).
  - **Concurrency, input and determinism:**
    - two drains on two checkouts of one origin (`build_already_claimed`);
    - a concurrent approve CAS;
    - a non-UTF-8 request;
    - determinism: the same script twice gives the same event sequence, modulo ids and ts.
  - **The four calls:** advisory lands by default; Linux unconfined plus the warning; a no-test Intent is rejected; concerns print as warnings.
- **Cases that cannot discriminate.**
  - PV-10/13 backoff: at scale 0.01, a 20 ms delay within ±300 ms cannot be told from no backoff. Assert `provider_retry.delay_ms` (unscaled) instead.
  - CLI-24 and §C.9 latency are reported, not gated; fine.
- **Cases that cannot be run.**
  - PV-20 "unreadable by other users" needs a second user, and the macOS Keychain backend is opaque.
  - SB-08 needs a host without confinement. Add a test seam (a `KOGEN_SANDBOX=unavailable` environment variable in Kogen's environment).
  - §5.1.5 "no polling of reused pids" and §5.1.9 "fail closed on temp removal" are internal behaviour.
- **Cases that over-fit the reference (cost implementer time, not success):**
  - FM-06's 65 word instances; SH-21's exact progress text (`wall_remaining_ms=infinity`);
  - PV-03's cache-key formula; EX-*'s `Code.require_file` command line;
  - FM-01's exact YAML wording.
  - Keep them in a separate `format` profile so they don't crowd out behaviour work. Ship lists and messages as data the implementation can load.
- **Weighting.** Only 18 of 235 cases test the ladder, which is the success machinery. The ladder profile should roughly double, mostly with the cases above.

## (c) First principles: maximise success rate
- **Test strength decides success.**
  - The largest non-stop failure class is "landed, own tests green, hidden tests fail": E2+E3 = 38 of 90 in beat-codex.
  - No Build lever can touch it, because a green R1 lands at once.
  - The lever therefore belongs in shaping, where §3.0 rule 1 says doubt lives: a Sol test audit (over-strict check, plus every number, name and constraint in the Request covered by an item or a test) and edge-case items.
  - §6 defers both as "proposals". They should be core, and they replace most of the Build auditor's job.
- **Ladder.** Keep R1 Luna plan-shell → R2 Sol medium → R3 Sol high, entering at R2 on `hard`, with no reused plan. Fresh workspaces are fine. A warm start from the best R1 tree is worth one measurement, not a spec rule.
- **Auditor.** It is the only path to call (1).
  - Require a cited Request sentence for an `over_strict` verdict, or a cited reason the item exceeds the Request. A bare opinion should not demote.
  - Fail closed, as the spec already says.
- **Selector.** Selection only chooses the parked artefact, so rank by closeness to done: blocking items passing → fewer check findings → smaller diff → earlier rung. That is deterministic and needs no judge.
- **Hand-off.** It is good: approved bytes, verbatim Request, `Approach:` Notes. Add the shaper's red-on-base output for each item to the builder's first message. It is free, and it tells the builder exactly what fails.

## (d) Owner rules and the four calls
- **Fixed CLI:** respected. The tree, options, exit classes, moved forms and `--json` scope match 24-cli. The deviations in §(a) are UX calls.
- **Success first:** violated by fixes 3, 4, 5, 7 and 13.
- **"Safety is not a goal":** §5.3, the SB profile and secret denial are safety work. Beat-codex counts 4 of 49 local failures as sandbox denials. Either:
  - keep confinement where it is free, take it out of the conformance gate, and keep only the success-relevant rule (nothing writes the checkout or origin during a Build); or
  - justify each row by success rate.
  - Keep custody and no-argv, which are success-relevant (deadlines, ARG_MAX).
- **Must finish / levers only:** this mostly holds. The exceptions are landing errors after a landable candidate (fix 14) and `budget_exhausted` discarding diffs (fix 13). There is no re-plan and no return to shaping.
- **Lane-keeping:** violated by fixes 3 and 4.
- **Calls:** (1) and (4) are inverted (fix 1); (2) holds (`all_items_keep` and the §6 row); (3) holds (§3.2.7), with gaps (fix 24).

## (e) Size
About 46 pages is too much for an implementer. Target about 32 normative pages plus data files.

| Cut | Pages saved |
|---|---|
| [R]/[Δ]/[T] tags, R-gap prose and the "reference does X" asides, moved to one appendix for the Elixir team | ~3 |
| Sandbox table and SB profile, cut to one rule plus a SHOULD | ~1 |
| `direct*` recipes, builder edit/write/diagnose, judge, R4 | ~1.5 |
| §3.7.2 heuristics and legacy report fields | ~0.5 |
| Help pages, lint lists, YAML messages and constants as `data/*.txt`/`data/*.json` shared with the suite | ~4 of prose |
| CONFORMANCE rows that restate the spec | ~2 |

Add about 2 pages back: the orchestration table, the verdict/status table, the finding-identity rule and the time-scale list.
