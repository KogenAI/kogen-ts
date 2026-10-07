# 2. On-disk formats

JSON is UTF-8, compact on disk; key order is insignificant; readers ignore unknown keys; optional values are `null`; counts and milliseconds are integers; SHAs are lowercase hex of 40 or 64 characters (SHA-256 repositories MUST work). Times are epoch milliseconds (`*_ms`, `ts`) or RFC 3339 UTC (`at`).

## 2.1 Intent `.kogen/intents/<slug>/intent.md`
### 2.1.1 Slug
`^[a-z0-9]+(?:-[a-z0-9]+)*$`, 3–48 characters; the parent directory name.
### 2.1.2 Grammar
Split on `\n`; strip one trailing `\r` per line except inside `## Request`.
```
file        = "---" NL frontmatter "---" NL body              ; frontmatter ends at the next line equal to "---"
frontmatter = YAML map (§2.6): title (string, required), size (small|medium|large, required),
              domains (list of strings, required), changes_gate (true|false, default false),
              limits (list of strings, parsed and ignored),
              blocks_on (list of slugs, default []), priority (integer, default 0),
              assumptions, shared_contracts (lists of {name, path, contains}, default []),
              source (string, optional); any other key is an error
body        = brief { section }                               ; brief = lines before the first known heading, trimmed
section     = heading NL { line }                             ; each at most once, any order
heading     = line whose trim() is "## Acceptance" | "## Verify" | "## Notes" | "## Request"
acc_line    = trim() ~ /^-\s+A(\d+):\s*(.*)$/                 ; blank lines skipped
verify_line = trim() ~ /^-\s+A(\d+):\s*(.*)$/
verify_body = "test" ["keep"] { "integration" | "domain=" NAME | "after=" ID }
request     = all bytes after the "## Request" line, verbatim to EOF
```
- `test` = **change item** (red on the approved base, green after). `test keep` = **keep item** (green before and after). A first word `example` or `check` → `unsupported_verify_kind` (`<kind> is not supported in core v1`); any other first word → `invalid_verify` (settled v1.1, reference parser); the first unknown modifier is invalid; `integration` and `after=` are ignored; the last `domain=` wins.
- `### X` is not a heading; an unknown `## X` inside the Brief stays Brief text (lint error); after a known section it is a parse error.
- **Parse errors** (`{line, message}`): `frontmatter must start with \`---\`` · `frontmatter is missing its closing \`---\`` · `unknown frontmatter key "<k>"` · `frontmatter \`<k>\` must be a string` / `must be a list` / `must contain only strings` · `frontmatter is missing required key \`<k>\`` · `frontmatter \`changes_gate\` must be true or false` · `frontmatter must be a YAML map` · YAML errors (line + 1) · `unknown Intent section "<X>"` · `duplicate <Section> section` · `Acceptance entries use \`- A<n>: one sentence\` on one line` · `Verify entries use \`- A<n>: test\` or \`- A<n>: test keep\`` · `duplicate Verify entry for A<n>` · `Verify entry A<n> has no Acceptance item`.
- **Parse error lines** (settled v1.1, reference): a missing closing `---` is reported on the line after the file's last line; a missing required key and a frontmatter that is not a map on line 2, the first frontmatter line.
### 2.1.3 Hashes
- `intent_sha256` = SHA-256 of the exact `intent.md` bytes (Request included).
- **Approval hash** = SHA-256 of the exact `intent.md` bytes, one NUL byte, and the exact acceptance source bytes, in that order. The card shows this digest; `intent approve <slug> <hash>` matches its lowercase prefix. The same bytes are re-read before the approval ref CAS; if either file changes, the command refuses with `intent/hash_mismatch` and writes no ref. `intent_sha256` remains a separate field for diagnostics. This matches the frozen conformance hash formula.

