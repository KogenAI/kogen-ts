# Conformance triage: Kogen 80a4dd97

5 October 2026. Suite `kogen-conformance` v1 (tag `conformance-v1-frozen`), then v1.1 (tag `conformance-v1.1`). Spec: `careful-rebuild/research/kogen-core-spec/` (now v1.1). Kogen: `~/Areas/Kogen/careful-rebuild` at **80a4dd97** (ladder, test auditor, provider resilience, per-request records).

## Numbers
| Build | Pass | Fail | ref-bug (a) | R-gap (d) | spec (b) | test (c) | Skip |
|---|---:|---:|---:|---:|---:|---:|---:|
| 97ef563d as is (v1) | 21 | 218 | 93 | 125 | 0 | 0 | 5 |
| 97ef563d + seams (v1) | 69 | 170 | 93 | 77 | 0 | 0 | 5 |
| **80a4dd97 as is (v1)** | **21** | **218** | 80 | 129 | 9 | 0 | 5 |
| **80a4dd97 + seams (v1)** | **70** | **174** | 84 | 81 | 9 | 0 | 0 |
| **80a4dd97 + seams (v1.1)** | **75** | **169** | 84 | 84 | 0 | 0 | 0 |

- **Unpatched is unchanged.** The same 21 cases pass (19 cli, format-01/06); every `kt` case still stops before a provider request because the seams are missing.
- **Patched: one more pass, five more cases run.** The five login cases now run (they were skipped on 97ef563d), because the rebased seams add `KOGEN_CREDENTIAL_STORE=file`. provider-02 newly passes; format-11 passes when run on its own. No case regressed: build-34 and state-18 failed once under a load average of 300 and pass on rerun (build-34 also needed the escript to be named `kogen`, which `--detach` checks).
- **v1.1 adds 6 passes** (provider-09/12/14/15/16/17, the resilience cases now follow the code). build-21 failed once in the v1.1 run because the process got an outside SIGTERM (an Erlang INFO REPORT in its stdout) and passes on rerun, so v1.1 is effectively 76/168.
- **The ladder did not move the numbers.** 80a4dd97 has a real ladder (R1 Luna, R2 Sol medium, R3 Sol high), a test auditor and provider retries, but every ladder case still fails on journal names, config keys or report shape before it reaches behaviour, and several behaviour differences remain (below).
- **Classes per profile (80a4dd97 + seams, v1):** cli 5a/3d · state 10a/11d · approval 8a/4d · shape 14a/11d · build 18a/15d · ladder 5a/30d/1b · provider 10a/1d/8b · custody 4a/2d · format 7a/2d · exunit 3a/2d. Primary class per case; a case often has several causes (the full list per case is in `reference/kogen-80a4dd97-seams.json`).
- Raw results: `reference/results/kogen-80a4dd97.jsonl`, `kogen-80a4dd97-seams.jsonl`, `kogen-80a4dd97-seams-v1.1.jsonl`.

## How it was run
- **Isolation.** A new worktree `~/Areas/Kogen/careful-rebuild-wt/conf2` on branch `conf/seams` (deps and `_build` copied with `cp -c -R`). The main checkout, its index and branch `careful-rebuild` were never touched (HEAD still 80a4dd97, status clean). No `.git` was copied to /tmp; nothing outside the worktree and the session scratch was deleted. `~/.codex*`, `~/.kogen/credentials` and the Keychain were never touched: the login cases ran with `KOGEN_CREDENTIAL_STORE=file`, credentials went to the case's own HOME as plain 0600 files, and the `kogen` item count in `security dump-keychain` was the same before and after.
- **Seams rebased.** `proposals/reference-seams.diff` was applied on 97ef563d, committed, and cherry-picked onto 80a4dd97 (branch `conf/seams-97` → `conf/seams`). Three conflicts (escalation, protected restore, chat_gpt timeouts) were resolved. New 80a4dd97 sites were added: the five new hard-coded `_test.exs` paths (audit, gate support, stage runner, candidate snapshot), `KOGEN_TIME_SCALE` on the ladder wall and pause, the backoff delay, the request caps and the plan-shell timeout; a capability-guard exemption for `Kogen.Contracts.Seams`; and the new `KOGEN_CREDENTIAL_STORE=file` seam in `RuntimeDiscovery.credential_backend/0`. Result: `proposals/reference-seams-on-80a4dd97.diff` (38 files, +320/−66), also task 00.
- **Load.** The first full patched run hit a load average above 300 (another suite instance had started by accident and was killed; the Campfire worker and benchmarks were also running). The numbers above are from the clean rerun at load 10–60.

