# Kogen core v1.3-draft: language-neutral specification

Written on 5 Oct 2026 and revised after [REVIEW-1](REVIEW-1.md) ([response](REVIEW-1-RESPONSE.md)). The owner-accepted 7 Oct review corrections are recorded in [CHANGES-v1.3.md](../CHANGES-v1.3.md); this is an unfrozen draft, not an executable conformance release. The core commitments and deferred designs are classified in [quint/CLASSIFICATION.md](../quint/CLASSIFICATION.md). [CLI-RULE.txt](../CLI-RULE.txt) controls the command tree and permits the provider names `chatgpt` and `grok` on the existing provider commands. §4.10 specifies the Grok provider. The frozen black-box suite is v1.1; [CONFORMANCE-v1.2-CASES.md](CONFORMANCE-v1.2-CASES.md) lists cases awaiting implementation in that suite. [DRIFT-v1.2.md](DRIFT-v1.2.md) is historical Elixir comparison material, not a rewrite requirement.

## Summary (10 lines)
1. One `kogen` CLI: the fixed tree in CLI-RULE.txt, plus the provider name `grok` on the existing login, logout, and use verbs. Byte-exact help is in `data/help/`. There is no `--help` flag. Exits are 0/1/2/3/4/5/70/130/143 ([01](01-cli.md)).
2. State lives in git and plain files. The approval hash covers exact Intent and acceptance test bytes separated by NUL. Builds are `run.json` plus `events.jsonl` under `~/.kogen/workspaces/<key>/` ([02](02-formats.md)).
3. Acceptance tests report through a JSON Lines ledger tagged `<slug>/A<n>`. Adapters are `exunit`, `rails`, and `command`. Findings are identified as `(path, tool/rule, symbol)` ([02 §2.4](02-formats.md)).
4. Shaping is where doubt lives. A pass ends only when the model is done. Style lint never consumes repairs. A requirement ledger, a coverage check, and a test audit are specified. Concerns are warnings. Assumptions and `blocks_on` are rechecked before a Build ([03 §3.2](03-build.md)).
5. The proof-carrying witness is the target shaping contract. It is not the default, and the current tree does not implement it ([03 §3.2.7](03-build.md), [DRIFT](DRIFT-v1.2.md)).
6. A started Build must finish. There is no re-plan and no return to shaping. Its levers are repair, a fresh attempt, the next rung, provider retry, and best candidate. Login and usage limits pause the Build ([03 §3.4](03-build.md), [04 §4.5](04-provider.md)).
7. The default recipe is `ladder`: Luna, Sol medium, and Sol high, each with the plan, then an experimental request-only rung. `hard` runs the first two together. Repeats continue until a 60-minute wall. The builder finishes by calling `finish` with `{}` ([03 §3.1](03-build.md)).
8. Landing: green trees satisfying all approved acceptance items land. The default auditor is observational and cannot change acceptance, rank or eligibility; automated demotion is opt-in experimental and disabled pending frozen calibration. Recovery preserves crashed work before cleanup ([03 §3.8](03-build.md)).
9. Providers are ChatGPT and Grok. Adapter-selected cache affinity is persisted, while thread identity is distinct per invocation/stage/attempt/rung/epoch. The static prefix is stable across Shapes and Builds; the ≥95% cache gate uses a frozen feasible replay ([04](04-provider.md)).
10. Custody and the sandbox are specified as behaviour. A host that cannot confine builds unconfined with a warning ([05](05-sandbox-custody.md)). The frozen suite is still conformance-v1.1. New cases are listed and not yet in that suite ([CONFORMANCE-v1.2-CASES](CONFORMANCE-v1.2-CASES.md)).

## Files
| File | Contents | Pages |
|---|---|---:|
| [01-cli.md](01-cli.md) | Process model, grammar, exit codes and error lines, every command's output | 5 |
| [02-formats.md](02-formats.md) | Intent, lint, project.yaml, acceptance and findings, approval and refs, YAML, `~/.kogen`, journal, cache, report, status | 5 |
| [03-build.md](03-build.md) | Rules, ladder, shaping (and witness), approval checks, orchestration, rung machine, verification, verdicts, auditor, selector, landing, recovery, drain | 7.5 |
| [04-provider.md](04-provider.md) | Port, wire, SSE, retries, logins, tools, fake provider, prompt caching, Grok | 6 |
| [05-sandbox-custody.md](05-sandbox-custody.md) | Custody, environment, sandbox, workspaces | 2 |
| [06-non-goals.md](06-non-goals.md) | Out of core v1, implementer freedom, never | 1 |
| [CONFORMANCE.md](CONFORMANCE.md) | Definition, freeze rule, harness, 244 cases, comparison | 6 |
| [DRIFT-v1.2.md](DRIFT-v1.2.md) | Where the tree and v1.2 disagree, and which side won | 2 |
| [CONFORMANCE-v1.2-CASES.md](CONFORMANCE-v1.2-CASES.md) | Fake-provider cases not yet in the frozen suite | 3 |
| [COVERAGE.md](COVERAGE.md) | Every `lib/` module at careful-rebuild `a8c98c68`, mapped to a section | 4 |
| [APPENDIX-REFERENCE.md](APPENDIX-REFERENCE.md) | What the Elixir reference must change | 1.5 |
| [data/](data/) | `help/*.txt` (16 pages), `lint.json`, `yaml-errors.json`, `moved.json`, `constants.json` | data |

## Conventions
- **MUST/SHOULD/MAY** follow RFC 2119.
- Text quoted as exact is byte-exact.
- §n.m points into this spec.
- `decisions <key>` points to `decisions/CURRENT.md`.
- Files in `data/` are normative and shared with the conformance suite.

## Sources and precedence
1. Almir's words decide product and CLI questions:
   - features/24-cli.md;
   - the 5 Oct Build rules (a started Build finishes; levers only; feasibility belongs in shaping);
   - the four resolved calls, with the 7 Oct review superseding advisory landing by default with observational auditing; no Intent without tests; concerns are warnings; build unconfined with a warning.
2. Measurements decide success rate, speed and cost:
   - plan-shell and the shell-only builder;
   - Luna max as builder;
   - no review or context stages;
   - best-of-N with a smallest-diff selector loses;
   - text output.
3. research/beat-codex supplies the target Build: never-empty output, base-relative gates, progress repairs, the ladder, auditor and selector, and provider resilience. research/shaping-guarantee supplies the target shaping contract (the witness), pending measurement.
4. The reference implementation supplies exact strings and constants where the sources above are silent.

## Open questions
The owner accepted the corrections in [CHANGES-v1.3.md](../CHANGES-v1.3.md) on 7 Oct; observational auditing explicitly supersedes the 5 Oct demotion default. v1.2 closes three v1.1 holds because the ladder tests lock them: `hard` runs the first two rungs in parallel, later rungs receive the plan, and the auditor runs inside the rung.

Pending measurements:
- the witness path (shaping-guarantee §5);
- whether the experimental `raw-request` rung should stay in the default ladder;
- the planner's `hard` rating accuracy;
- exact-policy frozen auditor calibration (≥ 0.9 precision, ≤ 5 % false demotion) and prospective confirmation; L6 rejects admission of its tested policies, and does not qualify the current test-demotion policy;
- a live cache-hit smoke. The wire rules are normative. A scripted test does not prove the frozen feasible replay meets 0.95 (§4.9.5).

Choices where the tree and this spec disagree are in [DRIFT-v1.2.md](DRIFT-v1.2.md).