## 2.2 Lint
Rules, messages, tiers, word lists and verbs are in [data/lint.json](data/lint.json). Each rule has a **severity**:
- `error` — structural (missing Brief, sizes, ids, Verify kinds, no change item, open questions, undeclared gate path). Blocks shaping (repairable) and approval.
- `style` — word, sentence and size caps, banned phrases, hedges, long code, `Approach:`, code references. Never blocks: shaping auto-repairs them outside the repair cap (§3.2.4) and approval shows leftovers as card warnings `lint_<rule>`.
Helpers: word = split on `\s+`; paragraph = split on `\n\s*\n`; sentence = split after `.`/`!`/`?` + whitespace. The Request section is never linted; Notes are exempt from phrase, hedge and sentence rules.

## 2.3 Project config `.kogen/project.yaml`
Committed in the project; strict YAML (§2.6); all issues reported together.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | |
| `checks` | [CheckSpec] | required | project verification, base-relative (§3.7) |
| `acceptance_checks` | [CheckSpec] | `[]` | run on the staged test at shaping and approval; `{path}` = candidate test path |
| `setup` | [CheckSpec] | `[]` | run in every fresh workspace |
| `setup_outputs` | [relative path] | `[]` | cached setup products (§2.9) and seeded dirs |
| `setup_inputs` | [relative path] | `[]` | files that replace the base tree in the setup key (§2.9) |
| `fix` | [CheckSpec] | `[]` | safe formatters, once per verification |
| `format` | argv | adapter default | shaping formatter |
| `protected_paths`, `gate_paths` | [glob] | `[]` | §2.5.2 |
| `domains` | {name: [path prefix]} | `{}` | scope warnings |
| `env` | {NAME: string} | `{}` | wins over toolchain env; `PATH` verbatim; `KOGEN_*` names rejected |
| `sandbox` | `true\|false` | `true` | §5.3 |
| `base` | branch | — | |
| `acceptance` | {adapter, timeout_ms, …} | `{adapter: exunit, timeout_ms: 600000}` | §2.4 |
| `shaping` | {proof} | `{proof: none}` | `witness` = pending-measurement path (§3.2.7) |
| `build` | see below | | |
| `account` | label | — | deprecated (§1.8) |

- **CheckSpec** = `{name, argv, timeout_ms}`, all required, nothing else; names unique per list; argv non-empty strings; timeout a positive integer. Messages: `project has unknown key "<k>"`, ``missing required key `<k>` ``, `<list>[<i>] has unknown key "<k>"`, `<list>[<i>].<field> must be …`, `<list> has duplicate name "<n>"`. `<i>` is 1-based, and schema issues carry no `line <n>:` prefix (settled v1.1, reference).
- `setup_outputs`: relative, no NUL/CR/LF, no `""`, `.`, `..`, `.git` segment, no duplicates or overlaps.
- **`build`** keys, and no others: `recipe` (default `ladder`, names in §3.1), `roles` (`builder`, `planner`, `shaper`, `auditor`, `reviewer`, `context`, each `{model, effort}`), `wall_minutes` (default 60), `edge_tests` (boolean, default false), `model_fallback` (boolean, default true), `context_bytes` (integer ≥ 16000, or omitted), `plan_max_words` (integer 300–2000, default 500), `tool_result_tokens` (integer 128–100000, default 2000), `model_generation_tokens` (integer 1–100000, or omitted), `luna_provider_mode` (`responses` or `lite`, default `responses`). Also still specified, and rejected by the current tree until it accepts them: `ladder.max_rungs`, `ladder.experimental_r4`, `land` (`green` default, or legacy `green-or-advisory` with identical eligibility while demotion is disabled), `auditor_demotion` (boolean, default false; true refused until admitted calibration, §3.8.2), `budget_ms`, `fallback`. Unknown keys and roles are errors (`build.roles has unknown role "<r>"`). `plan_max_words` outside 300–2000 fails project load with a message that contains `plan_max_words must be an integer from 300 to 2000`.
- **Defaults:** builder `gpt-6-luna/max`; shaper, planner, and auditor `gpt-6.1-sol/high`. A Grok selection uses `grok-4.6` at `high` for the builder and the shaper (§4.10). Model fallback is `gpt-6.1-sol/medium` for the builder, the context role, and the reviewer (§4.5). The planner has none.
  - v1.1: the shaper no longer defaults to the builder. Almir, 5 Oct 2026: "Sol (never Luna) shapes" (build/LOG.md; queued as T69). v1 had `shaper = builder` and `gpt-6.1-sol` → `gpt-6-luna/max`.