## Inputs from the executable-specs experiment (coordinator, 5 Oct)
- **Resilience prose vs code** (fallback after 2 overloads, overloads only, 4 attempts, jitter): the spec now follows the code (§4.5 v1.1, `data/constants.json`), because they are T66 decisions and no measurement says otherwise. The fallback model also follows the code (every role → `gpt-6.1-sol/medium`), which r66 supports (Sol medium 17/20 vs Luna max 6/20). After the attempts and 2 stage retries the Build ends `stopped provider/<class>` (the spec keeps "provider trouble never fails an Intent"); Kogen still prints `failed …` there, which is task 11.
- **Shaping cap bypass through the login path:** not present in Kogen. Shaping uses the default `Resilience.Policy` (4 attempts, not 8); `login` is never retried by `Retry.next/4`; the one forced refresh after a 401 resends once inside the failing attempt and then stops. The spec now says so (§4.5).
- **Approve compares the hash after the checks:** confirmed (approval-03: `build/ready` exists after a mismatch). Task 19.
- **Landing rebases and re-gates, and parks only when that is impossible:** the spec (§3.9.2) and the cases (build-24/25/26, ladder-19) already say this; v1.1 adds the explicit rule and the pointer to landing.qnt. Kogen parks at once with `:base_moved` and exit 70: task 04.

## Open for Almir
None. Every point was settled by his recorded word, a measurement, or the spec's rule that the reference supplies exact strings (see the readings table in the README). Three design differences have no word and no measurement either way; they are measurable, so they go to measurement, not to Almir: a `hard` rating running Luna and Sol in parallel (Kogen) instead of entering at R2 (spec); later rungs receiving the plan; and the build auditor running inside a rung instead of after it (ladder-02/03; listed under the spec's open questions).

## Triage by cause
Classes: **(a)** Kogen bug: the behaviour contradicts the spec and Almir's settled rules, or is a plain defect. **(b)** spec wrong or stale: Kogen follows a newer decision. **(c)** test wrong. **(d)** unbuilt, or a spec format Kogen has not adopted. Each (a) and (d) cause has a self-build task in `/tmp/claude-501/conf-tasks/` (one behaviour each, ordered by impact on Build success).

### (a) Kogen bugs

