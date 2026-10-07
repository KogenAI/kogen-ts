# Plain-English source: intent approve (verbatim excerpts from the Kogen core spec)

## From 01-cli.md, section 1.5 (exit codes, error lines, subset)
## 1.5 Exit codes and error lines
| Code | Meaning |
|---|---|
| 0 | done |
| 1 | ran; the answer is no (Build not landed, hash mismatch, lint error, red acceptance check, shaping failed, Intent unproven) |
| 2 | usage, moved form, or a request the caller fixes by changing arguments (needs `--force`, not found, untracked, no git identity, unreadable request) |
| 3 | environment (not a git repo, invalid config, toolchain, setup, checkout behind base) |
| 4 | provider (login, usage limit or outage that stopped the drain) |
| 5 | needs a decision; advisory (`intent approve` without a hash) |
| 70 | Kogen bug |

| acceptance source missing | `intent/acceptance_missing: <path> does not exist` | 2 |
| Intent parse errors | `intent/parse: the Intent cannot be read` + `  line <n>: <msg>` | 1 |
| lint errors | `intent/lint: the Intent needs changes` + `  <rule> at line <n>: <msg>` or `  <rule>: <msg>` | 1 |
| hash mismatch | `intent/hash_mismatch: <slug> is now <sha8>, not <prefix>; review it again with kogen intent approve <slug>` | 1 |
| unproven (witness mode) | `intent/unproven: <slug> has no green witness; shape it again or answer its concerns` | 1 |
| no git identity | `intent/approval_identity_unavailable: configure git user.name and user.email` | 2 |
| acceptance check red | `check/acceptance_check_failed: acceptance check <name> failed` (or `timed out`) + ≤ 20 indented lines | 1 |
| tool missing | `environment/tool_missing: <argv0> is not available` | 3 |
| setup failed | `environment/setup_failed: Setup <name> failed (status=<n>, timed_out=<bool>).` + tail | 3 |

### 1.7.2 `intent approve <slug> [<hash>] [--by <name>]`
Hash = **approval hash** = SHA-256 of `intent.md` bytes, a NUL byte, and the acceptance source bytes (§2.1.3). Before the approval ref CAS, re-read both files; a changed hash refuses without replacing an earlier ref.
- **Without hash:** parse, lint (errors → exit 1; style findings are card warnings), read the test, resolve `base_sha` = origin `refs/heads/<base>`, run the approval checks (§3.3), build the manifest (§2.5.2), print the card, exit 5.
- **With hash:** compute the hash **first**; mismatch → `intent/hash_mismatch`, exit 1, nothing run. Then the same steps (reusing the cached baseline, §3.3) and write the approval (§2.5.1); in witness mode an Intent without a PROVEN witness for these bytes and this base → `intent/unproven`, exit 1.

Card:
```
Intent: <slug> — <title>
SHA-256: <64 hex>
Approver: <Name <email> | --by value>
Base: <base> at <base_sha>
Feasibility: <PROVEN|PROVEN with concerns|UNPROVEN|not checked>

Brief
  <Brief lines, indented 2>

Acceptance
  - [A1] <text> (<test|test keep>)

Warnings                                        ← block only when warnings exist, then a blank line
  - <code>: <ids> — <message>
Warning: configured checks are already red on the base:
  - <check>: [<rule>] <path>:<line>: <message>  ← ≤ 5 per check
Hint: fix the base first, or scope the check, e.g. a changed-files format argv.

Approve with:
  kogen intent approve <slug> <sha8>
```
Approved, exit 0: warnings first, then `approved <slug> <sha8> (approval <commit8>); it is queued` and `Next: kogen queue start (does nothing if the queue is already running)`. Approver = `--by` verbatim (non-blank, one line), else `git var GIT_AUTHOR_IDENT` as `Name <email>`. Re-approval writes a new approval commit; no "already approved" message.


## From 02-formats.md, section 2.5.1 (approval commit, subset)
### 2.5.1 Approval commit on `refs/kogen/intents/<slug>` (origin)
- Tree (mode 100644): `intent.md`, `approval.json`, `ledger.json` (when present) under `.kogen/intents/<slug>/`, and the test at `.kogen/acceptance/<slug><ext>`. Parent = previous approval commit or none. Written by CAS (create-only, or `update-ref new old`); a lost race re-reads and retries once.
- Message: `Kogen immutable approval package\n\nKogen-Approval: <slug>\nKogen-Approved-By: <by>\nKogen-Approved-Hash: <approval_sha256>\nKogen-Approved-At: <RFC 3339>`.
- `approval.json` = `{"schema":2,"slug","approval_sha256","intent_sha256","target_branch","base_sha","domains":[s],"acceptance_paths":[s],"protected_manifest":{path:sha256},"check_baseline":[Baseline],"witness":Witness|null,"by","at"}`. Trailers MUST equal the JSON; the hashes MUST match the committed bytes.
- **Baseline** = `{"name","status":"green|red|unavailable|timeout|mutating","exit_status":int|null,"findings":[{"path","rule","symbol","message"}]}`.
- **Witness** (witness mode) = `{"verdict":"PROVEN|PROVEN_WITH_CONCERNS","commit":s,"diff_sha256":s,"base_sha":s}`; the commit is kept at `refs/kogen/witness/<slug>`.

## 3.3 Approval checks
These run in the checkout and its scratch run dir:
1. Setup.
2. Every configured check once, giving a **baseline** row per check: status `green|red|unavailable|timeout|mutating`, exit status, and finding identities.
3. Each acceptance check on the staged test. A red check refuses approval (exit 1); 126/127 → exit 3.
4. Remove the staged file.

The baseline is cached by (base tree, setup, checks, child env), so the card call and the hash call run the checks only once. Red baseline checks warn and never block.
