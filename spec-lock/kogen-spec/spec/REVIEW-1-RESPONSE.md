# Response to REVIEW-1 (5 Oct 2026)

Every fix was applied, along with the coordinator's additions: a single `ladder` recipe, `hard` starting at R2, and the shaping-guarantee witness folded in as the pending-measurement shaping contract. The CLI is unchanged.

**Size.** 46 pages became about 31 normative pages (README, 01–06 and CONFORMANCE: ≈ 15,600 words), plus 5 data files. Separately there are 1.5 pages in the reference appendix and 2.5 pages for this response.

## Prioritised fixes
| # | Fix | Change |
|---|---|---|
| 1 | Apply the four calls | §3.0 lists them. (1) `build.land` defaults to `green-or-advisory`; the drain line ends with `(advisory: …)`; the verdict and advisory items go into `finished` and the report. (2) New `no_change_item` lint error; shaping still needs a fully red change item. (3) `feasibility_concern` warnings (§3.2.6). (4) A host that cannot confine builds unconfined: stderr warning, `sandbox_unavailable` event, report field, and the `KOGEN_SANDBOX=unavailable` seam (§5.3). The open questions in the README are closed. Cases ladder-5/6 and custody-7. |
| 2 | Separate steering from the verdict | The rung `acceptance` modes are gone. Every rung counts and feeds back every failing item. Only an auditor demotion with a valid citation changes the verdict. A landable verdict needs ≥ 1 undemoted change item passing. `infeasible` demotes like `over_strict`, but needs an output citation. After an audit the rung is re-scored, and any landable verdict stops the ladder (§3.8, B6–B7). |
| 3 | Narrow the environment class | The exit-level heuristics are deleted. Each check is `unavailable` (126/127, not found, no exit status, adapter signal), `timeout`, `mutating`, `red` or `green`. The gate has no environment outcome: each of these is fed back as red unless excused (§3.7.2). |
| 4 | Base-relative checks keep the Build in its lane instead of walling it in | A check is excused when it has the same status as on the base and either its identities are a subset of the base's, or (with no identities) it has the same exit status. Unavailable, timeout and mutating checks are excused when the base shared that status; the writes of an excused mutating check are reverted. A moved base merges a start baseline into the approval baseline. Identity = `(path, tool/rule, symbol)` (§2.4.4). Cases build-14 to build-19. |
| 5 | Robust shaping | (a) A pass ends on a response without tool calls, with a finish guard. (b) Passes 1–3 use the shaper; passes 4–6 run a fresh `fallback_shaper` (Sol high) conversation. (c) Style lint is repaired outside the cap, and leftovers become warnings at both shape and approve. (d) A requirement ledger, a coverage check and a shaping test audit are now core (§3.2.3). |
| 6 | One orchestration table | §3.4 B0–B10 with the required event order. Also defined: `failed`, `parked` and `stopped` (§3.0); `finished.rung`; R4 is experimental; landing repairs use a separate 10-minute allowance; `output_tokens` is removed; an Intent-only landing when all items are already green. |
| 7 | Provider outages never fail an Intent | A usage limit waits for `retry-after` (or 15 minutes) with the budget paused, up to 6 hours. Outages longer than 30 minutes and login failures give `stopped`: the Intent stays queued and the drain stops with exit 4 (§4.5, §2.11). |
| 8 | Contradictions | Roles `rung2`/`rung3`/`auditor`/`fallback_shaper` and `build.fallback` are now in the §2.3 schema. `login` is a provider class everywhere. CLI case 6 now uses `missing <provider>`. `bad_slug` is removed from lint (the CLI rejects the slug first). The format profile counts 65 banned words and phrases. `(--all)` is removed. §1.1 lists every seam. |
| 9 | A real, discriminating suite | C.2 adds the freeze rule. There are 244 cases with a separate `format` profile. Timing cases assert unscaled `delay_ms` and `wait_ms`. A determinism case was added. Every missing case from review §(b) was added. The ladder profile went from 18 to 36 cases. The two-user and Keychain-opaque assertions were removed, along with the internal custody cases. |
| 10 | Simplify | One recipe, `ladder`, with `max_rungs` (1 = plan-shell). The builder is shell-only, so `edit`/`write`/`diagnose` were dropped from it. The judge was removed. R4 is experimental behind `experimental_r4`. |
| 11 | `hard` starts at R2 | The planner's `Difficulty:` line decides the entry rung (§3.1). Cases ladder-3 and ladder-4. |
| 12 | Don't anchor later rungs on R1's plan | The plan is made once and given only to the first rung that runs. R2 and R3 after a failure get no plan, which also respects "no re-plan". |
| 13 | Never discard a diff | When the budget runs out, the current tree is verified and selected. An `unverified` best candidate is still emitted. Legitimate stops are now the `stopped` cases only. |
| 14 | Retry transient landing failures | A `.lock` or lost CAS is retried at 1, 2 and 4 seconds, then rebased and re-verified, then parked (§3.9.3). |
| 15 | Redundant approval work | The hash is compared before any check runs, and the baseline is cached (§3.3, §2.9). |
| 16 | YAML | Exact wording moved to data with a precedence order. Conformance asserts the line and the class (§2.6). |
| 17 | Hash covers the test | The approval hash is `intent ‖ NUL ‖ test` (§2.1.3). |
| 18 | Slug reuse | Landed now also requires the landed tree's `intent.md` to equal the current one (§2.11). Case state-23. |
| 19 | Tree hash from the build base | §5.4. |
| 20 | Setup cache key | Keyed on the constructed child env, without `TMPDIR` and the mise state variables (§2.9). |
| 21 | Approval CAS race | Re-read and retry once (§2.5.1). Case state-29. |
| 22 | Time-scale list | `scaled` flags in `data/constants.json`, listed in §4.1. Project timeouts are never scaled. |
| 23 | Fake `turn` and tool-less roles | §4.8.2 defines a fresh conversation and the turn; §4.2 says tool-less roles omit both `tools` and the `additional_tools` item. |
| 24 | `Concerns:` | Parsed from each pass's final response and deduplicated by exact text (§3.2.6). |