| Task | Cause | Failing cases (primary or contributing) |
|---|---|---|
| 01-shaping-pass-ends-on-done | shaping pass ends on the first successful write (generated_file_missing; measured 207 failures) instead of on a reply without tool calls, with no finish guard | exunit-05, provider-24, provider-26, shape-07, shape-08, shape-09, shape-10, shape-14, shape-15, shape-16, shape-17, shape-23, shape-24 |
| 02-gate-base-red-identities | gate: a base-red check with a NEW finding identity is excused and the Build lands; a check unavailable on base too is not excused | build-14, build-16, build-19 |
| 03-gate-feeds-back-every-check | gate: a check that times out or disappears ends the rung instead of being fed back red; a tree-mutating check is not detected (its file lands); a fix exiting non-zero is no finding | build-11, build-12, build-13, build-20, ladder-26 |
| 04-landing-rebase-regate | moved base at landing parks at once (':base_moved', exit 70) with no rebase, re-gate and repair | build-25, build-26, ladder-19 |
| 05-landing-transient-retries | a landing .lock is retried once instead of 1/2/4 s; no warning for a dirty checked-out base | build-27, build-29 |
| 06-progress-count | repair progress is not counted for GNU-line findings (failure_count null), so the rung ends no_progress after 2 repairs | build-05 |
| 08-style-never-blocks | style lint rules block approval (exit 1) instead of being card warnings; lint lines print 'at line :' | format-02, format-03, format-04, state-05, state-06 |
| 10-no-content-in-argv | the shell tool passes the model's command in argv (307,284-byte element) | custody-08 |
| 11-stopped-keeps-intent-queued | stops that should leave the Intent queued (setup failing twice, acceptance runner missing on base, claim held, tampered approval, login, provider exhaustion) end as failed or a bare error line; no skipped line on branch mismatch | build-39, build-40, build-41, build-42, cli-30, exunit-02, ladder-36, provider-10, provider-19, state-10 |
| 12-usage-limit-retry-after | usage limits pause for a fixed 5 min (scaled) and ignore retry-after; journal says paused, not provider_wait | ladder-35, provider-11, provider-18 |
| 19-approve-hash-first | intent approve <hash> runs setup and checks before comparing the hash | approval-03 |
| 20-approval-hash-binds-test | approval hash and Kogen-Approved-Hash trailer cover intent.md only, not intent.md + NUL + test | approval-02, state-09 |
| 21-baseline-statuses | approval baseline records a missing tool as red and refuses a timing-out or tree-mutating check instead of recording unavailable/timeout/mutating | approval-09, build-18, custody-01, custody-02 |
| 22-error-lines | mapped error lines: errors print as Elixir terms or exit 70 (config, parse, not_found, acceptance_missing, path conflict, request_unavailable, trailer mismatch, lost CAS, setup wording) | approval-13, approval-19, cli-09, format-05, format-09, shape-05, state-01, state-02, state-04 |
| 23-usage-errors-first | usage errors: boolean flags with =value say 'needs a value'; slug checked only after the project loads | cli-09, cli-13, cli-21 |
| 27-login-port-reuse | provider login fails with eaddrinuse when port 1455 is in TIME_WAIT from a previous login | format-11, provider-10, provider-21, provider-22 |
| 28-concurrent-shapes | two intent shape runs at once in one checkout collide on the staged test directory (environment/acceptance_cleanup_failed eexist) | provider-22 |
| 29-request-bytes-verbatim | shaping rewrites the Request bytes (CRLF to LF, non-UTF-8 re-encoded) | shape-03, shape-04 |
| 30-approval-card | approval card: no Feasibility line, '(test_keep)', blank-line layout, base-red rows not parsed, acceptance-check output not indented | approval-01, approval-08, approval-10, format-08 |
| 31-config-validation | project.yaml validation: env KOGEN_* and duplicate check names accepted, scalar domain crashes, >1 MiB accepted | format-05, state-16 |
| 32-slug-reuse | a reused slug stays landed forever (landed = any reachable trailer) | state-23 |
| 33-approval-cas-retry | two concurrent approvals: the lost CAS is not retried (controller/:exists) | state-29 |
| 34-sigint | SIGINT during queue start records no interrupted{reason: sigint} | cli-29, custody-05 |
| 36-formatter-warning | a missing shaping formatter gives no stderr warning | shape-18 |
| 37-toolless-requests | tool-less roles (planner, auditor) send "tools": [] instead of omitting the key | build-02, ladder-02, provider-01 |
| 38-usage-clamp | usage with cached_tokens > input_tokens is rejected as malformed instead of clamped | provider-20 |
| 39-exunit-ledger-names | ExUnit ledger rows keep the 'test ' prefix | exunit-01 |

### (d) Unbuilt features and spec formats not adopted

