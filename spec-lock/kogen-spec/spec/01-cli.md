# 1. CLI surface

The command tree is fixed by [CLI-RULE.txt](../CLI-RULE.txt). Help text is the byte-exact pages in [data/help/](data/help/). The provider names are `chatgpt` and `grok` on the existing `login`, `logout`, and `use` commands (§4.10). No command, subcommand, or flag is added.

## 1.1 Process model
- One executable, `kogen`. Every call is a fresh process. There is no daemon, TUI, prompt, colour, or pager. Output does not depend on whether stdout is a terminal.
- **stdout** carries results, help, usage errors, and error lines. **stderr** carries only: shaper progress (§3.2.6), the deprecated-`account:` warning (§1.8), `land: warning:` lines (§3.9.3), and `kogen: warning: sandbox unavailable: <reason>; building unconfined` (§5.3). Everything else leaves stderr empty.
- UTF-8. Every line ends with `\n`. No `\r`. No trailing spaces. `queue start` lines, `status --watch` frames, and the provider login prompts stream. The rest may be buffered.
- **Environment read:** `HOME` (`~/.kogen` = `$HOME/.kogen`), `TMPDIR` (default `/tmp`), `PATH`, proxy variables, `KOGEN_AUTH_PATH` (ChatGPT injected auth only, §4.6), `KOGEN_BENCH_PROVIDER` (`chatgpt` or `grok`), `KOGEN_BENCH_ACCOUNT`, and the test seams `KOGEN_PROVIDER_URL`, `KOGEN_AUTH_URL`, `KOGEN_TIME_SCALE`, `KOGEN_CREDENTIAL_STORE=file` (§4.1), `KOGEN_SANDBOX=unavailable` (§5.3), plus `KOGEN_SANDBOXED` (§5.3). `KOGEN_BENCH_NO_FALLBACK=1` disables model fallback (§4.5).

## 1.2 Command tree (fixed)
```
kogen status [<slug>] [--watch] [--json]
kogen intent shape <slug> <file|->
kogen intent approve <slug> [<hash>] [--by <name>]
kogen intent remove <slug> [--force]
kogen queue start [--detach]
kogen queue stop
kogen provider list
kogen provider login chatgpt
kogen provider login grok
kogen provider logout chatgpt
kogen provider logout grok
kogen provider use chatgpt --as <label> [--project <checkout>]
kogen provider use grok --as <label> [--project <checkout>]
kogen version
kogen help
```
Project commands (`status`, `intent *`, `queue *`) also take `--project <checkout>` (default: the working directory), `--origin <repo>`, and `--base <branch>`. `provider use` takes `--project` and requires `--as`. No other commands or options exist.

These forms are usage errors, exit 2, not hidden commands: `--help` anywhere, `kogen help <topic>`, `--json` on `intent shape`, `--as` on `login` or `logout`, `provider use` without `--as`, and `kogen checks` / `kogen agents` / `provider test`.

## 1.3 Argument grammar
1. `--name value` or `--name=value`. Boolean flags (`--json`, `--watch`, `--force`, `--detach`) take no value. `kogen status: --json takes no value` when a value is attached. The same shape applies to the other boolean flags, with that command's path.
2. Options go anywhere after the command path. A token before the path is the command (`kogen --project x status` is an unknown command). A repeated option: the last one wins. `--` ends options. There are no short options. A lone `-` is a positional (stdin for `<file|->`).
3. Processing order, first match wins:
   1. **Moved forms** ([data/moved.json](data/moved.json)), over the whole argv, before anything else. One line `kogen: moved: use <message>`, exit 2. No help page follows.
   2. **Tree.** `[]` and `help` print the top page, exit 0. `help` with any further token is `kogen help: unexpected argument '<token>'`, exit 2, then the top page. A group alone (`intent`, `queue`, `provider`) prints that group's page, exit 0. An unknown subcommand is `kogen <group>: unknown command '<sub>'`, exit 2, then the group page. An unknown first token is `kogen: unknown command '<x>'`, exit 2, then the top page. `--help` is not special: `kogen --help` is an unknown command, and `kogen status --help` is an unknown option.
   3. Unknown option: `kogen <path>: unknown option '<opt>'`. A value option without a value: `kogen <path>: <opt> needs a value`.
   4. Positionals: `kogen <path>: missing <name>` (names as in the usage line: `<slug>`, `<file|->`, `<provider>`, `<hash>`) or `kogen <path>: unexpected argument '<arg>'`.
   5. Values: `kogen provider <verb>: unknown provider '<p>' (supported: chatgpt, grok)` · `kogen intent approve: <hash> must be 6 to 64 lowercase hex characters` · `kogen status: --watch and --json can't be combined` · `kogen provider use: missing --as <label>`.
