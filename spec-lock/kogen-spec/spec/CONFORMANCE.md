# Conformance: the black-box oracle

**v1.3-draft status:** this inventory describes historical frozen v1.1 cases. The owner-accepted changes and replacement/additional cases are in [CHANGES-v1.3.md](../CHANGES-v1.3.md). In particular, the old ladder demotion cases 5–11 do not define the current observational gate. The conformance repository remains unchanged; a v1.3 release requires a new frozen executable suite and named spec/suite revisions in its results.

## C.1 Definition
- An implementation is **conformant on a host** when it passes every case in the behaviour profiles `cli`, `state`, `approval`, `shape`, `build`, `ladder`, `provider` and `custody`, plus the `format` profile, with no unmatched fake-provider request. **Full conformance** means conformant on both macOS and Linux. The `exunit` profile is also required for the Elixir tier.
- A case passes only if every assertion holds: exit code, stdout (exact, regex or JSON schema), the stderr rule from §1.1, files, git refs, the journal subsequence and fake-provider requests. A failing case may not be retried.
- `format` cases pin strings that the spec ships as data (help pages, lint lists, YAML wording, progress text, the ExUnit command line). They are reported separately so that behaviour work is weighted on its own.

## C.2 Freeze rule
The runner, the fake server, the `kt` fixture and every case file are written and **frozen before any implementer starts**.
- They are validated against the reference once it has the seams from §4.1 and the `command` adapter. A case may encode only what the spec states.
- Golden outputs are generated from `data/` and the spec text, never from an implementation.
- A release spec change lands together with its executable cases. Draft revisions may record required cases without modifying the frozen suite, but MUST be labelled unverified and MUST NOT claim release conformance. An ambiguous case is fixed in the spec first.

## C.3 Harness
```
runner ─▶ kogen   HOME, TMPDIR, PATH=<stubs>:…, KOGEN_PROVIDER_URL, KOGEN_AUTH_URL, KOGEN_AUTH_PATH,
  │               KOGEN_TIME_SCALE=0.01, KOGEN_CREDENTIAL_STORE=file (v1.1), GIT_CONFIG_GLOBAL (Kogen Test <test@kogen.invalid>, no signing)
  ├─ fake server (§4.8): script per case; /_fake/requests for assertions
  └─ per case: temp HOME, bare origin, checkout, fake-server port; cases run in parallel
```
- **Runner.** One program in a language that is not a candidate. Recommended: Python 3 standard library only.
- **Stubs.** `mise` (`env --json` prints a map; `exec --` passes the command through); `open` and `xdg-open` (they follow the authorize URL to the loopback); argv-size loggers for `sh` and `git`.
- **Timing.** Timing cases assert the unscaled journal values (`delay_ms`, `wait_ms`), never wall clocks, except custody cases, which use generous bounds.
- **Determinism.** The same script run twice must give the same event sequence, ignoring ids and `ts`.
- **Fixtures.**
  - `kt` (Appendix A): text files, `sh` checks that print GNU lines, and the `command` adapter. It needs no compiler.
  - `exunit-hello`: needs Elixir.
  - `empty`.

### Case file
```yaml
fixture: kt
project: {build: {ladder: {max_rungs: 3}}}
steps:
  - write: {path: .kogen/intents/greet/intent.md, from: files/intent.md}
  - commit: "Add greet Intent"
  - run: [kogen, intent, approve, greet, "{hash8}"]
    expect: {exit: 0, stdout_regex: '^approved greet [0-9a-f]{8} \(approval [0-9a-f]{8}\); it is queued\n'}
  - run: [kogen, queue, start]
    expect: {exit: 0, stdout_lines: ["building greet", "~landed greet [0-9a-f]{8} \\(Build [0-9a-f]{8}\\)", "queue: done; 1 Build(s), 1 landed, 0 not"]}
  - assert: {events_subsequence: [started, plan, rung_started, verification, commit_result, landing_prepared, {event: finished, status: landed}], fake_remaining: []}
```
The runner computes the placeholders (`{hash8}`, `{state_root}`, `{run_id}`) from the spec's formulas.