| Task | Cause | Failing cases (primary or contributing) |
|---|---|---|
| 00-test-seams | command adapter: acceptance.run program is not a gate file / not in the first-message gate paths | approval-15, shape-06 |
| 07-shaping-fallback-conversation | shaping fallback conversation (passes 4-6, fallback_shaper, fresh) | shape-12, shape-13 |
| 08-style-never-blocks | style findings repaired outside the pass budget during shaping, leftovers as lint_* warnings | shape-11 |
| 09-no-change-item | no_change_item lint rule (resolved call 2: no Intent without a change item) | approval-21 |
| 13-requirement-ledger | requirement ledger and coverage check at shaping | exunit-05, shape-01, shape-09, shape-14, shape-19, shape-23, shape-24 |
| 14-shaping-test-audit | shaping test audit with citations | shape-01, shape-09, shape-14, shape-20, shape-21 |
| 15-build-auditor-citations | build auditor per §3.8.2: after the rung (B6), citations, infeasible, audit event, '(advisory: …)' drain line | build-04, build-08, ladder-02, ladder-05, ladder-08, ladder-11, ladder-28, ladder-29 |
| 16-best-candidate | selection and best candidate: refs/kogen/candidates/<run>/<rung>, selection event, 'best candidate <verdict> at refs/kogen/parked/…' line | ladder-13, ladder-14, ladder-16, ladder-23, ladder-31 |
| 17-builder-messages | builder messages and feedback (§3.6/§3.7.3): Acceptance on the base, Repairs available, plan rules, Earlier attempts, acceptance/gate lines | build-02, build-04, build-12, build-13, exunit-03, format-10, ladder-27, ladder-29, ladder-30 |
| 18-empty-done-refusal | empty-done refusal (first empty done claim) not built | build-08 |
| 19-approve-hash-first | approval-baseline cache (approval-cache/<hex>.json) | state-28 |
| 20-approval-hash-binds-test | approval.json schema 2 (approval_sha256, witness, baseline exit_status/path/rule/symbol) | exunit-04, state-09 |
| 24-journal-and-run-json | run dir and journal in the §2.8 shape (schema 2 run.json, ts, plan/rung_started/verification/rung_finished/finished last, R1..R3 names); status/remove cannot read §2.8 run dirs (controller/:invalid_run) | approval-23, build-03, build-04, build-09, build-15, build-17, build-22, build-23, build-24, build-37, cli-25, cli-26, cli-28, exunit-01, exunit-03, ladder-01, ladder-02, ladder-12, ladder-20, ladder-21, ladder-22, ladder-26, ladder-27, ladder-35, provider-08, provider-13, state-11, state-17, state-19, state-20, state-21, state-30 |
| 24-journal-and-run-json | workspace layout <state root>/<run_id>-<rung> (shell.pid not found) | custody-04 |
| 25-build-report | Build report §2.10 (verdict, land_policy, advisory_items, rungs R1.., best_candidate, audit, sandbox, budget) | custody-07, ladder-24, state-12 |
| 26-build-config-keys | project.yaml build keys: ladder.max_rungs, land, budget_ms, fallback, roles rung2/rung3/fallback_shaper, shaping.proof (Kogen has recipe/wall_minutes) | build-06, build-07, build-10, build-31, build-44, ladder-04, ladder-06, ladder-07, ladder-09, ladder-10, ladder-15, ladder-17, ladder-18, ladder-25, ladder-34, provider-03, shape-26, state-03, state-26 |
| 30-approval-card | shape-warnings.json in the §2.4.5 shape is rejected | approval-17, state-25 |
| 35-shape-output-and-concerns | shape output: Feasibility line, usage role, Concerns warnings, 'shaper pass=<n> role=<role>' progress lines | format-07, shape-01, shape-02, shape-10, shape-22 |
| — | witness mode (pending measurement; not a default) | ladder-32, ladder-33, shape-26 |
| — | design differs, no decision or measurement either way (Kogen: hard runs Luna+Sol in parallel and later rungs get the plan; spec: hard enters R2, later rungs get no plan) - measure, no task | ladder-02, ladder-03 |

### (b) Spec wrong or stale (fixed in v1.1)

| Task | Cause | Failing cases (primary or contributing) |
|---|---|---|
| — | resilience: Kogen (T66) switches after 2 consecutive overloads (overloads only), caps a request at 4 attempts and jitters backoff (half to full ceiling); spec now follows the code | ladder-22, ladder-36, provider-08, provider-09, provider-12, provider-13, provider-14, provider-15, provider-16, provider-17 |
| — | shaper default: Almir 5 Oct 'Sol (never Luna) shapes' (build/LOG.md; T69); spec said shaper = builder | shape-23 |

### (c) Test wrong (fixed in v1.1)

| Task | Cause | Failing cases (primary or contributing) |
|---|---|---|
| — | host.json uuid matched lowercase only; the spec does not pin case (RFC 9562: case-insensitive) | provider-21 |

Not tasks: **d14** witness mode (pending measurement, not a default) and **dM** (measure first, see "Open for Almir"). **b02** is already queued for Kogen as T69 (`/tmp/claude-501/s13-task.txt`), so it has no new task file.

### Kogen bugs by area (27 causes)
| Area | Causes | Tasks |
|---|---:|---|
| Shaping | 4 | 01, 28, 29, 36 |
| Gate and repairs | 5 | 02, 03, 06, 37, 39 |
| Landing | 2 | 04, 05 |
| Drain stops and signals | 2 | 11, 34 |
| Provider and login | 3 | 12, 27, 38 |
| Approval | 6 | 08, 19, 20, 21, 30, 33 |
| CLI errors and usage | 2 | 22, 23 |
| State and config | 2 | 31, 32 |
| Custody | 1 | 10 |

Unbuilt or not adopted: 19 causes (journal and run.json, report, approval.json v2, config keys, shape-warnings, no_change_item, baseline cache, command-adapter gate files, fallback shaper, style repairs, ledger, shaping audit, shape output/Concerns, builder messages, build auditor with citations, best candidate, empty-done refusal, witness, workspace layout).

