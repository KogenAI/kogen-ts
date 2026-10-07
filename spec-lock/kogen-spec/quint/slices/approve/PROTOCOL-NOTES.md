# Event and observation shapes (slice approve)

One adapter request = one `kogen intent approve` invocation, with every input the CLI would read from files, git or child processes supplied by the event. The adapter wraps the pure decision core.

## Events (wire: `{"tag":"Approve","value":{...}}`; the spec also has a unit `Init` used only by `reset`)
`Approve` fields (all required):
| field | type | meaning |
|---|---|---|
| slug | string | intent slug |
| given | string | the `<hash>` CLI argument, `""` = absent (card call) |
| prefixOk | bool | `given` is a prefix of the real approval hash (adapter computes; ignored when given is `""`) |
| stableBeforeCas | bool | a second read immediately before ref CAS still has the card's Intent/test hash |
| newSha8 | string | first eight hex characters from that second read; used in the mismatch line when bytes changed |
| sha, sha8 | string | real approval hash (opaque hex) and its first 8 chars |
| by | string | `--by` value, `""` = absent |
| byBad | bool | `--by` was given but is blank or multi-line |
| ident | string | `git var GIT_AUTHOR_IDENT` as `Name <email>`, `""` = unavailable |
| parseErr, lintErr, lintWarn | bool | parse errors exist / lint errors exist / only style findings exist |
| missing | bool | the acceptance source file does not exist |
| setup | string | `"ok"` or `"failed"` |
| cacheKey | string | opaque key of (base tree, setup, checks, child env) |
| baseline | string | status the configured checks would give if run now: green, red, unavailable, timeout, mutating |
| acceptance | string | `green`, `red`, `timeout`, `tool_missing` (126/127) |
| witnessMode | bool | witness mode is on |
| feas | string | feasibility: `PROVEN`, `PROVEN with concerns`, `UNPROVEN`, `not checked` |
| commit, baseSha | string | id of the approval commit that would be written, resolved base sha (opaque) |

The adapter must make the core compute the baseline only on a cache miss (the `baseline` value is ignored on a hit).

## Observation
```json
{"last":"needs_decision","exit":5,"sha8":"aaaa1111","approver":"Ann <ann@x.io>","feas":"not checked",
 "bwarn":false,"lwarn":false,"ran":true,"checkRuns":1,"cache":"k1",
 "approvals":{"alpha":{"n":1,"sha":"...","by":"...","commit":"c1","base":"b0","feas":"not checked"}}}
```
- `last`: `ok` (approved, exit 0), `needs_decision` (card, exit 5), or an error code string from the prose: `intent/parse`, `intent/lint`, `intent/hash_mismatch`, `intent/unproven`, `intent/approval_identity_unavailable`, `intent/acceptance_missing`, `check/acceptance_check_failed`, `environment/tool_missing`, `environment/setup_failed`, plus `usage` (invalid `--by`). Initial `last` is `ok`, `exit` 0.
- `exit`: process exit code (0,1,2,3,5).
- `sha8`: the sha8 printed (card, approved line, mismatch message); `""` for other refusals. `approver`, `feas`: printed on card/approved, else `""`.
- `bwarn`: red-baseline warning shown; `lwarn`: lint style warnings shown (both false on refusals).
- `ran`: this call really ran the configured checks (cache miss); `checkRuns`: running total of such runs; `cache`: key of the cached baseline (`""` none).
- `approvals`: per slug the latest approval: `n` approval commits written for the slug, `sha`, `by`, `commit`, `base`, `feas`. A refusal or card never changes it.
- Absent strings are `""`. Maps are objects.