## C.4 Profiles
| Profile | Cases | Needs |
|---|---:|---|
| `cli` | 30 | — |
| `state` | 30 | git |
| `approval` | 24 | git, kt |
| `shape` | 26 | fake, kt |
| `build` | 44 | fake, kt |
| `ladder` | 36 | fake, kt |
| `provider` | 26 | fake (and OAuth for login) |
| `custody` | 10 | kt |
| `format` | 12 (≈ 180 instances) | — |
| `exunit` | 6 | Elixir, mise |
| **Total** | **244** (≈ 410 instances) | |

## C.5 Cases
### `cli` (§1)
1. Top page via `kogen`, `help` and `--help`.
2. All 16 pages by every route.
3. Unknown command.
4. Unknown subcommand, also with `--help`.
5. Unknown option.
6. Missing positionals: `<slug>`, `<file|->`, `<provider>`.
7. Unexpected argument.
8. Option that needs a value.
9. `--json=true` gives "takes no value".
10. Bad hashes: uppercase, 5 characters, 65 characters, non-hex.
11. Unknown provider.
12. `--watch` together with `--json`.
13. `--` makes the next token a positional.
14. Options placed before the command.
15. A repeated option: the last one wins.
16. `-x`.
17. `help` with a bad topic.
18. All 15 moved forms.
19. A moved form beats `--help`.
20. `version` format, outside any repo.
21. Invalid slug gives a usage error.
22. Usage errors leave stderr empty.
23. A relative `--project`.
24. `--help` after positionals, for each command (one case, 14 rows).
25. Status overview golden: every section, padding, and `and k earlier`.
26. Status slug golden: draft, queued `2 of 3`, failed with the Build block.
27. `--watch` prints frames only on change and returns 0 once idle.
28. `status <slug> --watch` exits 1 when the Intent did not land.
29. SIGINT exits 130.
30. The `queue: stopped because <slug> hit a provider error; …` line.

### `state` (§2)
1. Project config errors give `line <n>` and the error class, exit 3 (20 YAML rows).
2. Schema errors: every issue is listed.
3. A valid config using every key.
4. Intent parse errors (16 rows) give `intent/parse`, exit 1.
5. Lint `error` rules (14 rows) give `intent/lint`, exit 1.
6. Lint `style` rules are card warnings and exit 5.
7. A Request containing banned words and CRLF is not linted. The hash covers the raw bytes.
8. The approval hash covers the test: editing the test changes the hash, and the old prefix gives a mismatch.
9. `approval.json` schema and trailers.
10. A tampered approval gives `controller/approval_invalid` and stops the drain.
11. `run.json` and `events.jsonl` schemas; every event has `ts`; reasons are strings.
12. Report schema (§2.10).
13. State-root key for a symlinked checkout.
14. `accounts.yaml` bytes and order; an empty `chatgpt:` map is accepted.
15. Machine config: the project's recipe roles win.
16. Rejected configs: `env` with `KOGEN_*`, a scalar domain, duplicate check names.
17. Status: landed beats a stale failed run.
18. Status: the claim marks the latest run as building.
19. Status: re-approval re-queues a failed Intent.
20. Status: a `stopped` run leaves the Intent queued.
21. Interrupted derivation.
22. Queue order.
23. Slug reuse: a new `intent.md` under a landed slug is a draft, then builds after approval.
24. The 7 landed Intents shown as the 5 newest plus `and 2 earlier`.
25. A stale `shape-warnings.json` is ignored.
26. The setup cache key changes with setup, env and base tree, but not with `TMPDIR` or `MISE_STATE_DIR`.
27. Setup cache keeps at most 3 entries.
28. The approval-baseline cache: the card call and the hash call run the checks once.
29. Two concurrent approves: one CAS retry, then both commits exist in a chain.
30. Status on 50 Intents and 200 runs takes under 1 s (reported; fails only above 5 s).