4. A usage error prints `<message>\n\n<the meant command's help page>`, exit 2. `<path>` is the command words (`intent approve`). The meant page for a bad `help` topic is the top page.
5. `--project` and `--origin` expand against the working directory to absolute paths. `version`, `help`, and `provider *` do not default `--project` to the working directory.

The parser does not check slug shape. A slug that is not lowercase letters, digits, and single dashes is rejected when the command runs (§2.1.1). Length 3–48 is an Intent lint rule, not a parse error.

## 1.4 Help pages
Byte-exact pages are in [data/help/](data/help/). Each is printed with its trailing `\n`.

| Invocation | Page |
|---|---|
| `kogen`, `kogen help` | `kogen.txt` |
| `kogen <group>` | `kogen-<group>.txt` |
| `kogen <group> <command>` is not how help is shown; the command runs | |
| A usage error | the page of the command that was meant |

There is no separate `help` topic page. `kogen <command> --help` is a usage error.

## 1.5 Exit codes and error lines
| Code | Meaning |
|---|---|
| 0 | done |
| 1 | ran; the answer is no (Build not landed, hash mismatch, lint error, red acceptance check, shaping failed) |
| 2 | usage, moved form, or a request the caller fixes by changing arguments (needs `--force`, not found, untracked, no git identity, unreadable request) |
| 3 | environment (not a git repo, invalid config, toolchain, setup, checkout behind base) |
| 4 | provider (login, usage limit, or outage that stopped the drain) |
| 5 | needs a decision; advisory (`intent approve` without a hash) |
| 70 | Kogen bug |
| 130 / 143 | SIGINT / SIGTERM |

**Error line:** `<class>/<reason>: <detail>` on stdout. `class` is one of `intent`, `check`, `environment`, `provider`, `candidate`, `controller`, `shape`. Reason is snake_case. Further lines of a detail are indented two spaces. No language term syntax appears. Under `--json`, errors are still this text.

| Situation | Line | Exit |
|---|---|---|
| project dir missing | `environment/project_unavailable: <path>` | 3 |
| not a git work tree | `environment/not_a_git_repo: <path>` | 3 |
| invalid `.kogen/project.yaml` / `~/.kogen/config.yaml` | `environment/project_config_invalid: <path>` / `environment/machine_config_invalid: <path>` + `  line <n>: <msg>` or `  <msg>` per issue | 3 |
| base unresolvable | `environment/base_unavailable: <detail>` | 3 |
| Intent missing | `intent/not_found: Intent does not exist` | 2 |
| acceptance source missing | `intent/acceptance_missing: <path> does not exist` | 2 |
| Intent parse errors | `intent/parse: the Intent cannot be read` + `  line <n>: <msg>` | 1 |
| lint errors | `intent/lint: the Intent needs changes` + `  <rule> at line <n>: <msg>` or `  <rule>: <msg>` | 1 |
| hash mismatch | `intent/hash_mismatch: <slug> is now <sha8>, not <prefix>; review it again with kogen intent approve <slug>` | 1 |
| bad slug | `intent/invalid_slug: Slug must use lowercase letters, digits, and dashes.` | 2 |
| no git identity | `intent/approval_identity_unavailable: configure git user.name and user.email` | 2 |
| request unreadable or empty | `intent/request_unavailable: <stdin\|path>: <empty\|not found\|unreadable>` (path absolute) | 2 |
| acceptance check red | `check/acceptance_check_failed: acceptance check <name> failed` (or `timed out`) + at most 20 indented lines | 1 |
| tool missing | `environment/tool_missing: <argv0> is not available` | 3 |
| setup failed | `environment/setup_failed: Setup <name> failed (status=<n>, timed_out=<bool>).` + tail | 3 |
| checkout behind base | `environment/checkout_behind_base: checkout is behind <base>: <p1>, <p2> differ; update your checkout first` | 3 |
| provider | `provider/<class>: <message>` (§4.4, §4.10) | 4 |
| shaping stopped on a provider error | the `provider/…` line, then `shape/provider_failed: shaping stopped on a provider error after its retries; no Intent was written. Run kogen intent shape again, or write the Intent yourself.` For `login` and `usage_limit` the second sentence is `shaping stopped on a provider error that retrying cannot fix; no Intent was written. Fix the account, then run kogen intent shape again.` | 4 |
| anything unmapped | `controller/internal_error: <one line>` | 70 |

