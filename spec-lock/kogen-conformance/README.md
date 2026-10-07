# Kogen conformance suite (core v1)

This repository carries the frozen black-box oracle for the Kogen core v1 specification. The `conformance-v1.1` tag is the frozen v1.1 suite. Branch `v1.2` adds a versioned overlay: it keeps the old case files unchanged, marks cases whose assertions conflict with the current spec as superseded, and adds v1.2 replacements alongside the black-box delta in `kogen-spec/spec/CONFORMANCE-v1.2-CASES.md`. Every case drives a `kogen` executable through its command line only; it checks exit codes, stdout and stderr, files, git refs, the run journal and fake-provider requests. The suite compares implementations in Rust, Go, Elixir or TypeScript on equal terms.

- **Runner:** Python 3 standard library only (3.9+), plus `git`, `sh` and `make`. Nothing is installed.
- **Cases:** The frozen suite has 244 JSON files under `cases/<profile>/`, with rows running as 600 instances. Branch `v1.2` has 125 versioned cases under `cases/v1.2/` and a supersession manifest at `profiles/v1.2.json`.
- **Fake provider:** `kogen_conformance/fake_server.py`, which implements spec §4.8: scripted Responses SSE plus fake OAuth.
- **Normative data:** the existing `data/` is frozen with v1.1. Branch `v1.2` keeps that tree intact and copies the current spec help corpus to `data/v1.2/help/`. Golden pages and other normative inputs come from these files, never from an implementation.