## Other review points
- **§(a) ambiguities.** Progress counting now covers every finding plus every failing item and is always comparable. The selector is deterministic (passing items, then findings, then diff size, then rung). `$TMPDIR`/`$HOME` are written literally. Fallback effort is defined in both directions. The legacy report keys were removed. `skipped` does not affect the exit code. Help text and the widening of exit 2 are recorded as UX calls (§1.5).
- **§(c) first principles.**
  - Test strength: the shaping ledger, coverage check and audit are now core.
  - The auditor needs citations.
  - The builder's first message includes each item's acceptance output on the base.
  - Starting from R1's best tree (a warm start) is left to a measurement.
- **§(d) "safety is not a goal".** Only the rule that matters for success is a MUST (the checkout and origin are never written during a Build; this is detected where confinement is missing). Credential and write confinement are SHOULD and outside the conformance gate. Custody and the no-argv rule stay MUST.
- **§(e) size.** The `[R]`/`[Δ]`/`[T]` tags were removed and the reference differences moved into APPENDIX-REFERENCE.md. The help pages, lint lists, YAML messages, moved forms and constants are now data files.

## Shaping guarantee
§3.2.7 sets the witness contract:
- `shaping.proof: witness` runs a witness Build at shaping time;
- a failing witness gets an adjudication;
- the card shows the feasibility verdict (`PROVEN`, `PROVEN with concerns` or `UNPROVEN`);
- approve refuses `UNPROVEN`;
- `approval.json` binds the witness;
- Build step B3 re-verifies the witness with no model calls;
- the Build never demotes tests in this mode.

This mode is the target, and stays off by default until the shaping-guarantee adopt rule passes. Cases shape-26, ladder-32 and ladder-33 cover it.