- **Shape fallback resolution:** `fallback_shaper` is an internal alias of the effective `shaper`, including its provider, model and effort; it is not an independent configurable role. Resolve project/machine overrides first. ChatGPT defaults yield Sol-high in both conversations; Grok defaults yield Grok-high in both. Reject a role model from a different selected provider at project load rather than crossing providers. The fixed Sol-high support profile is a benchmark/product default, not evidence of model diversity.
- **Precedence:** project, then `~/.kogen/config.yaml` (only a top-level `build:` key), then defaults; roles merge per role and field.

## 2.4 Acceptance tests and stack adapters
### 2.4.1 Contract
- Item `A<n>` is proven by ≥ 1 test tagged `<slug>/A<n>`. Source: `.kogen/acceptance/<slug><ext>` in the checkout. In a Build workspace the test is installed at `<candidate_dir>/<slug><ext>` and the source copy is deleted, so the landed tree holds one copy.
- A run writes a **ledger**: JSON Lines at env `KOGEN_LEDGER_REPORT`, one row per executed test, exactly `{"tag":s,"test":s,"status":"passed|failed|skipped|excluded|invalid"}`.
- Reading: missing, empty or malformed report with the runner unavailable (126/127/not found or adapter signal) → environment `tool_missing`; empty with non-zero exit → candidate `acceptance_compile_failed`; empty with exit 0 → candidate `no_tagged_tests`; malformed line → candidate `ledger_invalid`. The tree hash before and after MUST match (else `tree_mutated`). Timeout → candidate `acceptance_timeout`.
- **Item status:** `pass` iff it has ≥ 1 row and every row is `passed`. Unknown `<slug>/…` tags and a non-zero runner exit with all items passing add the failure `suite`.
### 2.4.2 Adapter interface
`source_path(slug)`, `candidate_path(slug)`, `run(workdir, slug, report_path, env, timeout_ms) → {exit_status|null, timed_out, log}`, optional `unavailable(log) → bool`, optional `formatter(project) → argv`, optional `finding_parsers`, optional `seed_dirs`, optional `reference_lint`.
### 2.4.3 Built-in adapters
- **`exunit`:** ext `_test.exs`, candidate dir `test/acceptance`; tag `@tag intent: "<slug>/A<n>"`; Kogen writes a ledger formatter into the run dir (never the workspace) and runs `[mise exec --] elixir -e 'Code.require_file("<run_dir>/ledger_formatter.ex")' -S mix test --formatter KogenLedgerFormatter --formatter ExUnit.CLIFormatter <candidate path>`; `test` = test name without `test `; unavailable when the first 20 log lines name a missing `erl`, `elixir` or `mix`; formatter = first check with `format` and `--check-formatted` minus that flag, else `mix format` (`.ex`/`.exs` only); seed dirs `deps`, `_build`; parsers for ExUnit failures, compiler errors, Credo, `mix format --check-formatted`.
- **`command`:** `{adapter: command, ext, candidate_dir, run: [argv]}`; `{path}` in `run` = candidate path; env `KOGEN_LEDGER_REPORT`, `KOGEN_INTENT_SLUG`; the command writes the ledger itself.
- **`rails`:** chosen when the checkout has both `Gemfile` and `config/application.rb`, unless `acceptance.adapter` names another adapter. Ext `_test.rb`. Source `.kogen/acceptance/<slug>_test.rb`. Candidate dir `test/acceptance`. Run `bundle exec rails test <candidate path>`. Acceptance check `ruby -c <path>`. Format is `bundle exec standardrb -a` when the Gemfile declares `standard`, else `bundle exec rubocop -a` when it declares `rubocop`. Setup seeds `vendor/cache` and runs `bundle install --local`. The child environment sets Bundler to that vendor path and `RAILS_ENV=test`. Findings include Minitest and Ruby lint lines. Gate paths add `Gemfile`, `Gemfile.lock`, `bin/rails`, `.standard.yml`, and `.rubocop.yml`.
### 2.4.4 Findings and identities
Every check's output is parsed for **GNU lines** `path:line[:col]: (error|warning|note): [tool/rule] [symbol: ]message` plus adapter parsers. A finding's **identity** = `(path, tool/rule, symbol)` (`symbol` = the test name for test failures, `""` otherwise); line, column and message are not part of it. Settled v1.1: the GNU `[symbol: ]` part is read only for test-failure findings; for every other tool the message is everything after `[tool/rule] `, so a base-red card row reads `- lint: [lint/todo] lib/greet.txt:2: greet.txt: TODO found`. Failing acceptance items have identity `(candidate path, acceptance, <slug>/A<n>)`.
### 2.4.5 Shape artefacts
- `.kogen/intents/<slug>/shape-warnings.json` = `{"approval_sha256":s,"warnings":[{"code","item_ids":[s],"message"}]}` (ignored when the hash differs). Codes: `shape_reclassified`, `feasibility_concern`, `lint_<rule>`, `audit_<verdict>`, `coverage_gap`.
- `.kogen/intents/<slug>/ledger.json` = `{"approval_sha256":s,"rows":[{"constraint":s,"maps_to":"A<n>"|"untestable: <reason>"}]}` (§3.2.3); stored in the approval commit, not landed.