## Task files (`/tmp/claude-501/conf-tasks/`, ordered by impact on Build success)
| # | Task | Why this rank |
|---|---|---|
| 00 | test-seams | Nothing else can be verified offline without it; includes the Keychain-free login seam |
| 01 | shaping-pass-ends-on-done | 207 measured generated_file_missing failures; r71: Kogen's gap to Codex is in shaping |
| 02 | gate-base-red-identities | A Build can land a new lint error or failing test today ("nothing unverified lands") |
| 03 | gate-feeds-back-every-check | Timeouts/vanished tools end rungs; a tree-mutating check lands its file |
| 04 | landing-rebase-regate | Any concurrent landing parks a good candidate and stops the drain (exit 70) |
| 05 | landing-transient-retries | A stray .lock fails the Build |
| 06 | progress-count | Non-ExUnit stacks get only 2 repairs |
| 07 | shaping-fallback-conversation | Shaping gives up after 3 passes |
| 08 | style-never-blocks | Style findings block approval and spend shaping repairs |
| 09 | no-change-item | An Intent with nothing to change can land |
| 10 | no-content-in-argv | 300 KiB commands break on Linux (Almir's rule) |
| 11 | stopped-keeps-intent-queued | Environment/provider trouble fails Intents that need re-approval |
| 12 | usage-limit-retry-after | Fixed 5-min pause ignores the reset time |
| 13 | requirement-ledger | Request constraints silently dropped from tests |
| 14 | shaping-test-audit | Over-strict tests reach the Build |
| 15 | build-auditor-citations | Demotions without evidence; advisory landings invisible |
| 16 | best-candidate | Failed Builds lose earlier rungs' work |
| 17 | builder-messages | Builder lacks base acceptance output and repair budget; Elixir terms in feedback |
| 18 | empty-done-refusal | Wasted repair on an empty claim |
| 19 | approve-hash-first | Wrong hash runs every check before refusing |
| 20 | approval-hash-binds-test | The test can change after approval |
| 21 | baseline-statuses | A slow or writing base check blocks approval |
| 22 | error-lines | Elixir terms and exit 70 for ordinary errors |
| 23 | usage-errors-first | Usage mistakes become exit 70 |
| 24 | journal-and-run-json | status/remove cannot read documented run dirs; most ladder cases fail on journal names |
| 25 | build-report | Report misses verdict, rungs, audit, budget |
| 26 | build-config-keys | Documented build keys rejected |
| 27 | login-port-reuse | Second login within ~30 s fails (eaddrinuse) |
| 28 | concurrent-shapes | Two shapes in one checkout collide |
| 29 | request-bytes-verbatim | Request bytes rewritten |
| 30 | approval-card | Card layout, Feasibility line, base-red rows, shape warnings crash |
| 31 | config-validation | KOGEN_* env, duplicates accepted; scalar domain crashes |
| 32 | slug-reuse | Reused slug never builds |
| 33 | approval-cas-retry | Concurrent approvals give exit 70 |
| 34 | sigint | Ctrl-C leaves no journal trace |
| 35 | shape-output-and-concerns | Shape output and progress format; concerns dropped |
| 36 | formatter-warning | Silent skip when the formatter is missing |
| 37 | toolless-requests | "tools": [] sent for tool-less roles |
| 38 | usage-clamp | Odd usage numbers fail a stage |
| 39 | exunit-ledger-names | "test " prefix in ledger names |

## Spec and suite changes (v1.1)
- **Spec** (`careful-rebuild/research/kogen-core-spec/`, every change marked "v1.1"; the pre-change copy is in the session scratch): 01-cli (credential seam in §1.1, help `--help`, path forms, remove lines, B0 suffix, drain article/counts/skipped-only, status rows), 02-formats (verify kinds, parse-error lines, CheckSpec index, shaper default and fallback, symbol parsing, acceptance_paths, YAML wording, `chatgpt: {}`, rung_started.wall_ms, model_stage per request, provider events, report budget), 03-build (first-message layout, fallback marker, formatter warning, ledger reply, recounts, uncited verdicts, witness reply, turn note at 49, integration repairs and landing.qnt), 04-provider (credential seam, loopback reuse, §4.5 resilience per T66, marker settlements), CONFORMANCE (harness env, C.5 case titles), README (v1.1 note, measurement items), APPENDIX (pointer to this triage), `data/constants.json` (provider block).
- **Suite** (`conformance-v1.1`): runner sets `KOGEN_CREDENTIAL_STORE=file`; 33 case files changed (resilience, shaper default, uuid case, settled readings); `data/constants.json` copied from the spec; README readings section replaced by the settlement table; reference results and classifications for 80a4dd97; `proposals/reference-seams-on-80a4dd97.diff`.