### `approval` (§1.7.2, §2.5, §3.3)
1. Card golden; exit 5; no ref and no run.
2. Prefixes of 6, 8 and 64 characters: the ref is written, the tree holds 3 files, the message matches the golden.
3. A mismatch is reported before any check runs (setup marker absent).
4. Re-approval chains to the previous approval as parent.
5. `--by` is stored verbatim.
6. The approver defaults to the git identity.
7. No git identity gives exit 2.
8. A red baseline check gives the warning block plus a baseline row.
9. An unavailable baseline check gives a `unavailable` row.
10. A red acceptance check gives exit 1.
11. An acceptance check exiting 127 gives exit 3.
12. Setup runs before the checks.
13. Setup failure gives exit 3.
14. A checkout behind its base gives exit 3.
15. Manifest contents: protected globs, `project.yaml`, Makefile, the script of `sh x.sh`, an absent literal, the `acceptance.run` script.
16. `changes_gate: true` drops the gate files.
17. Shape warnings, including `feasibility_concern`, appear on the card.
18. Approving starts nothing.
19. The staged test path is already occupied: exit 3.
20. The checkout is clean after approval.
21. An Intent with no change item gives `no_change_item`, exit 1.
22. `remove` on a draft: commit, and only the Intent's paths change.
23. `remove` without `--force` (approved, failed, parked, interrupted variants), then with `--force`.
24. `remove` during a Build gives `remove_blocked`; an untracked Intent gives `remove_requires_commit`.

### `shape` (§3.2)
1. Happy path: text output, the Request appended, nothing committed.
2. `--json` schema.
3. stdin with CRLF.
4. A non-UTF-8 request is kept byte for byte.
5. An empty request gives exit 2.
6. The first message matches the template and carries the marker.
7. Both files written in separate turns, then a done message: no repair (finish rule).
8. A done message with a file missing gets the finish-guard reply, which does not count as a repair.
9. A write outside scope returns an error result.
10. A lint error gives a repair message with the exact text, in the same conversation.
11. Style findings are repaired without counting; leftovers become `lint_*` warnings.
12. Passes 4–6 use `fallback_shaper` in a fresh conversation.
13. 6 failing passes give exit 1.
14. Reclassification in both directions.
15. `all_items_keep`.
16. An acceptance check red gives a repair; exit 127 gives exit 3.
17. An undeclared gate path.
18. A missing formatter gives a stderr warning only.
19. Requirement ledger: a number in the Request with no row gives a `coverage_gap` repair, then a warning.
20. Shaping audit: `over_strict` with a valid citation gives one repair.
21. Shaping audit: no citation gives no repair.
22. `Concerns:` lines give deduplicated warnings.
23. Model and effort come from the `shaper` role, defaulting to `gpt-6.1-sol/high` (v1.1).
24. 503 twice, then success.
25. 401 gives exit 4.
26. Witness mode: green witness gives `Feasibility: PROVEN`; red with an `UNDECIDED` adjudication gives `UNPROVEN`, and approve then exits 1.