## 2.5 Approval, protection and refs
### 2.5.1 Approval commit on `refs/kogen/intents/<slug>` (origin)
- Tree (mode 100644): `intent.md`, `approval.json`, `ledger.json` (when present) under `.kogen/intents/<slug>/`, and the test at `.kogen/acceptance/<slug><ext>`. Parent = previous approval commit or none. Written by CAS (create-only, or `update-ref new old`); a lost race re-reads and retries once.
- Message: `Kogen immutable approval package\n\nKogen-Approval: <slug>\nKogen-Approved-By: <by>\nKogen-Approved-Hash: <approval_sha256>\nKogen-Approved-At: <RFC 3339>`.
- `approval.json` = `{"schema":2,"slug","approval_sha256","intent_sha256","target_branch","base_sha","domains":[s],"acceptance_paths":[s],"protected_manifest":{path:sha256},"check_baseline":[Baseline],"witness":Witness|null,"by","at"}`. Trailers MUST equal the JSON; the hashes MUST match the committed bytes. `acceptance_paths` lists the source paths (`.kogen/acceptance/<slug><ext>`), settled v1.1 from the reference.
- **Baseline** = `{"name","status":"green|red|unavailable|timeout|mutating","exit_status":int|null,"findings":[{"path","rule","symbol","message"}]}`.
- **Witness** (witness mode) = `{"verdict":"PROVEN|PROVEN_WITH_CONCERNS","commit":s,"diff_sha256":s,"base_sha":s}`; the commit is kept at `refs/kogen/witness/<slug>`.
### 2.5.2 Protected manifest
`{path: sha256(bytes) | sha256("kogen:absent")}` from the **origin base commit**, plus own entries for `intent.md` and the candidate test path (approved bytes). Patterns: `protected_paths`; unless `changes_gate: true`, also the **gate files** = `.kogen/project.yaml` ∪ `gate_paths` ∪ program files of `checks`, `acceptance_checks`, `fix` and `acceptance.run` (`make` → `Makefile`, `GNUmakefile`, `makefile`; interpreters `sh bash zsh dash python python3 ruby node perl elixir escript` → their first non-`-` argument; else `argv[0]`; leading `./` stripped; existing or tracked files only). Globs: `**/`, `**`, `*`, `?`, `[..]`, `{a,b}`, dotfiles match, trailing `/` = subtree; a literal naming nothing must stay absent. **Stale checkout:** each non-own path's checkout bytes must equal the base bytes, else `environment/checkout_behind_base`.
### 2.5.3 Refs (origin)
| Ref | Rule |
|---|---|
| `refs/kogen/intents/<slug>` | create-only / CAS update / CAS delete |
| `refs/kogen/witness/<slug>` | witness mode: the witness commit of the current approval |
| `refs/kogen/claim` | one per origin; parentless commit, tree `.kogen/claim` = run id, message `Kogen project claim\n\nKogen-Run: <run_id>`; deleted only by its owner |
| `refs/kogen/incoming/<run_id>` | must not exist; pushed, then CAS-deleted after landing |
| `refs/kogen/candidates/<run_id>/<rung>` | every rung snapshot with a diff; recovery snapshots use `recovery-<workspace>` and are retained as unverified (§3.10) |
| `refs/kogen/parked/<run_id>` | the best candidate of a Build that did not land |
| `refs/heads/<base>` | CAS fast-forward at landing only |
### 2.5.4 Landing commit
One commit, sole parent the base tip, message `<Intent title>\n\nKogen-Intent: <slug>\n` (no other trailer, no AI attribution), user's own identity and signing, no hooks. Contains the candidate changes, `intent.md` and the candidate test (not the source copy).