`mise` is used when it is on `PATH` (§5.2). Its absence is not an error.

## 1.6 Project resolution (all project commands)
1. Project = `--project` or the working directory: a directory in a git work tree.
2. Origin = `--origin`; else the checkout's `remote.origin.url` when it names a local repository (no scheme other than `file://` with an empty or `localhost` host; not `user@host:`; `~/` means `HOME`; relative to the checkout; a directory with `HEAD` or `.git`); else the checkout. `status` never fetches.
3. Base = `--base`; else the project `base`; else `refs/remotes/origin/HEAD` of the checkout when the origin is the checkout, or the origin's `HEAD` when the origin is separate; else the current branch; else `environment/base_unavailable`.
4. State root = `~/.kogen/workspaces/<key>` (§2.7). Crash recovery (§3.10.5) runs before reading or draining.
5. Provider for the run = `KOGEN_BENCH_PROVIDER` when it is `chatgpt` or `grok`; else the checkout's row in `accounts.yaml` `selection.projects`; else `selection.default`; else `chatgpt` (§2.7, §4.10).

## 1.7 Commands
### 1.7.1 `intent shape <slug> <file|->`
Reads the request (`-` is stdin to EOF, otherwise the file relative to the working directory). Bytes are kept exactly. Empty or whitespace-only input is `intent/request_unavailable`. Runs shaping (§3.2) and blocks, with no wall limit. Never approves or commits. There is no `--json`.

Text, exit 0:
```
Intent: <abs intent path>
Acceptance test: <abs acceptance source path>
Validated after <rounds> round(s).
Warnings
  - <code>: <A1, A2> — <message>
shape <model>/<effort> input=<n> cached=<n> output=<n> reasoning=<n> wall_ms=<n>
Transcript: <run dir>/transcript.jsonl
Next: kogen intent approve <slug>
```
The `Warnings` block is omitted when there are no warnings. One `shape` line is printed per model call. The scratch directory also retains the all-attempt accounting receipt (§3.2.1), including failures and unknown usage; no new CLI flag is introduced. Empty item ids print as `-`. The separator before the message is an em dash.

Exits: 0; 1 when shaping failed (§3.2.5); 2; 3; 4 when the provider stops after the retry policy (§4.5); 70.

### 1.7.2 `intent approve <slug> [<hash>] [--by <name>]`
The hash is the **approval hash**: SHA-256 of the exact `intent.md` bytes, one NUL byte, and the exact acceptance source bytes (§2.1.3). The card shows that digest. The prefix check compares it.
- **Without a hash:** parse, lint (errors exit 1; style findings are card warnings), read the test, resolve `base_sha`, run the approval checks (§3.3), print the card, exit 5.
- **With a hash:** compute the hash first. A prefix that does not match exits 1 with `intent/hash_mismatch` and runs nothing else. A match proceeds through §3.3; re-read both sources immediately before the ref CAS and refuse a changed digest without updating the ref (§2.5.1).

Card, then the approve line:
```
Intent: <slug> — <title>
SHA-256: <64 hex>
Approver: <Name <email> | --by value>
Base: <base> at <base_sha>

Brief
  <Brief lines, indented 2>

Acceptance
  - [A1] <text> (<test|test keep>)
Warnings
  - <code>: <ids> — <message>
Approve with:
  kogen intent approve <slug> <sha8>
```
The `Warnings` block is omitted when there are no warnings and no base-red check warning. A base-red check warning is inside that block:
```
Warning: configured checks are already red on the base:
  - <check>: [<rule>] <path>:<line>: <message>
Hint: fix the base first, or scope the check, e.g. a changed-files format argv.
```
At most 5 rows per check.

Approved, exit 0: warnings first (same block, including the base-red warning when present), then `approved <slug> <sha8> (approval <commit8>); it is queued` and `Next: kogen queue start (does nothing if the queue is already running)`. The approver is `--by` verbatim when it is non-blank and one line, otherwise `git var GIT_AUTHOR_IDENT` as `Name <email>`. Re-approval writes a new approval commit. There is no "already approved" message.