### `build` (§3.4–§3.11)
1. Empty queue.
2. R1 happy path: the planner request (Intent bytes plus `ls-files`, no tools, `Difficulty`), the builder request (marker, base acceptance block, tools `["shell"]`), the landed commit golden with sole parent and trailer, the Intent and test landed but not the source, claim and incoming refs gone, workspaces gone.
3. Journal order for the happy path.
4. A red verification leads to a repair, then lands; the feedback matches §3.7.3.
5. Progress count 4→3→2→1→0 lands after 4 repairs.
6. The repair cap of 6 holds.
7. `unchanged` ends the rung.
8. The first empty done claim is refused.
9. A shell edit to the test is restored with a note.
10. A 4th restore ends the rung.
11. A check that mutates the tree gives a red with the changed paths.
12. A check that times out gives red with feedback (it does not on base).
13. A check that is unavailable now but ran on base gives red with feedback.
14. A check unavailable on base too is excused; the Build lands.
15. A base-red check with the same identities is excused; the Build lands.
16. A base-red check with a new identity: red.
17. Base-red with unparseable output and the same exit status: excused; lands.
18. A check that mutates the tree on base too: excused, its writes are reverted, the Build lands.
19. Two kt tests in one file: a new failing test is not excused (the identity includes the symbol).
20. A fix exiting 1 is a red finding.
21. A scope warning does not block landing.
22. Base moved before start: builds on the tip.
23. Base moved, every item already green on the tip: Intent-only landing.
24. Base moved mid-Build (side effect): rebase, re-verify, land.
25. A conflicting moved base: integration repair, then land.
26. Conflict repairs exhausted: `parked`, and the drain continues.
27. A `.lock` present: `landing_retry`, then lands once the lock is removed by a side effect.
28. Checked-out base, clean: updated.
29. Checked-out base, dirty: warning on stderr.
30. The builder deletes, renames, sets `chmod +x`, adds a symlink and commits: the landed tree is correct.
31. Queue order; each Intent is built once per drain.
32. `already running`.
33. `queue stop`.
34. `--detach`.
35. A stale lock is taken over.
36. `kill -9`, then status shows `crashed`.
37. A synthetic landed run is reconciled.
38. SIGTERM shows as interrupted.
39. Setup failing twice: `stopped`, exit 3, the Intent stays queued.
40. The acceptance runner unavailable on base: `stopped`, exit 3.
41. Two drains on two checkouts of one origin: `build_already_claimed`.
42. Branch mismatch gives `skipped`; the exit code is unaffected.
43. Commit identity is the git config identity; hooks never run.
44. `max_rungs: 1` never makes an auditor or R2 request.

### `ladder` (§3.1, §3.8)
1. R1 green: no further requests.
2. R1 hits the repair cap: an auditor request carrying the citation inputs; then R2 runs with `rung2` in a fresh workspace, no plan, and the earlier-attempts summary without a diff.
3. `Difficulty: hard` makes R2 the first builder, and it gets the plan.
4. With `max_rungs: 1`, `hard` is ignored.
5. An over-strict A2 with a valid citation and everything else passing gives `green-with-advisory-tests`; it lands by default with the `(advisory: A2)` line.
6. The same with `land: green`: `failed` with the best candidate parked.
7. An over-strict citation that is not in the Request does not demote.
8. Infeasible with a citation from the output demotes.
9. Invalid auditor JSON demotes nothing.
10. The auditor demotes every change item: never landable.
11. Demotion, then the ended rung is re-scored and lands with no new rung.
12. R2 not landable leads to R3 with `rung3`.
13. Not landable after R3: selection, `failed`, `candidate.diff` is the winner's.
14. Selector: more passing items wins.
15. Selector: on equal items, fewer findings wins.
16. Selector: smaller diff, then earlier rung.
17. An `unverified` best candidate is still emitted.
18. The budget runs out mid-R2: cancel, verify, select.
19. The budget runs out during landing repairs: the landing allowance is used, then `parked`.
20. `unchanged` in R1 moves to R2.
21. `turn_cap` in R1 moves to R2 after a final verification.
22. A provider stall in R1 is retried inside R1 (`provider_retry`, no new rung).
23. Candidate refs are written per rung.
24. Report fields: `rungs`, `best_candidate`, `audit`, `verdict`, `advisory_items`.
25. The drain line for a best candidate.
26. Rung walls of 20/12/12 minutes appear as the unscaled values in `rung_started`.
27. Repair counters reset for each rung.
28. Each item is audited at most once per Build.
29. A keep item regressed in R1 is fed back like any failure.
30. The R2 first message holds the R1 summary: at most 5 lines of at most 180 characters each.
31. R4 never runs unless `experimental_r4` is set.
32. Witness mode: the witness re-verifies green and lands with zero model requests.
33. Witness mode: the witness is red on a moved base, so the ladder runs; there is no demotion.
34. The same script twice gives an identical event sequence.
35. A usage limit mid-R2: `provider_wait`, the budget is paused, the Build continues and lands.
36. Provider exhaustion (4 attempts per request, 2 stage retries): `stopped provider/overload`, the Intent stays queued, exit 4 (v1.1).