## Contents
- [Running it](#running-it)
- [Profiles](#profiles)
- [How an implementer uses it](#how-an-implementer-uses-it)
- [Results](#results)
- [How a case is built](#how-a-case-is-built)
- [The fake provider](#the-fake-provider)
- [Readings of the spec this suite had to take](#readings-of-the-spec-this-suite-had-to-take)
- [Validation against the Elixir reference](#validation-against-the-elixir-reference)
- [Versioned v1.2 delta](#versioned-v12-delta)
- [Why a custom runner rather than pytest](#why-a-custom-runner-rather-than-pytest)
- [Freeze rule](#freeze-rule)

## Running it
```sh
bin/kogen-conformance run --kogen /path/to/kogen                      # every profile
bin/kogen-conformance run --kogen /path/to/kogen --profile cli,format  # some profiles
bin/kogen-conformance run --kogen /path/to/kogen --case 'build-0*,ladder-12' -v
bin/kogen-conformance list --profile build                            # ids, titles, unimplemented markers
bin/kogen-conformance summary results.jsonl --expectations reference/elixir-97ef563d.json
bin/kogen-conformance fake --script steps.jsonl --port 8765           # the fake provider on its own
```

| Option | Meaning |
|---|---|
| `--kogen PATH` | The implementation's executable (a wrapper script is fine) |
| `--profile a,b` / `--case glob,…` | Select profiles or case ids |
| `--jobs N` | Parallel cases (default: half the CPUs). Cases marked `serial` run afterwards, one at a time. |
| `--workdir DIR` | Where case directories go (default: a new temp dir). Passing cases are deleted unless `--keep` is given. |
| `--out FILE` | JSON Lines results (default `<workdir>/results.jsonl`) |
| `--time-scale X` | `KOGEN_TIME_SCALE` (default 0.01) |
| `--skip-needs login,elixir` | Skip cases that need these. Since v1.1 the runner sets `KOGEN_CREDENTIAL_STORE=file`, so `login` cases never touch a keychain in an implementation that has the seam. |
| `--env NAME=VALUE` | Extra environment for the implementation, such as a runtime path |
| `--expectations FILE` | Known-failure classification, joined into the summary |
| `-v` | Print failure details as cases finish |

The exit status is 0 only when no case failed or errored.

## Profiles
| Profile | §C.4 | Implemented | Unimplemented | Needs |
|---|---:|---:|---:|---|
| `cli` | 30 | 30 | 0 | — (fake for 25, 27, 29, 30) |
| `state` | 30 | 30 | 0 | git, kt (fake for 11, 12, 15, 18, 23, 26, 27) |
| `approval` | 24 | 24 | 0 | git, kt |
| `shape` | 26 | 26 | 0 | fake, kt |
| `build` | 44 | 44 | 0 | fake, kt |
| `ladder` | 36 | 36 | 0 | fake, kt |
| `provider` | 26 | 26 | 0 | fake; login cases need the OAuth flow on port 1455 |
| `custody` | 10 | 10 | 0 | kt, fake |
| `format` | 12 | 12 | 0 | — (fake for 7, 10, 12; login for 11) |
| `exunit` | 6 | 6 | 0 | Elixir on PATH |
| **Total** | **244** | **244** | **0** | |

The original 244 case files remain the v1.1 suite. To run the v1.2 overlay, include `v1.2` with the profiles you want, for example:

```sh
bin/kogen-conformance run --kogen /path/to/kogen --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2
```

The overlay omits the 139 listed v1.1 cases and runs their replacements from `cases/v1.2/`; all other selected cases stay in the run. Selecting only frozen profiles such as `--profile cli,state` runs the original v1.1 cases unchanged. The `v1.2` profile contains 137 cases: 6 delta cases and 131 replacements.

Each unimplemented case is still present as a file with `"status": "unimplemented"` and a `reason`; `list` shows them.

Conformance on a host (§C.1) means every case in `cli state approval shape build ladder provider custody format` passes, with no unmatched fake-provider request. `format` is reported separately so that behaviour work is weighted on its own. `exunit` is required only for the Elixir tier.

## How an implementer uses it
1. **Build the seams first** (spec §4.1, §5.3).
   - `KOGEN_PROVIDER_URL` replaces the responses URL in both owned and injected mode.
   - `KOGEN_AUTH_URL` replaces `https://auth.openai.com` for discovery, authorize, token, JWKS and revoke. The issuer check still expects `https://auth.openai.com`; the fake's discovery document returns that issuer.
   - `KOGEN_TIME_SCALE` multiplies every `scaled: true` constant.
   - `KOGEN_SANDBOX=unavailable`.
   - The `command` acceptance adapter (§2.4.3). Without it, no `kt` case can start.
2. **Put the marker sentences verbatim in the system prompts** (§4.8.2). The fake identifies roles by them alone.
3. **Run `cli` and `format`.** They need no provider.
4. **Run `state` and `approval`.** They need git and the `kt` fixture.
5. **Run `build`, `ladder`, `shape` and `provider`.** They need the fake provider.
6. **Run `custody`.** It needs real process groups and signals.
7. **Read failures with `-v`**, or from `results.jsonl`. Each failure names the step, the assertion and what was observed. A failing case keeps its directory (`workdirs` in the JSONL), with HOME, the origin, the checkout and the state root, so you can rerun `kogen` there by hand.
8. **Do not edit cases.** If a case looks wrong, the fix starts in the spec (§C.2). The suite is tagged `conformance-v1-frozen`.

### What the runner gives every case (§C.3)
| Item | Value |
|---|---|
| Directories | `HOME=<case>/home`, `TMPDIR=<case>/tmp`, a bare origin `<case>/origin.git` and a clone `<case>/checkout`. Some cases use the topologies `single` (the checkout is the origin) or `nonbare`. All paths are canonical (symlinks resolved). |
| `PATH` | `<case>/stubs:` followed by the runner's `PATH` |
| Stubs | `mise` (`env --json` prints `{}`; `exec --` passes the command through); `open` and `xdg-open`, which follow the authorize URL to the loopback from a detached session; argv-size loggers for `sh` and `git` in custody-8 |
| Git | `GIT_CONFIG_GLOBAL=<case>/gitconfig` with identity `Kogen Test <test@kogen.invalid>`, no signing and `init.defaultBranch=main`; `GIT_CONFIG_NOSYSTEM=1` |
| Seams | `KOGEN_PROVIDER_URL=http://127.0.0.1:<port>/v1/responses`, `KOGEN_AUTH_URL=http://127.0.0.1:<port>` and `KOGEN_TIME_SCALE=0.01`. `KOGEN_SANDBOX=unavailable` only where a case asks for it. |
| Credentials | Injected mode by default: `KOGEN_AUTH_PATH=<case>/auth.json`, a JWT with `exp` one day ahead and account `acct_kogen_test`. Owned-mode cases log in through the fake OAuth flow. |
| Other variables | `LANG` (`en_US.UTF-8` on macOS, `C.UTF-8` elsewhere), `TZ=UTC`, `USER`, `LOGNAME`, `SHELL=/bin/sh`. Nothing else from the runner's environment is passed. |
| Fixtures | `kt` (Appendix A; `fixtures/kt` plus `fixtures/kt.project.json`, emitted as strict YAML), `exunit-hello`, `empty`, `none` (no repository) |

Every case asserts the §1.1 stderr rule unless it says otherwise: stderr may hold only shaper progress, the deprecated-`account:` line, `land: warning:` lines and the sandbox warning. stdout must be UTF-8, end with `\n` and contain no `\r` or trailing spaces. Exact wording of shaper progress is checked only in `format`.

## Results
`results.jsonl` holds a `meta` line (suite version, kogen path, platform, git version, time scale) followed by one line per case:
```json
{"id":"build-02","profile":"build","title":"R1 happy path…","spec":["§3.4","§2.5.4"],"file":"cases/build/build-02-….json",
 "status":"pass|fail|error|skip|unimplemented","instances":{"total":1,"passed":1,"skipped":0,"errors":0},
 "failures":[{"instance":"2:failed","messages":["step 4 (run kogen intent remove greet): …"]}],
 "hints":["no provider request reached the fake server (KOGEN_PROVIDER_URL seam missing?)"],
 "duration_ms":2310,"workdirs":["/tmp/…/build-02"],"reason":"(skip/unimplemented only)"}
```
- **Statuses.**
  - `fail` means the implementation broke an assertion.
  - `error` means the harness could not run the case, for example a placeholder that could not be resolved because a run never happened.
  - `skip` means the case needs something that was skipped or is missing (`--skip-needs`, Elixir, a platform).
- **Summary.** The run ends with a per-profile table (cases, implemented, pass, fail, error, skip, unimplemented, instances).
- **Classification.** With `--expectations`, failing cases are grouped by their classification (`R-gap`, `ref-bug`, `spec`), which turns a run into a gap report.
- **No retries.** A failing case is never retried (§C.1).

## How a case is built
A case is one JSON file:
```json
{
 "id": "build-02", "profile": "build", "title": "…", "spec": ["§3.4"],
 "fixture": "kt",
 "project": {"build": {"ladder": {"max_rungs": 1}}},
 "fake": true,
 "script": [{"include": "r1_happy"}],
 "steps": [
  {"intent": "greet"},
  {"approve": "greet"},
  {"run": ["kogen", "queue", "start"], "expect": {"exit": 0, "stdout_lines": ["building greet", "~landed greet [0-9a-f]{8} \\(Build [0-9a-f]{8}\\)", "queue: done; 1 Build(s), 1 landed, 0 not"]}},
  {"assert": {"events": {"slug": "greet", "subsequence": ["started", "plan", "rung_started", "verification", "commit_result", "landing_prepared", {"event": "finished", "status": "landed"}]},
              "refs": {"refs/kogen/claim": false}}}
 ]
}
```

**Top-level keys.**
- `fixture` and `topology` select the world.
- `project` is deep-merged into the kt `project.yaml`; `project_yaml` replaces it verbatim.
- `fixture_files` adds files to the fixture.
- `env`, `auth` (`injected`, `owned` or `none`), `sandbox_unavailable`, `time_scale`, `fake`, `script`, `allow_remaining`, `allow_unmatched`, `needs`, `serial`, `notes`.
- `rows`, `rows_from` and `rows_zip` expand a case into instances. `{row.x}` substitutes a value and `{*row.x}` splices a list. The v1.2 help corpus uses the `help_pages_v1_2` generator and `data/v1.2/help/`.

**Steps.** The first key names the step:
- **Files and git:** `write` (text, `b64`, template `from`, `crlf`, `mode`, `in`), `remove`, `symlink`, `intent` (installs `cases/_templates/intents/<t>/`, optionally with replacements, and commits it), `commit`, `push`, `origin_commit` (moves the origin's base), `git`, `sh`.
- **The implementation:** `run`, which takes `stdin`, `env`, `cwd`, `background`, `signal: {sig, when}`, `timeout` and `capture`. `approve` is a shorthand for approving with the computed hash.
- **Processes:** `wait`, `signal`, `wait_until` (a file, stdout, a journal event, a fake request count, or an exit), `sleep`.
- **State:** `synthetic_run` writes a §2.8 run dir for status derivation cases. `snapshot` records the checkout state, `capture` records a value into a variable, and `fake` replaces or appends script steps or changes the OAuth configuration.
- **Checks:** `assert`, `eventually` (an `assert` retried until a deadline) and `skip_if`.

**Expectations (`run.expect`).**
- `exit`.
- `stdout` exact; it may be built from parts such as `{"data": "help/kogen.txt"}` or `{"lines": […]}`.
- `stdout_regex`, `stdout_lines` (exact lines, or `~regex` lines), `stdout_starts_lines`, `stdout_contains`, `stdout_json` / `stdout_jsonl` (matchers), `watch_frames`.
- `stderr` exact, `stderr_lines`, `stderr_contains`, `stderr_any`.
- `max_wall_ms`.

**Assertions.**
- `files`: exists, text, regex, contains, json, jsonl, mode, `is_symlink`, entries, `same_as`.
- `glob_count`.
- `refs` / `ref_count`: in the origin by default.
- `git`: a command whose output is checked as text or JSON.
- `events`: on a slug's latest run, with `subsequence`, `contains`, `each`, `absent`, `count`, `first`, `last` and `sequence_equal`.
- `run_json`, `runs_count`.
- `fake_requests`: select by role, turn, step or nth, then a body/header matcher, `input_contains`, `input_regex` or `first_user_text`.
- `fake_request_sequences`: relational checks over ordered fake requests, including raw body bytes, append-only input, cache/session headers and journal identities.
- `fake_request_count`, `fake_remaining`, `fake_oauth`, `fake_oauth_count`.
- `checkout_clean`, `checkout_unchanged`, `argv_max`, `vars`.

**Matchers** are JSON:
- An object matches as a subset; `"$exact": true` forbids extra keys.
- `"~regex"` must match fully.
- Type tokens: `$str`, `$int`, `$bool`, `$null`, `$sha`, `$hex8`, `$hex32`, `$hex64`, `$any`, `$absent`, …
- Combinators: `{"$any_of": […]}`, `{"$contains": […]}`, `{"$subsequence": […]}`, `{"$not": m}`, `{"$ge": n}`, …

**Placeholders.** The runner computes these from the spec's formulas, never from the implementation's output:
- Paths: `{checkout}`, `{origin}`, `{home}`, `{case}`, `{tmp}`.
- `{state_root}`: `~/.kogen/workspaces/<basename≤40>-<sha256(path)[:10]>`.
- Approval hashes `{hash6:slug}`, `{hash8:slug}`, `{hash64:slug}`: SHA-256 of `intent.md` ‖ NUL ‖ the test.
- `{intent_sha:slug}`, `{base_sha}`, `{approval_commit:slug}`, `{approval8:slug}`.
- `{run_id:slug}`, `{id8:slug}`, `{run_dir:slug}`: the latest run, by `started_ms`.
- `{sha256_file:path}`, `{sha256_origin:path}`, `{absent_sha}`, `{var:name}`.

## The fake provider
The fake implements spec §4.8:
- **Endpoints:** `POST …/responses`; inspection at `GET /_fake/requests`, `GET /_fake/remaining`, `POST /_fake/reset`, `POST /_fake/script` and `GET /_fake/oauth`; OAuth at `/.well-known/openid-configuration`, `/api/accounts/authorize` (302 to the callback with the same `state`), `/api/accounts/oauth/token` (verifies PKCE S256), `/jwks` (a 2048-bit RSA key generated per run, signing RS256 id_tokens) and `/revoke`.
- **Roles** come from the §4.8.2 marker sentences.
- **`turn`** is 1 for a fresh conversation (exactly one user message, not counting `additional_tools`) and adds 1 for each later request of the same role whose input extends the previous one.

A script step looks like this:
```json
{"id": "edit",
 "expect": {"role": "builder", "model": "gpt-6-luna", "effort": "max", "tools": ["shell"], "turn": 1,
            "input_contains": ["## Request"], "last_output_contains": "exit 0", "last_user_contains": "…", "fresh": true, "after": ["plan"]},
 "reply": {"calls": [{"name": "shell", "arguments": {"cmd": "printf 'Hello, Almir!\\n' > lib/greet.txt"}}]},
 "first_byte_ms": 0, "chunk_gap_ms": 0, "drop_after_events": null, "pad_events": 0, "repeat": 1, "side_effect_sh": "…", "usage": {…}}
```
- **Replies:** `text` (a done claim for builders), `calls` (call ids `call_<step>_<i>`, arguments serialised as a JSON string), `items`, `sse` (raw frames, `{"raw": …}` or `{"raw_b64": …}`), and `http` (`{status, body, headers}`).
- **Delays** are given unscaled and divided by `KOGEN_TIME_SCALE`.
- **`side_effect_sh`** runs before the reply. It sees `ORIGIN`, `CHECKOUT`, `CASE_DIR` and `STATE_ROOT`.
- **A successful reply** streams one `response.output_item.done` per item, then `response.completed` (`resp_<n>`, empty `output`, usage). The default usage is input 120, cached 20, output 30, reasoning 10. A scripted `usage: null` omits the usage object; `usage: {}` sends it without counts.
- **Unmatched requests** get HTTP 400 `scripted_mismatch`. A case fails on any unmatched request and, unless it says otherwise, on any unserved step.

## Readings settled in v1.1
v1 listed 30 points where the spec was silent or ambiguous. The triage of Kogen 80a4dd97 ([TRIAGE-80a4dd97.md](TRIAGE-80a4dd97.md)) settled every one, using Almir's precedence (product and DX: his newest word; success, speed and cost: the newest measurement) and, where both are silent, the spec's own rule that the reference supplies exact strings. Each settlement is now in the spec (marked "v1.1") and, where a case could be tightened, in the case. None needed Almir: none is a product or DX question he has not already answered.

| # | Point | Settled as | Source | Cases |
|---|---|---|---|---|
| 1 | Credential store isolation | Test seam `KOGEN_CREDENTIAL_STORE=file`: logins in `~/.kogen/credentials/` as 0600 files, never the OS keychain. The runner always sets it, so login cases no longer need `--skip-needs login`. | Engineering need (tests must never write a real keychain); Almir: logins live in `~/.kogen` (`dec-kogen-account-logins-in-kogen-home-per-user-project-binding-20261005`) | runner, all login cases |
| 2 | Build auditor marker | The test-auditor marker `You are Kogen's acceptance test auditor.` | Reference 80a4dd97 (`Kogen.Runner.Auditor` uses it at build time) | unchanged |
| 3 | Requirement-auditor reply | `{"rows":[{"constraint","maps_to"}]}`, the shape of `ledger.json` | Spec-internal consistency (§2.4.5) | unchanged |
| 4 | Witness adjudication | Tool-less request with the test-auditor marker; `{"items":[{"id","verdict":"TEST-WRONG\|WITNESS-WRONG\|UNDECIDED","citation","reason"}]}` | Consistency with §3.8.2; witness stays pending measurement | unchanged |
| 5 | Fallback shaper marker | The shaper marker; told apart by model and fresh conversation | §3.2.1 | unchanged |
| 6 | `kogen help <words> --help` | `--help` right after `help` is the flag; after a word it is a word (`kogen help: no command 'intent --help'`) | Reference | none added |
| 7 | Queued and Drafts rows | `  <slug>`, no detail | Reference | cli-25 |
| 8 | Stopped-drain counts and article | `<N>` counts the stopped Build; `hit an environment error` | Reference counts; English | build-39/40/41, exunit-02, state-10, provider-19 |
| 9 | `(Build <id8>)` on B0 refusals | Absent: no run exists before B1 | §3.4 | build-41, state-10 (provider-19 keeps it: its run exists) |
| 10 | Skipped-only drain | `queue: nothing to build` | §1.7.4 (nothing was built) | build-42 |
| 11 | `remove_requires_force` lines | `Intent still has a failed Build approval; pass --force to discard the approval and remove its files` (parked, approval ref alike) | Reference | approval-23 |
| 12 | Path forms | `request_unavailable` absolute; `acceptance_check_path_conflict` checkout-relative; `--json` paths absolute | Reference | shape-05, approval-19 |
| 13 | Shaping first message | Gate paths in byte order; request verbatim, then `\n\n` | Reference | unchanged |
| 14 | Missing formatter | Progress line `shaper pass=<n> role=<role> warning formatter_unavailable` (already allowed by §1.1) | §3.2.6 vocabulary | shape-18 |
| 15 | CheckSpec index and line | 1-based `<list>[<i>]`; schema issues have no `line` | Reference | state-02 |
| 16 | YAML sibling messages | Block scalar → "anchors, aliases, tags, and block scalars"; anchor/alias/tag → "anchors, aliases, and tags"; `<v>` the scalar as written, `<text>` the rest of the line | Reference | unchanged (wording is SHOULD) |
| 17 | Intent parse lines | Missing closing `---`: line after the last line; missing key and non-map frontmatter: line 2 | Reference | state-04 |
| 18 | `unsupported_verify_kind` | First word `example` or `check`; any other word is `invalid_verify` | Reference parser | none added |
| 19 | Base-red rows and `symbol` | `symbol` is parsed only for test findings; the row keeps the rest (`greet.txt: TODO found`) | §2.4.4 statement | approval-08 |
| 20 | `acceptance_paths` | Source paths | Reference | state-09 |
| 21 | Empty `chatgpt:` map | `chatgpt: {}` | Strict YAML rule | unchanged |
| 22 | Rung wall in the journal | `rung_started.wall_ms`, unscaled | §2.8 table | unchanged |
| 23 | `model_stage` granularity | One per model request; stages `shape`, `ledger`, `shape_audit`, `plan`, `develop`, `audit` | Reference per-request records (T67) | unchanged |
| 24 | Report budget figures | `budget_ms` configured (unscaled); `used_ms`, `paused_ms` measured | §4.1 journal rule | unchanged |
| 25 | `--by` without a git identity | Refused: `intent/approval_identity_unavailable` (exit 2); `--by` names the agent and delegation, the commit keeps the caller's identity | Almir ruling `dec-kogen-ruling-approver-identity-caller-on-behalf-20261005` | none added |
| 26 | Shaping recounts | Ledger and audit run in every pass reaching step 7; `candidate/coverage_gap`; an uncited non-valid verdict is a warning, never a repair | Resolved call 3 (concerns are warnings) | unchanged |
| 27 | Dropped stream | `transport` | Reference | provider-17 |
| 28 | Turn budget note | Turn 49 (after 48 turns), N = 12 | Reference | unchanged (already turn 49) |
| 29 | Undetected checkout writes | Confining host: the write fails and the Build lands (exit 0); 70 only when unconfined and detected | §5.3 | custody-06 |
| 30 | Integration repairs | Bounded by the landing allowance alone; a moved base parks only when rebase or re-gate is impossible after repairs | §3.9.2 and research/executable-specs landing.qnt (5 Oct fix) | build-25/26, ladder-19 already match |

### Other v1.1 changes
- **Provider resilience follows Kogen T66** (coordinator: technical, the code reflects the T66 decisions, no measurement says otherwise): model switch after **2** consecutive overloads (overloads only) to `gpt-6.1-sol/medium` (r66 supports Sol medium over Luna max), **4** attempts per request, **2** stage retries, jittered backoff (half to full ceiling, `delay_ms` records the actual delay), then `stopped provider/<class>`; the 30-minute outage window is gone. Cases provider-08/09/12/13/14/15/16/17, ladder-22, ladder-36; `data/constants.json`.
- **Shaper default** is `gpt-6.1-sol/high`, not the builder (Almir 5 Oct, build/LOG.md: "Sol (never Luna) shapes"; Kogen task T69). Cases shape-01/06/12/13/23.
- **provider-21** accepts an upper-case host UUID (the spec does not pin case).

## Validation against the Elixir reference
The reference is `~/Areas/Kogen/careful-rebuild` at **97ef563d**, the HEAD that APPENDIX-REFERENCE.md describes. It was validated on macOS (Apple silicon) with git 2.54 and Erlang/OTP 29, using `--skip-needs login`. Every build ran in standalone copies under `/tmp/claude-501`. (Correction, 5 Oct evening: that run did stage two files in the main careful-rebuild checkout's index; they were removed. The 80a4dd97 run below used its own git worktree and left careful-rebuild untouched.)

| Binary | Pass | Fail | of which R-gap | of which ref-bug | of which spec | Skip | Harness errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| 97ef563d as is | 21 | 218 | 125 | 93 | 0 | 5 | 0 |
| 97ef563d + `proposals/reference-seams.diff` | 69 | 170 | 77 | 93 | 0 | 5 | 0 |

- **Skips.** 4 provider login cases and format-11 need a login. The reference keeps logins in the macOS login Keychain, so they were not run (reading 1 above).
- **Raw results.** `reference/results/*.jsonl`.
- **Classifications.** `reference/elixir-97ef563d.json` and `reference/elixir-97ef563d-seams.json`. Rejoin them with `summary --expectations`.
- **No spec failures.** Every failure is either a reference gap or a reference bug. Where the spec is ambiguous, the cases accept every reasonable reading (see the readings section).

**Unpatched result.** Only the cases that need no project pass: 19 cli and format-01/06. Every `kt` case stops at `project has unknown key "acceptance"`, and no request ever reaches the fake provider.

**Seams and behaviours the reference needs (R-gap).**
The proposal patch adds these (29 files, about 765 lines):
- `KOGEN_PROVIDER_URL` (both modes) and `KOGEN_AUTH_URL` (discovery, authorize, token, refresh; the issuer check is unchanged).
- `KOGEN_TIME_SCALE`, applied to the timers the reference has: request deadlines, the shell deadline, lock wait and staleness, the login wait and the watch poll.
- `KOGEN_SANDBOX=unavailable`, with the stderr warning, the `sandbox_unavailable` event and `sandbox` in `started`.
- The `command` acceptance adapter and the `acceptance:` key, replacing the 19 hard-coded `_test.exs` and `test/acceptance` sites.
- The builder marker `You are Kogen's builder.`
- The approval hash over `intent.md ‖ NUL ‖ test`. Without it, no hash approval can succeed.

Two needs are still open:
- The spec has no test seam for the credential store. On macOS the login cases write to the real Keychain.
- §4.8.2 has no marker for the build auditor.

**Features still missing even with the seams (77 R-gap cases).**
- The single-recipe ladder and its keys (`build.ladder`, `land`, `budget_ms`, `fallback`, `shaping`): all 36 ladder cases, plus build-06/07/10/31/44 and state-03/26.
- The auditor with citations, the selector, verdicts, best candidate, and the `Difficulty` entry rule.
- Progress repairs: the cap of 6, where the reference allows 2+1 (build-05).
- Integration repairs on a moved base (build-25/26).
- Provider backoff, model switch, usage-limit waits and outage handling (9 provider cases).
- From shaping: the finish guard, the fallback conversation, style repairs outside the cap, the requirement ledger, the shaping audit, `Concerns:` and witness mode (20 shape cases).
- The `no_change_item` lint rule and the approval-baseline cache.

**Reference bugs (93 cases).** These are behaviours the reference implements differently from the spec, and most are already in APPENDIX-REFERENCE.md:
- Errors print as Elixir terms with exit 70.
- Boolean flags accept `=value`, and slugs are validated after the project loads.
- `run.json` is schema 1 and the journal has no `ts`, so `status` exits 70 on any §2.8 run dir.
- `approval.json` is schema 1, and the trailer hash covers only the Intent.
- The hash is compared after the checks have run.
- Style lint rules are errors.
- The card has no Feasibility line, base-red rows are not parsed into findings, and feedback lines are not in the §3.7.3 format.
- A 401 is classed `environment` and fails the Build; it should stop the drain with exit 4.
- There is no SIGINT handling, no `skipped`/`stopped` drain lines, and a landing lock is retried only once.
- A missing tool is recorded as `red` instead of `unavailable`.
- A lost approval CAS is not retried.
- A reused slug stays landed.
- custody-8: the shell tool passed a 307,284-byte `sh -c` argument.

**What the patched reference does confirm.** It lands the R1 happy path through the fake provider (cli-27, state-15/18/22/27, build-01/21/28/30/32–36/38/43). It also matches the suite's encodings of:
- approval refs, manifests, re-approval chains and `remove`;
- shell-tool and shaper-tool results (provider-23/24/25);
- the input chain, `call_id`s and `prompt_cache_key` (provider-04/05);
- SSE edge cases (provider-06/07);
- the protected-restore note (build-09);
- process custody (custody-03/06/09/10).

**Note on the proposal's base.** `proposals/reference-seams.diff` applies to 97ef563d. `proposals/reference-seams-on-0e0f2c91.diff` is the same patch made earlier against 0e0f2c91. careful-rebuild moved on during this work (0e0f2c91 … 260a73bc added a ladder recipe and provider retries); those newer commits were not validated.

## Validation against Kogen 80a4dd97 (v1.1)
80a4dd97 adds the ladder, the test auditor, provider resilience and per-request records. It ran in its own worktree (`careful-rebuild-wt/conf2`, branch `conf/seams`) with `proposals/reference-seams-on-80a4dd97.diff`, which rebases the seams and adds `KOGEN_CREDENTIAL_STORE=file`.

| Binary | Suite | Pass | Fail | ref-bug (a) | R-gap (d) | spec (b) | test (c) | Skip |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 80a4dd97 as is | v1 | 21 | 218 | 80 | 129 | 9 | 0 | 5 |
| 80a4dd97 + seams | v1 | 70 | 174 | 84 | 81 | 9 | 0 | 0 |
| 80a4dd97 + seams | v1.1 | 75 | 169 | 84 | 84 | 0 | 0 | 0 |

The per-cause triage, the 40 self-build tasks and the settlements are in [TRIAGE-80a4dd97.md](TRIAGE-80a4dd97.md). Classifications: `reference/kogen-80a4dd97.json`, `reference/kogen-80a4dd97-seams.json`.

## Why a custom runner rather than pytest
§C.3 recommends Python 3 with the standard library only, and this suite follows that:
- **Nothing to install.** An implementer on a fresh macOS or Linux host runs `bin/kogen-conformance` with no virtualenv, pip or version pinning, and the oracle cannot drift through a dependency upgrade. pytest and PyYAML are not on a stock host (neither was on the validation machine).
- **Cases are data, not code.** The freeze rule is about case files. JSON files with a closed step and assertion vocabulary can be reviewed, diffed and frozen without reading Python. They also cannot hide implementation-specific logic in test code.
- **Results are first-class.** The runner writes the JSON Lines and summary formats this README specifies, joins known-failure classifications, keeps failing worlds, never retries, and runs `serial` cases (the fixed 1455 loopback) apart. Expressing all that through pytest plugins would add more machinery than it removes.
- **JSON rather than YAML.** The standard library has no YAML parser, and a strict YAML subset is one of the things under test. The suite emits `project.yaml` through its own small emitter for the §2.6 subset and never parses YAML.

## Versioned v1.2 delta

Branch `v1.2` is additive to the tagged v1.1 suite. Existing v1.1 case files and data stay unchanged; new cases live in `cases/v1.2/` and the v1.2 help goldens live in `data/v1.2/help/`. The profile is language-neutral and invokes only the `kogen` executable. Run it with:

```sh
bin/kogen-conformance run --kogen /path/to/kogen --profile v1.2 -v
```

The fake provider records exact request-body bytes as `body_raw_b64`, so the suite can prove the byte-prefix rule from §4.9.2. The `fake_request_sequences` assertion checks request-to-request identity and journal relations. Scripted missing usage exercises §4.9.5.

| Case | Required observation | Current Elixir Kogen |
|---|---|---|
| `v1.2-01-fixed-cli-help-and-grok` | Exact v1.2 help pages/routes; `grok` is accepted by existing provider commands. | Pass (21/21 rows) |
| `v1.2-02-approval-hash-intent-and-test-bytes` | Hash equals exact Intent bytes, NUL, and exact UTF-8 acceptance-source bytes; the approval commit preserves the bytes. | Fail at the hash assertion: Kogen advertises the Intent-only hash |
| `v1.2-03-consecutive-request-byte-prefix` | Turn 2's raw JSON request begins with turn 1 after removing its final `]}`, followed by `,`; input items stay an unchanged prefix. | Pass |
| `v1.2-04-cache-key-session-headers` | Stable nonempty Build cache key; `session-id` equals it; stable conversation `thread-id` matches the request journal. | Fail at journal identity: no `model_stage` matches the request cache, thread and conversation ids |
| `v1.2-05-missing-usage` | Missing usage counts remain null and no measured input produces a null `cache_hit_rate`. | Fail at status JSON: usage is reported as measured (cache hit rate `0.1666…`) |
| `v1.2-06-crash-after-base-cas` | Recovery after the owner dies just after base CAS reports landed, releases its claim and removes the incoming ref. | Fail at incoming-ref cleanup: one `refs/kogen/incoming/` ref remains |

Run against installed Elixir Kogen `b73a0534` on 2026-10-06: 2 pass, 4 fail; all six cases reached their v1.2 assertions. Cases 03–06 omit the optional `acceptance` key and use the spec v1.2 default adapter, ExUnit. Their case notes record that this binary rejects the spec-defined key as unknown; they read Kogen's advertised approval digest so the separate hash drift remains covered by case 02. Because this binary hardcodes its ChatGPT endpoint and ignores `KOGEN_PROVIDER_URL`, the provider cases used a temporary local HTTPS proxy to route traffic into the runner's fake provider.

A rewrite must pass the v1.2 profile in addition to the guaranteed v1.1 slices before claiming v1.2 conformance. The profile does not itself establish the separate live-cache hit-rate target.

## Freeze rule
- This repository is tagged `conformance-v1-frozen`, and `conformance-v1.1` after the 80a4dd97 triage (spec v1.1 and the case changes listed under "Readings settled in v1.1").
- The v1.1 case files and `data/` remain unchanged on this branch. The v1.2 profile changes the runner and fake provider only to express the new v1.2 contracts, alongside the v1.2 case and help-golden additions.
- A case found to be ambiguous is fixed in the spec first. The readings section above lists the candidates.
