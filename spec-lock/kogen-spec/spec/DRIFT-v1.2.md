# DRIFT v1.2

Historical Elixir comparison. The rewrite follows [CLI-RULE.txt](../CLI-RULE.txt) and the guaranteed contracts in [quint/CLASSIFICATION.md](../quint/CLASSIFICATION.md). The approval hash row below is superseded for the rewrite: it includes the test bytes (§2.1.3). The Elixir reference will not be changed.

Read this when the tree and the spec disagree. A behaviour that a test or a benchmark locks is what the spec says. Everything else keeps the spec, and the tree is the bug.

The tree for this list is careful-rebuild `a8c98c68`, plus the unmerged work named in the v1.2 task: T98 prompt cache, T93 request shape, T94 `finish`, T92 long streams, T96 Rails bench patches, T99 Grok. Those worktrees are not on `a8c98c68`. A case that needs one of them fails on that commit until it is merged. That is an implementation gap, not a reason to drop the case.

## Adopted, because tests or the named work lock it

| Topic | v1.1 said | v1.2 says | Why |
|---|---|---|---|
| Hard entry | Start at R2 | The first two rungs run together | `ladder_cycle_test` |
| Later rungs | R2 gets the plan only on entry; R3 gets none | Rungs 1–3 receive the plan. `raw-request` does not | same test |
| Rungs | Three rungs. R4 is off | Four rungs, then repeats from index 2 until the wall | same test |
| Repairs | Start at 2, grant up to 6 | 6 repairs. A count that does not fall is `no_progress` | same test |
| Walls | 20 / 12 / 12 min, plus 60 min | One 60 min wall. A stage is capped at 30 min | escalation test locks `1_800_000` |
| Request clocks | 120 s idle, 600 s total, a second stage retry | 120 s to the first byte, 90 s stall, 20 min total. No stage-retry layer | resilience policy the exchange tests start from; T92 |
| Login and usage limit | Login stops. Usage limit waits 15 min, up to 6 h | One refresh inside the call, then the ladder pauses 5 min at a time, up to 24 h, and reruns the stage | ladder test "pauses the Build and reruns the stage" |
| Shell | `sh <file>`, command not in argv | `sh -c <cmd>` | tooling test receives `["sh", "-c", "true"]` |
| Approval hash | Intent bytes, a NUL, and the test bytes | SHA-256 of `intent.md` only | approval tests and the card |
| Auditor | After the rung. Citation required. `infeasible` | Inside the rung. `valid`, `over_strict`, `contradicts`. No citation. Diff clip 60,000 | ladder audit tests |
| Landed line | Appends ` (advisory: …)` | `landed <slug> <sha8> (Build <id8>)` | drain test |
| Landed status | Trailer and current `intent.md` must match | Trailer `Kogen-Intent: <slug>` is enough | status test |
| Queue | Approval time, then slug | Descending priority, then approval time, then slug. Unmet `blocks_on` is `Blocked:` | status and scheduling tests |
| Status JSON | Four fields | Also `priority` and `blocks_on`. Slug text has no `verdict:` line | status JSON test and the status formatter the tests render |
| Rails | Not an adapter | `Gemfile` and `config/application.rb` select Rails | rails ledger tests |
| Flakes | Out of core | One same-seed retry. Up to two base-red tests can be excused | flake policy tests |
| Recipes | Only `ladder` | The names in §3.1 load. Omitted config is `ladder` | ladder default and recipe tests |
| Gate environment | No environment outcome | On the ladder, `check_unavailable` is a repair. On `plan-shell` it fails the stage | ladder cycle test |
| Completion | A text done claim | `finish` alone with `{}` | T94 builder policy and harness test |
| Prompt cache | `kogen:responses:v1` of run dir and stage | §4.9 v2 key, byte-stable prefix, tool budget, continuation | T98, T93, T92, and the 2026-10-06 token postmortem |
| Grok | Out of core | §4.10 on the existing login, logout, and use verbs | T99. CLI-RULE.txt names only `chatgpt`. The verbs and flags are unchanged. The provider argument grew because this task requires Grok |
| User-Agent | `kogen/<version>` on every ChatGPT call | Owned ChatGPT sends `kogen/0.1`. Injected ChatGPT and Grok send `kogen/<version>` | owned header is the literal the ChatGPT client sends |

## Spec wins. The tree is wrong until these match

No test locks the opposite behaviour. A rewrite follows the spec.

| What the spec says | What the tree does |
|---|---|
| `intent approve <hash>` computes the hash first. A mismatch runs nothing else (§1.7.2) | The approval preview, including checks, runs before the hash is compared |
| Unreadable or empty input is `intent/request_unavailable: …` (§1.5) | The line is `task input unavailable <stdin\|path>: …` |
| A bad slug is `intent/invalid_slug`, exit 2 (§1.5) | Some paths leave the slug as an unmapped error and exit 70 |
| A missing `mise` is not an error (§1.5) | An `environment/mise_missing` line exists |
| Every journal event has `ts` (§2.8) | Callers omit `ts` |
| The setup key is the canonical JSON in §2.9 | The key is a language runtime term. Same inputs should hit; the bytes will not match another language. Use the JSON |
| Test seams `KOGEN_PROVIDER_URL`, `KOGEN_AUTH_URL`, `KOGEN_TIME_SCALE`, `KOGEN_CREDENTIAL_STORE=file`, `KOGEN_SANDBOX=unavailable` exist (§4.1, §5.3) | Endpoints are fixed. The auth seam that exists is `KOGEN_AUTH_PATH` |
| Witness mode (§3.2.7) can be selected and can refuse approval | No witness path. `shaping.proof` is not a project key |
| Shaping passes 4–6, the requirement ledger, the shaping test audit, and `Concerns:` (§3.2) | One conversation and two counted repairs. Passes 1–3 match. The rest is missing |
| Shaper progress is `shaper pass=<n> role=<role> <event>` (§3.2.6) | The line is `shaper attempt=<n> <message>` |
| A host that cannot confine warns and records `sandbox_unavailable` (§5.3) | Other than macOS, commands run unconfined with no warning |
| `build.land: green` refuses a candidate whose only failures are demoted tests (§3.8.1) | `land` is not a project key. Demoted failures can land, which matches the default. The opt-out is missing |
| Building elapsed time comes from `started_at` (§1.7.5) | A building row uses the `run.json` modification time |
| Check feedback to the builder is the clipped form in §3.7.3 | An acceptance-check failure also appends up to 2048 raw bytes on some CLI paths |
| Boolean flags take no value (§1.3) | `--json=true` and `--json=false` are accepted. `--watch=1` is reported as `needs a value` |

## Not core

T96 skips empty and already-applied Rails setup patches inside the bench harness. It does not change the `kogen` CLI or a Build. A rewrite does not implement it.

## Not claimed

The 2026-10-06 postmortem measured about a 26.5% weighted cache hit and named the missing per-conversation key. §4.9 is the rule that key must follow. It is not evidence that a live run has reached the 0.95 release target. Wire tests do not prove a live hit.