### `provider` (§4)
1. Injected-mode request: headers and exact body keys.
2. Owned-mode request after `login`: the `additional_tools` item.
3. The planner and auditor send no `tools` and no `additional_tools`.
4. Statelessness: the input chain and `call_id`s.
5. `prompt_cache_key` formula.
6. SSE edge cases.
7. `completed.output` takes precedence.
8. A missing `completed` is malformed and retried.
9. Bad `arguments` are malformed.
10. 401 and 403: one refresh, then `stopped provider/login`, exit 4.
11. 429 with `retry-after`: `provider_wait.wait_ms` equals it.
12. Backoff sequence: `delay_ms` is jittered within 1–2 s, 2–4 s, 4–8 s (v1.1).
13. Two consecutive 503s switch the stage to its fallback model, `gpt-6.1-sol/medium` (v1.1).
14. First-byte stall: timeout.
15. Idle gap: timeout.
16. Total cap: timeout.
17. Stream dropped mid-way.
18. An SSE `rate_limit` event counts as a usage limit.
19. An expired injected JWT: exit 4 and zero requests.
20. Usage accounting.
21. Login via the fake OAuth: PKCE S256, then `list`, `use` and `logout` lines.
22. Two processes refreshing at once make one refresh request.
23. Shell tool results: exit code, timeout, clipping, base64.
24. Shaper `read`/`search`/`write` results (10 rows).
25. A tool outside the allowed set.
26. Path escape.

### `custody` (§5.5)
Behaviours 1–10.

### `format` (data files)
1. Help pages are byte-exact (16).
2. Every banned word and phrase (65).
3. Every hedge (13).
4. Tier boundaries.
5. YAML error wording (24).
6. Moved-form wording (15).
7. Shaper progress text.
8. Card warning wording.
9. Error-line wording (§1.5 table).
10. Feedback line format.
11. The accounts.yaml header comment.
12. The status `--watch` frame separator.

### `exunit` (§2.4.3)
1. Ledger from tagged ExUnit tests; the Build lands.
2. Missing `erl` makes the runner unavailable, which stops the Build.
3. A compile failure gives `acceptance_compile_failed` and a repair.
4. Base-red ExUnit identity.
5. Formatter derivation.
6. The ledger formatter is written only in the run dir.

## C.6 Comparing implementations
Only conformant implementations are compared, on the same machine, git version, fixtures and fake server:
1. Behaviour and format pass counts. Both must be 100 % to enter the comparison.
2. Latency: cold `help` and `version` (p50 and p95 over 20 runs); `status` on the 50/200 fixture.
3. Full-suite wall time with 8 workers; peak memory during `build` case 2.
4. Install size and user-visible runtime dependencies.
5. Non-test lines of code; third-party dependencies; time for a fresh agent to fix a planted bug (same model, 5 repetitions).
6. Optional: a live held-out benchmark with the same models and account, ≥ 5 repetitions per task. A success-rate difference here points at a spec gap, not at the language.

## Appendix A: the `kt` fixture
```
lib/greet.txt          "Hello!\n"
checks/lint.sh         prints `lib/<f>:<n>:1: error: [lint/todo] <f>: TODO found` per TODO; exits 1 if any
checks/unit.sh         runs test/unit/*.t.sh; prints `test/unit/<f>:1:1: error: [kt/test] <name>: failed` per failure
checks/fmt.sh          strips trailing spaces in lib/*.txt (the fix)
checks/setup.sh        creates build/ready (setup_outputs: [build])
run-acceptance.sh      sources {path}; runs each t_A<n> in a subshell; appends
                       {"tag":"<slug>/A<n>","test":"A<n>","status":"passed|failed"} to $KOGEN_LEDGER_REPORT
.kogen/project.yaml    checks [lint, unit]; fix [fmt]; setup [setup]; setup_outputs [build];
                       acceptance {adapter: command, ext: .t.sh, candidate_dir: test/acceptance,
                       run: [sh, run-acceptance.sh, "{path}"]}; protected_paths [Makefile]; domains {app: [lib]}
```
Example test, `.kogen/acceptance/greet.t.sh`: `t_A1() { grep -qx 'Hello, Almir!' lib/greet.txt; }`. Fake builder steps make changes with `shell` calls.