## 2.6 Strict YAML subset
For project.yaml, config.yaml, accounts.yaml and frontmatter. Scalars are strings; block maps; block sequences indented deeper than their key; flow `[…]` and `{…}` (may span lines); `"…"` (escapes `\n \t \" \\ \/`) and `'…'` (`''`); `#` comments at line start or after a space. Rejected: > 1 MiB, BOM, invalid UTF-8, tabs, directives and document markers, anchors/aliases/tags/block scalars, depth > 64, merge keys, duplicate keys, keys or list items without value, plain values containing `: `, indentless sequences, bad indentation, `\u` and other escapes, quote errors, malformed flow collections, empty documents. Only the first error is reported (earliest line; within a line, the order of [data/yaml-errors.json](data/yaml-errors.json), which also holds the recommended messages). Conformance checks the line number and the error class, not the wording. Settled v1.1 (reference): a block scalar gives `anchors, aliases, tags, and block scalars are not allowed`; an anchor, alias or tag gives `anchors, aliases, and tags are not allowed`; `<v>` is the offending scalar as written and `<text>` the rest of the line from the error.

## 2.7 `~/.kogen`
```
config.yaml   accounts.yaml   profiles.json   host.json   credentials/ (0700)   locks/<name>.lock/owner
workspaces/<key>/            state root of one checkout
  runs/<run_id>/             §2.8
  <run_id>-<rung>/           rung workspaces (git clones)
  setup-cache/<hex>/   approval-cache/<hex>.json   queue.pid   queue.stop   queue.log
```
- `<key>` = basename of the canonical checkout path (symlinks resolved, ≤ 40) with `[^A-Za-z0-9._-]+` → `-`, then `-`, then the first 10 hex of SHA-256 of that path.
- `accounts.yaml` (written only by `provider use`, atomically, rows sorted by path, rows for missing dirs dropped; an empty map, written `chatgpt: {}`, is valid; a bare `chatgpt:` is a YAML error):
```yaml
# Kogen accounts on this machine, written by kogen provider use.
chatgpt:
  default: <label>
  projects:
    - path: "<canonical path>"
      account: <label>
grok:
  default: <label>
  projects:
    - path: "<canonical path>"
      account: <label>
selection:
  default: chatgpt
  projects:
    - path: "<canonical path>"
      provider: chatgpt
```
  Provider and account resolution are §4.10. A committed `account:` applies only when the selected provider is ChatGPT.