### 1.7.3 `intent remove <slug> [--force]`
Refusals, exit 2:
- `intent/not_found: Intent does not exist`
- `intent/remove_blocked: Intent is in an active Build and cannot be removed` (also with `--force`)
- `intent/remove_requires_force: Intent approved or queued; pass --force to discard the approval and remove its files`
- the same reason with `still has a failed Build approval`, `still has a parked Build approval`, or `still has an approval ref`
- `intent/remove_requires_commit: Intent files must be tracked to record their removal`

Drafts and landed Intents need no `--force`. Effect: delete `.kogen/intents/<slug>/` and the acceptance source; one path-limited commit `Remove Intent <slug>` in the checkout (not pushed; other staged changes stay out); CAS-delete the approval ref. Output: `removed: <slug>` and `commit: <sha>`.

### 1.7.4 `queue start [--detach]` and `queue stop`
- Lock held by a live process: `queue: already running (pid <N>)`, exit 0.
- Drain (§3.11) lines, streamed:
  - `building <slug>`
  - `landed <slug> <sha8> (Build <id8>)`
  - `<failed|parked> <slug>: <reason>; best candidate <verdict> at refs/kogen/parked/<run_id> (Build <id8>)`
  - `stopped <slug>: <class>/<reason>; it stays queued (Build <id8>)`
  - `skipped <slug>: environment/approval_branch_mismatch`
  - A refusal at B0 with no run (`approval_invalid`, `build_already_claimed`) prints `stopped` with no `(Build <id8>)` suffix.
- Final line: `queue: nothing to build` · `queue: done; <N> Build(s), <L> landed, <N-L> not` · `queue: stopped on request; <counts>` · `queue: stopped because <slug> hit a <class> error; <counts>` (the article is English: `hit an environment error`). `<N>` counts every Build the drain started or refused, including the stopped one. A drain that only skipped prints `queue: nothing to build`.
- Exit: a drain stopped by a `stopped` Build uses that class (environment 3, provider 4, controller 70). Otherwise 0 when every Build landed or none ran, else 1. `skipped` Intents do not change the exit code.
- `--detach` runs the same drain in a new session, stdin `/dev/null`, output appended to `<state root>/queue.log`. It prints `queue: started in the background (pid <N>)` and `log: <path>`. The pid holds the lock. When it cannot relaunch: `environment/detach_unavailable: --detach needs an installed kogen; run kogen queue start in the background instead`, exit 3.
- `queue stop` writes `stop\n` to `<state root>/queue.stop` when a live drain holds the lock, and prints `queue: stopping after the current Build (pid <N>)`. Otherwise `queue: not running`. Exit 0.

### 1.7.5 `status [<slug>] [--watch] [--json]`
Recovery, then derivation (§2.11). Never fetches. SHOULD finish within 1 s for 50 Intents and 200 runs.
- **Overview:** queue line `Queue: running (pid <N>)` | `Queue: stopped` | `Queue: stopped, <n> waiting; start it with kogen queue start`. When the queue has a next Intent, the next line is `Next: <slug> (priority <n>; no dependencies; ties by approval time and slug)` or `dependencies delivered` in place of `no dependencies`. Then `No Intents.` or sections, only the non-empty ones, in order `Building:`, `Queued:`, `Blocked:`, `Failed:`, `Parked:`, `Interrupted:`, `Drafts:`, `Landed (<total>):`. Rows indent 2 spaces. The slug is padded to the section's longest slug, then two spaces, then the detail. Building: `<stage|starting>[, <elapsed>] (Build <id8>)`. Queued, in queue order: `  <slug>` with no detail. Blocked: the wait reason, for example `waiting for delivered dependencies: <slug>`. Failed, Parked, Interrupted: `<reason|unknown> (Build <id8>)`, by slug. Drafts, by slug: `  <slug>` with no detail. Landed: the 5 newest as `<slug>  <sha8>`, then `  and <k> earlier`. Elapsed is `<s>s` under 60 s, `<m>m` under 1 h, otherwise `<h>h<mm>m`, from the run's `started_at`.
- **Agents,** when any live agent record exists for this project. After the Intent sections:
```
Agents:
  <id> <role> Build=<build> <status> elapsed_ms=<n> <activity>
    events: <path>
```
`<id>` is 32 lowercase hex. The events path is `<run dir>/agents/<id>/events.jsonl`.
- **Slug:** `<slug>: <state>` with `queued, <pos> of <n>` | `building, <stage>[, <elapsed>] (Build <id8>)` | `landed <sha8>` | `draft; review it with kogen intent approve <slug>` | `<failed|parked|interrupted>[, <reason>]`. Then, when a Build exists, these lines and no `verdict:` line:
  - `Build <id8>: <run status>[, <reason>]`
  - `  model time: <stage> <dur>, …` when any stage has model time
  - `  candidate checks (caller approval required): <paths>` when a check proposal exists (§3.7.4)
  - `  setup: reused (saved preparation <ms> ms)` or `  setup: prepared in <ms> ms`
  - `  context continuations: <n> (same approved Build; checkpoints in journal)` when `<n>` is not 0
  - `  gate: <timing>` when gate timing was recorded
  - `  acceptance verified: <ids>` and `  acceptance remaining: <ids>` when acceptance progress exists
  - `  candidate diff: <path>` when any
  - `  journal: <run dir>`
  Unknown slug: `intent/not_found`, exit 2.