- `profiles.json` holds a map per provider. ChatGPT labels use `{"client_id","subject","email","expires_at","signed_in","plan_usage","notice_shown","remote_revoked"}`. Grok labels use `{"email","expires_at","signed_in"}`. `host.json` = `{"ext_agent_host_id":"urn:uuid:<v4>"}`.
- Shaping and approval scratch: `$TMPDIR/kogen-shaper/<slug>/<id>/`, `$TMPDIR/kogen-approval/<slug>/<id>/`.

## 2.8 Run dir and journal
- `runs/<run_id>/` (`run_id` = 32 hex from 16 random bytes): `run.json`, `events.jsonl`, `transcript.jsonl`, `logs/` (one log per command), `ledger.jsonl`, `candidate.diff` (best candidate, 0600), `candidate-<rung>.diff`, `tmp/`, `mise-state/`, `mise-cache/`.
- `run.json` (rewritten atomically after every event) = `{"schema":2,"run_id","slug","approval_sha256","approval_commit","target_branch","status":"running|landed|failed|parked|stopped","landing":{"approval_commit","run_id","expected_parent","final_tree","candidate_commit"}|null,"owner_pid","owner_started_ms","started_ms","recovery":[{"workspace","base","tree","ref","archive","verification":"unverified"}],"cleanup_pending":bool}`. `landing` is written before the base ref moves. `recovery` defaults to `[]` and `cleanup_pending` to false; a preservation record has either a retained ref/tree or a durable archive/manifest identity (unused alternative fields are null). These records remain available after workspace cleanup.
- `events.jsonl`: one object per line, `{"event":s,"ts":int, …}`. Reasons are strings (`repair_cap`, `environment/setup_failed`); non-UTF-8 text goes into `<field>_base64`.

| Event | Fields |
|---|---|
| `started` | approval_commit, approved_by, base_sha, recipe `ladder`, max_rungs, roles, land, budget_ms, credential_source, credential_label, sandbox (`confined\|unconfined\|off`) |
| `sandbox_unavailable` | reason |
| `base_moved_at_start` | approved, tip, ancestor |
| `base_acceptance` | items [{id, kind, base_status}] |
| `setup_reused` | setup_key, saved_wall_ms |
| `plan` | difficulty (`easy\|hard`), wall_ms |
| `rung_started` | rung, model, effort, entered_because, wall_ms (the rung wall, unscaled) |
| `model_stage` | stage, rung, model, effort, tokens {input, cached_input, cache_write, output, reasoning}, wall_ms, prompt_cache_key — one event per model request. `input` excludes cached tokens (§4.9.5). |
| `provider_retry` | stage, rung, reason, delay_ms (unscaled actual delay; absent for a stage retry) |
| `provider_switch` | stage, from_model, to_model (`<model>/<effort>`) |
| `provider_wait` | reason, wait_ms (unscaled), budget_paused true |
| `verification` | rung, tree, result (`green\|red`), checks [{name, exit_status, status, excused, findings}], acceptance [{id, status, demoted}], count |
| `repair` | rung, reason, repairs_left, count |
| `protected_restored` | rung, path |
| `scope_warning` | path, declared_domains |
| `rung_finished` | rung, reason, verdict, diff_lines, candidate_ref |
| `audit` | mode (`observational`), rung, items [{id, verdict, reason}]. Verdicts are `valid`, `over_strict`, `contradicts` (§3.8.2). |
| `acceptance_demoted` | reserved for a future calibrated experiment; MUST NOT be emitted in v1.3-draft |
| `recovery_preserved` | workspace, base, tree, ref or archive, verification (`unverified`) |
| `parallel_started` | attempts |
| `shaping_rechecked` | base, predicates, dependency commits |
| `shaping_stale` | name, path. The Build does not start. |
| `phase_timing` | phase, wall_ms. Advisory. It does not change pass or fail. |
| `selection` | winner_rung, ranking [{rung, key}] |
| `commit_result` | commit, tree |
| `landing_prepared` | landing |
| `landing_retry` | reason, delay_ms |
| `landing_warning` | path, detail |
| `interrupted` | reason |
| `finished` | status, reason, rung, verdict, advisory_items [ids] |
| `reconciled` | status |
| `cleanup_failure` | detail |

## 2.9 Setup cache
Used when `setup` and `setup_outputs` are non-empty. Optional `setup_inputs` is a list of relative paths. When it is non-empty, those files' bytes and mode replace the base tree in the key. The key is SHA-256 of canonical JSON (sorted keys, no spaces):

```
{"v":2,"base_tree":s,"setup":[…],"setup_outputs":[…],"child_env":{…},"os":s,"arch":s,"elixir":s,"otp":s,"inputs":[{path,mode,sha256}]|null}
```

`child_env` is the environment constructed for setup (§5.2) without `MISE_STATE_DIR`, `MISE_CACHE_DIR`, and `MISE_TRUSTED_CONFIG_PATHS`. `inputs` is null when `setup_inputs` is empty. A declared input that escapes the checkout is rejected at project load. Entry = the outputs plus `complete` = `{"v":2,"key","setup_wall_ms","outputs","last_used_ms"}`, published by rename. Hits restore outputs copy-on-write and record `setup_reused`; keep 3 entries; failed setups are never cached. The approval baseline cache `approval-cache/<hex>.json` uses a **separate**, versioned SHA-256 key over canonical JSON: `{"v":3,"checked_base_tree":s,"setup_key":s,"checks":[…],"child_env":{…},"toolchain":{…},"os":s,"arch":s,"adapter_version":s}`. `checked_base_tree` is always the exact tree actually checked, never empty or replaced by `setup_inputs`; setup key reuse cannot imply baseline reuse. `checks` are the full effective definitions (argv, order and deadlines); environment/toolchain identities include relevant check-affecting values and versions. If those identities cannot be established, do not reuse the baseline. Old baseline keys are misses. `setup_inputs` narrows only setup-product reuse. These keys do not change the approval hash, which still binds exact reviewed bytes.

## 2.10 Build report (`status <slug> --json`)
`{"slug","status","build_id","journal","verdict","land_policy","advisory_items","approval","approved_by","base","candidate","landed_sha","priority","blocks_on","cache_hit_rate","agents","credential":{"source","label"},"rungs":[{"rung","model","effort","reason","verdict","diff_lines","candidate_ref","wall_ms","tokens"}],"best_candidate":{"rung","ref","diff_path","verdict"}|null,"audit":[{"rung","id","verdict","reason"}],"acceptance":[{"id","status","demoted"}],"checks":[{"name","status","excused"}],"model_stages":[…],"findings":[{"type","path","message"}],"failures":[{"stage","class","reason","detail"}],"sandbox","budget":{"budget_ms","used_ms","paused_ms"}}`. `budget_ms` is the configured value, unscaled; `used_ms` and `paused_ms` are measured wall time. `cache_hit_rate` is §4.9.5. `agents` is present when any agent record exists.

## 2.11 Status derivation
Slugs = valid directory names under `.kogen/intents/` with an `intent.md`. First match wins:
1. **landed** — a commit reachable from the base has trailer `Kogen-Intent: <slug>`. The checkout's current `intent.md` is not compared. A reused slug stays landed until that trailer is gone.
2. **building** — the claim names the latest run of this slug (latest = greatest `started_ms`).
3. **failed / parked** — the latest run of the current approval commit ended with that status.
4. **blocked** — an approval ref exists, and `blocks_on` names an Intent that has not landed, or the dependency list is a cycle, invalid, or unknown.
5. **approved** — an approval ref exists and dependencies are delivered (runs with status `stopped` are ignored here: the Intent stays queued).
6. **draft**.
`interrupted` overrides approved/building/failed when the latest run of the current approval is running with last event `interrupted` and a dead owner, or failed with reason `interrupted`. **Queue** = approved Intents that are not blocked, sorted by descending `priority`, then approval commit time, then slug. `detail`: building → the current stage or rung, default `starting`; failed/parked/interrupted → the `finished.reason`; blocked → the wait reason in §1.7.5.