- **`--json`:** JSON Lines per Intent, in slug order. Each object has `slug`, `status`, `build_id` (string or null), `landed_sha` (string or null), `priority` (integer), and `blocks_on` (array of slugs). Zero Intents print nothing. Agent rows are extra lines `{"type":"agent", ...}` with the same fields as the text row. With a slug, the Build report (§2.10) is one line and includes `"agents"` when any exist, or the same object when there is no Build. `cache_hit_rate` is on that report (§4.9).
- **`--watch`:** poll every 2 s. Print a full frame only when it changed. Later frames are preceded by a blank line. Return when the queue is stopped, no Intent is building, and no agent is running or waiting. Exit 0, or with a slug exit 0 when landed and 1 otherwise.

### 1.7.6 `provider …`
Login and logout always use the label `default`. They take no `--as`. `use` requires `--as`. Labels match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- `list`: when no profile exists, two lines `chatgpt: not signed in` and `grok: not signed in`. Otherwise one line per saved profile: `<provider>:<label>[ (default)] <signed in|signed out>[ <email>][ expires=<unix>]`. `(default)` is present when that provider is selected and that label is its account default. ChatGPT lines come first, then Grok, each label in sorted order.
- `login chatgpt`: prints `Continue with ChatGPT` and the URL at once, opens the browser, waits for the loopback (§4.6), then on the first success `You're using your ChatGPT plan`, then `chatgpt:default signed in[ (<email>)]`.
- `login grok`: prints `Grok sign-in code: <user_code>` and `Open: <uri>`, waits for the device-code poll (§4.10), then `grok:default signed in[ (<email>)]`.
- `logout chatgpt`: `chatgpt:default signed out`, or `chatgpt:default signed out locally; remote revocation was not confirmed. You can disconnect Kogen in ChatGPT Settings if needed.`
- `logout grok`: `grok:default signed out locally` (Grok logout does not revoke the remote token).
- `use <provider> --as <label> [--project P]`: `<provider>:<label> is the default account` or `<provider>:<label> is the account for <abs P>`. `P` must exist. No saved login: `provider/login: Selected account <label> has no saved login; run kogen provider login <provider> to sign in`, exit 4. A broken accounts file: `environment/invalid_accounts_file: <path> is not valid; fix or delete it`, exit 3.

### 1.7.7 `version`
`kogen <sha8> (<YYYY-MM-DD>)` or `kogen <sha8> (<YYYY-MM-DD>, uncommitted changes)`: the implementation's source commit and its committer date. Works outside any repo.

## 1.8 Signals and deprecations
- SIGTERM exits 143. SIGINT exits 130. No extra text. All child groups are stopped (§5.1). For `queue start`, every running run owned by this process gets `{"event":"interrupted","reason":"sigterm"|"sigint"}`. Recovery later closes it as `failed`, reason `interrupted`.
- A committed `account:` in project.yaml still loads, only when the selected provider is ChatGPT, and only after the machine's project choice. The shape and Build paths print on stderr `kogen: moved: account in .kogen/project.yaml; use kogen provider use chatgpt --as <label> --project <checkout>`.
