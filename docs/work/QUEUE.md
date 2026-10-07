# Kogen TypeScript/Bun — ordered worker queue

This is a future dispatch contract, not authorization to create or run the implementation now. Read [PLAN.md](PLAN.md) first. Inputs and command surface stay frozen; source repositories remain read-only.

## Dispatch and acceptance rules

- One **gpt-6-luna / max** worker per packet, in a separate worktree. Maximum 90 minutes of focused effort; preserve work and split any remainder into a new packet. Do not expand an allowlist or lower acceptance to finish a packet.
- IDs sort numerically **among ready packets**. Readiness means every listed dependency commit and applicable integration gate has merged, not merely that another worker started or committed it. Later-numbered dependencies (12→15, 20→23, 22→24, 26→40) are intentional; a dispatcher must use the DAG, not assume line order is execution order.
- `Owned files` are exclusive. A directory ending `/**` includes its tests/data. Brace lists are exact file sets. Add tests only under the packet's named directory. Workers never edit another packet, root manifest/lock/config, central barrel or composition file. Request an interface amendment from the coordinator; the integrator makes it between rounds.
- Root scaffold and contracts initially belong to 00. Central runtime composition belongs to integration rounds: `packages/cli/src/{main,composition}.ts`, `packages/xspec/src/registry.ts`, `native/main.c` registration and explicit contract/Makefile amendments. Package 02 owns `native/main.c` only until first merge. Package 57 owns private protocol/main only; registration belongs to integrator. These transfers are sequential, never simultaneous file ownership.
- Prefer explicit module imports; no shared export barrel per directory. Imports may target dependency-owned files. Register interfaces and test stubs only in test-support, never let a production stub satisfy an oracle case.
- A worker receipt records base/head SHA, exact files, minutes/model/tokens, implementation behavior, `make check`, named local tests, external case results and unresolved dependencies. Every case must have no unmatched fake request. Runtime/OS/helper failures are recorded distinctly from model failures.
- Components with no immediately executable black-box case run their local boundary tests. Their state is **implemented, awaiting integration acceptance** until the closing packet and round turn the assigned cases green. Do not mark all packages done because reducers or mocks pass. Shared cases are rechecked by producing components after wiring; the appendix assigns a single closure owner for accountability.
- Full v1.2 profiles always include the overlay; do not run old replacement IDs as completion evidence. Never edit the external suite or auto-retry official failures. Test with isolated HOME, fake endpoints and `KOGEN_CREDENTIAL_STORE=file`; no live credentials in `make check`.
- For the draft, D1/D2/D3 local regressions below are mandatory immediately. The target is now draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; exact future v1.3 case IDs await the suite owner. `build.auditor_demotion: true` is refused without admitted calibration, so old demotion expectations are version conflicts, with no enabled compatibility toggle. Default remains observational.

`Bnn` means the exact black-box case set assigned to packet nn in the appendix. No B-set means that packet's direct evidence is its named local regression/protocol boundary; final release still tests its integrated behavior. `P1–P13` refer to `spec/CONFORMANCE-v1.2-CASES.md`, not invented external case IDs.

## Packets

Limits include implementation and focused local verification. Full trace generation and whole-suite runs belong to integration rounds; packet owners diagnose any divergence within their scope. Native primitives are split rather than hidden in one process/safety package.

### 00 — Scaffold and input freeze (60 min)

**Dependencies:** none. **Owned files:** `Root manifests/config/Makefile; spec-lock/**; packages/*/package.json; packages/core/src/contracts/{ports,events,errors,clock}.ts; tools/{check,freeze,dispatch}.ts`.

Freeze e19dd1c draft plus working-tree content hashes and CHANGES-v1.3; pin tools/lock; hermetic runner; typed ports. Adapt the Rust dispatch method to a DAG/receipt-aware local dispatcher with dry-run, no automatic push or failed-worktree deletion; integration hooks are completed by the rounds. No behavior stubs may be counted as accepted.

**Acceptance:** Version/blank-HOME/no-network check smoke; source-hash receipt.

### 01 — Public CLI grammar and output data (90 min)

**Dependencies:** 00. **Owned files:** `packages/cli/src/{argv,output}.ts; packages/cli/data/**; tests/cli-boundary/**`.

Fixed moved/tree/options/positional/value precedence, exact help and exits; both provider names. Public parser does not prevalidate slugs.

**Acceptance:** B01; grammar table and byte-exact help.

### 02 — Host bridge feasibility and protocol (90 min)

**Dependencies:** 00. **Owned files:** `native/{main.c,protocol.c,protocol.h,host.h}; packages/core/src/process/host.ts; tests/host-bridge/**`.

Prove bounded binary frames, private pipes/control EOF, fd inheritance, compiled helper lookup on macOS and Linux. Spike parent-kill group cleanup before committing architecture. Shared registration edits transfer to integrator after merge.

**Acceptance:** Kill/pipe/framing spike on both OS; fail design gate if unavailable.

### 03 — Anchored filesystem reads and traversal (90 min)

**Dependencies:** 02. **Owned files:** `native/{paths.c,paths.h,read.c}; packages/core/src/fs/read.ts; tests/fs-read/**`.

Directory-fd traversal, no-follow controller paths, bounded in-root tool link resolution, byte paths; enumerate links as links.

**Acceptance:** Parent-link swap, outside link, nonregular handle, invalid UTF-8 path fixtures.

### 04 — Safe publication, restore and removal (90 min)

**Dependencies:** 03. **Owned files:** `native/{publish.c,publish.h}; packages/core/src/fs/{publish,restore}.ts; tests/fs-publish/**`.

Exclusive temps, mode 0600/0700, append, rename+fsync ordering, no-follow restore/removal; preserve executable and link types.

**Acceptance:** Symlink parents/finals and rename crash matrix; external sentinel unchanged.

### 05 — Native process custody (90 min)

**Dependencies:** 02,04. **Owned files:** `native/{supervisor.c,supervisor.h}; packages/core/src/process/supervise.ts; tests/custody/**`.

Session/group exec, output pumps/tail, monotonic wall deadline, TERM/200ms/KILL, normal-exit grandchildren, parent-death control pipe. Linux subreaper and macOS process identity.

**Acceptance:** B05; real chatty/TERM/grandchild/SIGKILL tests, no argv element >4KiB.

### 06 — Child environment and script transport (75 min)

**Dependencies:** 05. **Owned files:** `packages/core/src/process/{environment,script}.ts; tests/environment/**`.

Allowlisted base environment, exact project override/PATH, mise env timeout and isolated state/cache, private shell scripts and stdin.

**Acceptance:** Host secrets/runtime paths absent; project timeout unscaled; large script bytes preserved.

### 07 — macOS confinement (90 min)

**Dependencies:** 06. **Owned files:** `packages/core/src/sandbox/{policy,macos}.ts; tests/sandbox-macos/**`.

SBPL generation and capability probe; hide secrets, checkout/origin write denial, allowed network/cache paths; warning/off/already-confined semantics.

**Acceptance:** B07 on macOS; real confinement and forced-unavailable integrity fixtures.

### 08 — Linux confinement (90 min)

**Dependencies:** 06. **Owned files:** `packages/core/src/sandbox/linux.ts; tests/sandbox-linux/**`.

bwrap namespace/mount plan, secrets hidden, network allowed, capability probe and equivalent observable fallback.

**Acceptance:** Recheck B07 on Linux; mount and missing-user-namespace tests. No macOS-only acceptance.

### 09 — YAML lexical checks (90 min)

**Dependencies:** 00. **Owned files:** `packages/core/src/yaml/{lex,preflight}.ts; tests/yaml-lex/**`.

Byte cap/UTF-8/BOM/tabs/directives/markers; scalar quoting/comment/escape rules, line and normative error ordering.

**Acceptance:** Normative yaml-errors lexical rows; input-byte boundary tests; B11 closed later.

### 10 — YAML block structure (90 min)

**Dependencies:** 09. **Owned files:** `packages/core/src/yaml/block.ts; tests/yaml-block/**`.

Maps, deeper block sequences, indentation, duplicate/merge/empty values, scalar strings and depth limit.

**Acceptance:** Block/depth/duplicate fixtures; B11 closed by flow/schema integration.

### 11 — YAML flow collections and parser facade (90 min)

**Dependencies:** 09,10. **Owned files:** `packages/core/src/yaml/{flow,parse}.ts; tests/yaml-flow/**`.

Multiline flow maps/lists with quote/comment boundaries; unify earliest error selection and full subset parser.

**Acceptance:** B11; no general YAML acceptance beyond §2.6.

### 12 — Project resolution, schema and every role (90 min)

**Dependencies:** 11,15. **Owned files:** `packages/core/src/project/{resolve,schema,roles}.ts; tests/project/**`.

Canonical checkout/origin/base; closed schema, field-wise role precedence/provider resolution and draft fallback rules; named-role table and config diagnostics.

**Acceptance:** B12; all used roles override/default/provider tests; fallback_shaper remains unknown; cross-provider model refused; auditor_demotion true refused with `build.auditor_demotion has no admitted calibration`.

### 13 — Intent parser and exact-byte hashes (90 min)

**Dependencies:** 11. **Owned files:** `packages/core/src/intent/{parse,hash}.ts; tests/intent-parse/**`.

Required frontmatter/section grammar, Verify forms, slug/lint boundary; preserve raw Request/CRLF/non-UTF8 bytes and Intent-NUL-test SHA256.

**Acceptance:** B13; actual rejected syn-06/syn-20 frontmatter fixtures.

### 14 — Lint, normalization and schema-rich prompts (90 min)

**Dependencies:** 12,13. **Owned files:** `packages/core/src/intent/{lint,normalize}.ts; packages/core/src/shape/prompts.ts; tests/intent-lint/**`.

Normative lint word lists/style thresholds; Notes normalization/Request append; required title/size/domains template, optional keys and A<n>/tag examples.

**Acceptance:** B14; prompt schema fixture parses; no Request lint/normalization damage.

### 15 — Supervised Git port and trusted metadata (90 min)

**Dependencies:** 05,06. **Owned files:** `packages/core/src/git/{command,repository,identity}.ts; tests/git-port/**`.

Bound every Git call and output; explicit argv/stdin; private object-format-aware metadata; suppress hooks/filters/fsmonitor/textconv/config redirection. Separate public identity/signing.

**Acceptance:** B15; SHA1/SHA256, hanging Git/signing child, hostile config smoke.

### 16 — Base-relative trees and Git ignore semantics (90 min)

**Dependencies:** 03,04,15. **Owned files:** `packages/core/src/workspace/{snapshot,ignore,clone}.ts; tests/workspace/**`.

Fresh local no-hardlink clone; snapshot saved base paths regardless of builder HEAD; nested ignore/negation engine through trusted Git, raw index entries and link/mode/deletion handling.

**Acceptance:** B16; tracked-ignored retained, untracked-ignored omitted; non-ignored edits retained.

### 17 — Command adapter and acceptance ledger (90 min)

**Dependencies:** 05,06,16. **Owned files:** `packages/core/src/adapters/{interface,command}.ts; packages/core/src/gate/ledger.ts; tests/ledger/**`.

Source/candidate paths, staging, JSONL rows/tags/items, unavailable/compile/empty/malformed/timeout classifications and tree mutation detection.

**Acceptance:** Ledger exit/report matrix; B18/B20 exercise production callers later.

### 18 — Checks, findings and gate feedback (90 min)

**Dependencies:** 17. **Owned files:** `packages/core/src/gate/{checks,findings,verify,feedback}.ts; tests/gate/**`.

Fix once, checks+acceptance, base-relative excuses and stable identity count; full raw logs/findings and exact clipped feedback. Use frozen policy for contradictory baseline rules.

**Acceptance:** B18; new test symbol, mutating base restoration, unavailable-on-base/current.

### 19 — Protected manifests and restorers (90 min)

**Dependencies:** 12,14,16,18. **Owned files:** `packages/core/src/gate/{manifest,protect,scope}.ts; tests/protection/**`.

Effective gate program paths/globs/absent literals, stale checkout, changes_gate; restore after batches and guard before verify/commit; scope advice only.

**Acceptance:** B19; hostile symlink/type replacements and 4th-restore rule.

### 20 — Approval preflight and card (90 min)

**Dependencies:** 14,17,18,19,23. **Owned files:** `packages/core/src/approval/{preflight,card}.ts; tests/approval-preflight/**`.

Hash-first refusal, stage/setup/check/baseline/card, warnings, red acceptance refusal and always restore scratch. Cache port binds checked tree, using scratch exact-base checks when checkout differs.

**Acceptance:** B20; no check on mismatch and no checkout mutation.

### 21 — Immutable approval commit and CAS (90 min)

**Dependencies:** 20,15. **Owned files:** `packages/core/src/approval/{commit,transition}.ts; tests/approval-ref/**`.

Byte snapshot/manifest/schema2/trailers, identity, late re-read, one lost-CAS retry and parent chain. Production transition exposed for xspec.

**Acceptance:** B21; late Intent/test mutation and two concurrent approvers.

### 22 — Remove lifecycle (75 min)

**Dependencies:** 21,24. **Owned files:** `packages/core/src/approval/remove.ts; tests/remove/**`.

Draft commit of own paths; force/ref CAS/active-build/untracked checks; preserve unrelated user changes and normal identity.

**Acceptance:** B22; active-build case closes after queue integration.

### 23 — Durable run and request journal (90 min)

**Dependencies:** 04. **Owned files:** `packages/core/src/run/{store,journal,transcript}.ts; tests/run-store/**`.

Schema2 plus draft recovery/cleanup-pending fields, append-before-snapshot persistence, landing record ordering, safe logs/diffs, null tokens, per-attempt redacted metadata and timestamp units.

**Acceptance:** B23 after I2; append/rename crash fixtures and redaction checks now.

### 24 — Queue scheduler, claim and ownership (90 min)

**Dependencies:** 12,15,23. **Owned files:** `packages/core/src/queue/{transition,claim,lock}.ts; tests/queue-policy/**`.

Priority/time/slug, dependencies/cycles, per-origin claim, owner PID/start identity, stale locks, once-per-drain and stopped semantics.

**Acceptance:** B24 after I2; deterministic transition and real claim-race smoke now.

### 25 — Status derivation and renderers (90 min)

**Dependencies:** 13,21,23,24. **Owned files:** `packages/core/src/status/{derive,report,render,watch}.ts; tests/status/**`.

Reachable landed precedence, current approval runs, blocked/next/interrupted, all JSON fields/nulls, five-history window, streaming watch. Resolve slug reuse from frozen version.

**Acceptance:** B25; synthetic status and 50-intent/200-run timing now; live watch after I2.

### 26 — Recovery preservation before cleanup (90 min)

**Dependencies:** 16,23,24,40. **Owned files:** `packages/core/src/recovery/{transition,recover}.ts; tests/recovery/**`.

Dead-owner/start-time check; preserve all unsnapshotted workspace trees as create-only unverified recovery refs/archive before removal; persist recovery_preserved/run.json.recovery, adopt complete prior publication, retain differing progress separately, retry terminal cleanup_pending and owner-only release.

**Acceptance:** B26; draft D3 matrix, preservation failure retains workspace.

### 27 — SSE byte framing (75 min)

**Dependencies:** 00. **Owned files:** `packages/core/src/provider/sse/framing.ts; tests/sse-framing/**`.

Chunked CRLF/CR/data lines/comments/DONE/EOF; bounded 16MiB byte accounting and incremental decode.

**Acceptance:** Boundary-split framing corpus; B28 closes assembly behavior later.

### 28 — Responses assembly and nullable usage (90 min)

**Dependencies:** 27. **Owned files:** `packages/core/src/provider/sse/{assemble,usage}.ts; tests/sse-assembly/**`.

Completed precedence, duplicate/error/incomplete/malformed handling; retain raw partial items; validate function arguments, usage counts and no incomplete execution.

**Acceptance:** B28; complete/failure/partial precedence matrix.

### 29 — HTTP, deadline and sticky routing port (90 min)

**Dependencies:** 23,28. **Owned files:** `packages/core/src/provider/http/{transport,deadline,routing}.ts; tests/http/**`.

Streaming fetch, cancellation, first-body-byte starts before auth/connect, idle/total bounds, bounded error bodies, endpoint seams and sticky headers in persistent context.

**Acceptance:** Fake slow headers/body/comment/stall/abort; routing continuity; B33 later.

### 30 — Canonical sessions and wire shapes (90 min)

**Dependencies:** 12,23,29. **Owned files:** `packages/core/src/provider/session/{transition,history,wire,keys,prefix}.ts; tests/session/**`.

Persist run affinity/distinct threads; canonical static controls/input-last immutable items, full schemas+role authorization, owned/injected controls, model-switch reasoning removal, cross-run static prefix.

**Acceptance:** B30; three-turn raw-byte prefix, identical retry, independent Shape/Build prefixes.

### 31 — Read/search/write/edit tool boundary (90 min)

**Dependencies:** 03,04,19,30. **Owned files:** `packages/core/src/provider/tools/{schema,files,dispatch}.ts; tests/file-tools/**`.

Canonical schema union; role allowlists; read lines/search/write limits, approved-path errors and safe in-root links; unknown tools and schema guard.

**Acceptance:** B31; incomplete/partial proposals cannot dispatch.

### 32 — Shell, finish and tool-output budgets (90 min)

**Dependencies:** 06,23,31. **Owned files:** `packages/core/src/provider/tools/{shell,finish,output}.ts; tests/shell-tools/**`.

Private script supervision; UTF8-aware head/tail/ranges/nonUTF8 base64, SHA256 regular-file handles; finish-alone {}, text continuation/first empty finish.

**Acceptance:** B32; 300KiB heredoc, exact notices and full bytes on disk.

### 33 — Retry/wait and stream-continuation policy (90 min)

**Dependencies:** 28,29,30. **Owned files:** `packages/core/src/provider/retry/{transition,respond}.ts; tests/retries/**`.

One versioned retry table, jitter/overload streak/attempt caps/no planner fallback/provider-specific switch; partial progress appended, paused budgets and stopped results.

**Acceptance:** B33; fake-clock matrix and no partial-call execution; public cases close I2/I4/I5.

### 34 — Accounts, selection and file credentials (90 min)

**Dependencies:** 04,11,12. **Owned files:** `packages/core/src/provider/accounts/{select,format,profiles}.ts; packages/core/src/provider/auth/{store,injected}.ts; tests/accounts/**`.

Provider/account precedence, profiles/host UUID, strict accounts YAML atomic serialization; Kogen-only private file store, injected JWT expiry and reread/no refresh.

**Acceptance:** B34; empty both-provider rows, no source-repo credentials.

### 35 — ChatGPT PKCE login and callback (90 min)

**Dependencies:** 29,34. **Owned files:** `packages/core/src/provider/auth/chatgpt/{login,jwks,callback}.ts; tests/chatgpt-login/**`.

Discovery, dynamic registration, PKCE/state/nonce, loopback1455 reuse, scopes/resource, JWKS RS256/issuer/aud/expiry/sub, fresh-registration repair.

**Acceptance:** B35; fake OAuth only; failed callback and back-to-back login.

### 36 — Refresh locks, logout and auth errors (90 min)

**Dependencies:** 33,35. **Owned files:** `packages/core/src/provider/auth/chatgpt/{refresh,logout}.ts; tests/chatgpt-refresh/**`.

Cross-process owner lock/re-read/one refresh/replay, provider-only login outcomes, token rotation, unreadable saved-credential recovery and owned/injected headers.

**Acceptance:** B36; concurrent refresh, injected401 no refresh and bound auth hangs.

### 37 — macOS credential vault (90 min)

**Dependencies:** 02,04,34. **Owned files:** `native/{keychain.c,keychain.h}; packages/core/src/provider/auth/vault.ts; tests/vault/**`.

Security.framework pipe-only key operations and AES256GCM envelope; provider-specific key account; never Keychain under file seam.

**Acceptance:** Mock vault encryption/integrity and seam test in make check; isolated explicit OS-keychain fixture at I6.

### 38 — Public Build skeleton and planner (90 min)

**Dependencies:** 20,21,24,29,30,32,33,34. **Owned files:** `packages/core/src/build/{controller,planner,load}.ts; tests/build-entry/**`.

Wire B0 approval integrity/claim before provider, run/base/setup/base acceptance, one plan/difficulty and roles, happy-path B0-B10 with injected rung/landing ports.

**Acceptance:** B38; real public command binding at I2; tampered approval sends no model request.

### 39 — Develop/verify/repair rung machine (90 min)

**Dependencies:** 18,19,32,38. **Owned files:** `packages/core/src/build/{rung,develop,repair}.ts; tests/rung/**`.

Persistent conversation, finish/text/empty semantics, six repairs/count progress/unchanged/protected restores, final verify/snapshot on turn/wall/budget cap.

**Acceptance:** B39; verified tree identity survives model commits and controller notes.

### 40 — Guarded commit and landing CAS (90 min)

**Dependencies:** 15,16,19,21,23. **Owned files:** `packages/core/src/build/landing/{transition,commit,publish,sync}.ts; tests/landing-cas/**`.

Squash sole parent/verified tree; public signing; durable landing record then incoming/ref CAS; clean checkout race-safe update, dirty warning, nonfatal cleanup.

**Acceptance:** B40; exact parent/tree/record ordering and SHA256 repo crash points.

### 41 — Moved-base landing repairs (90 min)

**Dependencies:** 33,39,40. **Owned files:** `packages/core/src/build/landing/{rebase,retry}.ts; tests/landing-rebase/**`.

Lost CAS/.lock backoff, moved-base rebase/full gate, same winning conversation repairs and separate landing allowance; preserve best if parked.

**Acceptance:** B41; conflicting move, red re-gate and late checkout edit.

### 42 — Queue public handlers, detach and signals (90 min)

**Dependencies:** 01,24,25,38,39,40. **Owned files:** `packages/core/src/queue/drain.ts; packages/cli/src/handlers/{queue,signals}.ts; tests/queue-command/**`.

Bind public start/stop to Build, buffered/streaming output/exits, handshake detach, stop marker, SIGINT/TERM custody and counts. Never mark a reducer-only queue complete.

**Acceptance:** B42; runnable happy Build, signal status and two-checkout ownership.

### 43 — Serial ladder and repeated attempts (90 min)

**Dependencies:** 12,39,41,42. **Owned files:** `packages/core/src/build/{ladder,attempts}.ts; tests/ladder/**`.

Recipe/rung defaults and config, fresh workspace per rung, shared plan/earlier summaries, escalation/repeats, max_rungs/R4 admission, per-rung repair resets.

**Acceptance:** B43; freeze experimental R4/repeat contradictions before tests.

### 44 — Parallel hard rungs and budgets (90 min)

**Dependencies:** 43. **Owned files:** `packages/core/src/build/{parallel,budget}.ts; tests/parallel/**`.

Hard R1/R2 truly concurrent, independent workspaces/conversations, green winner/cancel loser, active wall versus pauses, final snapshot on cancellation.

**Acceptance:** B44; barrier-proven overlap, deterministic ties and stopped member cleanup.

### 45 — Observational audits and deterministic selector (90 min)

**Dependencies:** 18,30,33,43. **Owned files:** `packages/core/src/build/{audit,select}.ts; tests/audit-policy/**`.

Default audit cannot demote/score/land; score real item results and retain best unverified diff. Default land green and legacy green-or-advisory identical; auditor_demotion true refused without calibration; no fake mode or enabled legacy toggle.

**Acceptance:** B45 historical/version conflicts; D1 default safety fixture and experiment-off tests.

### 46 — Separate setup and approval-baseline caches (90 min)

**Dependencies:** 04,12,16,18,20. **Owned files:** `packages/core/src/cache/{setup,baseline,keys}.ts; tests/cache/**`.

Canonical setup products, input stability, CoW/LRU3/atomic complete/no failed hits; v3 baseline `{v,checked_base_tree,setup_key,checks,child_env,toolchain,os,arch,adapter_version}`; unknown identities prohibit reuse, old keys miss.

**Acceptance:** B46; D2 source-only base change reuses setup but reruns checks.

### 47 — Shape conversation loop and accounting (90 min)

**Dependencies:** 14,17,30,31,33,34,46. **Owned files:** `packages/core/src/shape/{controller,conversation,counters}.ts; tests/shape-loop/**`.

One primary RequestContext and one fallback context; shape-v1.3 counter rules (3passes/60turns/2style each), turn OR pass exhaustion starts fallback once, last-turn success, alias effective shaper/provider; schema1 shape-accounting.json on success/failure with separate auditor/HTTP/unknown-usage totals.

**Acceptance:** B47; primary+fallback prefix continuity, no loss of interrupted/controller input.

### 48 — Shape validation, ledger and audits (90 min)

**Dependencies:** 18,19,35,47. **Owned files:** `packages/core/src/shape/{validate,ledger,audit,artifacts}.ts; tests/shape-validation/**`.

Normalize/parse/lint/gate/formatter/staged checks/base red-reclassification; requirement ledger+test audit every eligible pass, coverage repair/warning order and safe artifacts.

**Acceptance:** B48; configured adapter; ledger gap must not suppress test audit; exact feedback journals.

### 49 — Assumptions and shared-contract recheck (75 min)

**Dependencies:** 12,21,38,48. **Owned files:** `packages/core/src/intent/predicates.ts; packages/core/src/build/prestart.ts; tests/predicates/**`.

Validate base predicates on approval; blocks_on landed before Build; observable stale status/recheck event; skip empty predicates and never re-Shape started Build.

**Acceptance:** Local P11/predicate tests; new frozen draft pre-start/status rule, no invented public flag.

### 50 — Optional witness proof and reuse (90 min)

**Dependencies:** 39,44,45,48. **Owned files:** `packages/core/src/shape/witness.ts; packages/core/src/build/witness.ts; tests/witness/**`.

Throwaway R1/hardR2 real gate with no demotion, bounded adjudication/test-vs-witness repair; immutable witness/ref/diff bind; reverify on current base before zero-model landing.

**Acceptance:** B50; proof refused when unproven; stale witness runs normal ladder; narrow to two packets if 90min exceeded.

### 51 — ExUnit adapter (90 min)

**Dependencies:** 17,18. **Owned files:** `packages/core/src/adapters/exunit/**; tests/exunit-adapter/**`.

Source/staging paths, external ledger formatter, mise invocation, failure parsers, formatter selection and unavailable first20-lines rule.

**Acceptance:** Six optional exunit-tier cases plus exact argv/finding fixtures; report separately from236.

### 52 — Rails adapter (90 min)

**Dependencies:** 17,18. **Owned files:** `packages/core/src/adapters/rails/**; tests/rails-adapter/**`.

Two-file detection, command+ledger bridge, ruby syntax/standard/rubocop, offline setup seeds/env/gate paths and Minitest findings.

**Acceptance:** Local P12 and fake argv/ledger fixtures; optional actual Rails fixture receipt.

### 53 — Grok device OAuth and refresh (90 min)

**Dependencies:** 29,34,36. **Owned files:** `packages/core/src/provider/auth/grok/**; tests/grok-auth/**`.

Discovery/endpoint validation, code prompt, first poll delay/pending/slow_down/expiry, stale refresh locks/rotation and local-only logout.

**Acceptance:** Local P10 device/auth fixtures, no borrowed Grok credentials.

### 54 — Grok request/selection integration (90 min)

**Dependencies:** 12,30,33,53. **Owned files:** `packages/core/src/provider/grok/**; tests/grok-wire/**`.

Exact wire/headers/new requestUUID, provider-aware roles/fallback stays Grok, error sentence mapping, same append/usage policy.

**Acceptance:** Local P10 and Grok-pass4; accounts diagnostic at 61; no ChatGPT endpoint fallback.

### 55 — Lite adapter and endpoint capability checks (90 min)

**Dependencies:** 30,34. **Owned files:** `packages/core/src/provider/lite/**; tests/lite/**`.

Injected Luna-only shape/id/header/schema order, owned/cap incompatibilities and rejection before credential load; unchanged affinity vs protocol session ID.

**Acceptance:** Local P6 and unknown endpoint cap fixtures; replay does not infer unsupported capabilities.

### 56 — Opt-in context checkpoints (90 min)

**Dependencies:** 30,33,39. **Owned files:** `packages/core/src/build/checkpoint.ts; tests/checkpoint/**`.

No-tool summarizer epoch, validated continuation marker/size, retained approved bytes/plan/worktree/caps, new checkpoint digest epoch and unchanged affinity.

**Acceptance:** Local P13 and corrupt/empty/oversized stop; no silent turn/budget reset.

### 57 — xspec approval and Intent effects (90 min)

**Dependencies:** 21,22,30. **Owned files:** `packages/xspec/src/{protocol,main}.ts; packages/xspec/src/slices/{approve,intent}.ts; packages/test-support/src/approval-fixture.ts; tests/xspec-approval/**`.

Long-lived reset/apply/error protocol, real source-byte/hash/CAS fixture driver and full observations; document symbolic fixture identities.

**Acceptance:** Mandatory approve+intent hand and seed matrix at I3; late-mutation/no-write real-Git tests.

### 58 — xspec queue and status (75 min)

**Dependencies:** 24,25,57. **Owned files:** `packages/xspec/src/slices/{queue,status}.ts; tests/xspec-queue-status/**`.

Decode events, inject owner/build/ref observations into shared scheduler/deriver; full ordered results, no observation projection.

**Acceptance:** Mandatory queue+status hand/seeds; malformed/unknown protocol nonzero.

### 59 — xspec rebase and recovery (90 min)

**Dependencies:** 26,41,57. **Owned files:** `packages/xspec/src/slices/{rebase,recovery}.ts; packages/test-support/src/landing-fixture.ts; tests/xspec-landing/**`.

Shared controllers, explicit CAS effects plus temp origins, durable crash/preservation effect observations; regenerate draft models externally first.

**Acceptance:** Mandatory rebase+recovery hand/seeds; matches public crash-phase tests.

### 60 — xspec stream and session (75 min)

**Dependencies:** 30,33,57. **Owned files:** `packages/xspec/src/slices/{stream,session}.ts; tests/xspec-provider/**`.

Production retry/session steps, fake clock/outcomes, complete observations plus real wire bytes/headers/nullable usage and fallback reasoning removal.

**Acceptance:** Mandatory stream+session hand/seeds, three-turn/retry/model-switch wire checks.

### 61 — Diagnostic replay adapters (90 min)

**Dependencies:** 45,46,54,57. **Owned files:** `packages/xspec/src/slices/{accounts,gate,orchestration,setup-cache}.ts; tests/xspec-diagnostics/**`.

Thin maps to production policies/effects; current L/E classifications printed into receipts; no legacy resilience/prototype release pass.

**Acceptance:** Diagnostic full observations; unsupported fields explicitly fail; never augment mandatory count.

### 62 — Compiled artifacts and operator docs (75 min)

**Dependencies:** 37,42,50,51,52,54,55,56,61,64,65. **Owned files:** `tools/{build,artifact}.ts; docs/{INSTALL,ARCHITECTURE}.md; tests/compiled/**`.

Native per-OS CLI/xspec/helper builds, helper hash/location manifest, no runtime resolver/download; compiled signals/detach/version and install instructions.

**Acceptance:** Source/compiled equivalent smoke; artifact hashes and clean host prerequisite receipt.

### 63 — Comparison fixtures and measurement tools (90 min)

**Dependencies:** 62. **Owned files:** `tools/{measure,compare,receipt}.ts; docs/COMPARISON.md; tests/comparison/**`.

Frozen task/role/prompt/protocol receipts, fake startup/serialize/Git/CPU/RSS metrics, cache eligible-prefix/raw usage accounting, worker-effort totals. No live dispatch in this packet.

**Acceptance:** Deterministic mock three-arm report; missing usage/infra retained; no invented USD/live gate.

### 64 — Direct/staged recipe variants (90 min)

**Dependencies:** 31,32,38,39,43. **Owned files:** `packages/core/src/build/recipes/{direct,staged}.ts; tests/recipe-variants/**`.

Explicit no-plan/direct tools and unique edit/200-line write, context+review stages/roles and shell recipe variants; same gate/claim/landing machinery.

**Acceptance:** Local all-admitted-recipe config/role/fake-task tests; no change to frozen public tree.

### 65 — Optional edge generation (90 min)

**Dependencies:** 44,45,64. **Owned files:** `packages/core/src/build/edge.ts; tests/edge/**`.

Request-derived optional tests; failure blocks landing; parallel candidates run each other’s edge tests before deterministic selection. Defaults remain off.

**Acceptance:** Local opt-in edge/cross-test fake fixtures; report experimental scope separately.

## Integration rounds and readiness gates

Integration is serialized. Each round is itself bounded at 60–90 minutes; run pre-provisioned automated checks, retain complete receipts, and return implementation repairs as new packets. A full Linux or trace matrix may run unattended after dispatch; do not count its waiting time as active worker effort or declare success before results arrive. All earlier accepted cases remain regression gates. Receipts go to `docs/work/receipts/<round>.md` in the future repository; oracle data/logs go into its dedicated result directory.

| Round | Ready after | Integrator-owned work and gate | Later packets admitted |
| --- | --- | --- | --- |
| I0 — foundation | 00–19 and 23, including out-of-order15 | Compose CLI parsing/project/Intent, native registrations and process/fs/sandbox ports. Hermetic check; syntax/lint/schema/help cases. Native bridge, hostile link and custody boundary smoke on both OS. No unresolved helper architectural failure. | Approval integration; provider modules may develop against merged contracts in parallel. |
| I1 — approval/status | I0 + 20–25 | Register approve/remove/status. Actual CLI card→hash→ref→status→remove; all runnable B20/B21/B22 and synthetic B25; SHA256 ref fixture. Record active-build/watch cases pending I2. Baseline port includes checked tree even before cache optimization. | 38 and42 command-level wiring; no Build packet launched against an unmerged approval API. |
| I2 — first real Build | I1 + 27–36,38–40,42 | Compose provider/tools/rung/green landing and queue; no inert public handler. Green actual fake-provider R1 Build, events/ref cleanup, stop/detach, owned login. B38 happy cases, B05/B07/B15/B16 and B30 wire, plus all now-runnable approval/status cases. Some red ladder cases remain explicitly pending I4. | Full moved-base/recovery/replay acceptance, ladder/Shape orchestration. |
| I3 — safety and guaranteed replay | I2 + 26,41,57–60 | Real crash/moved-base matrix plus all eight G slices, all hand +500×25 for each 17/23/41. No `--project`; no `no_seam`. Bind recovery to status and before every drain. D3 preserve-before-cleanup and post-CAS incoming cleanup; named Build landing/custody cases. | Advanced recipe/parallel/selector acceptance. |
| I4 — complete Build and caches | I3 + 43–46 | Ladder/parallel/budget/audit/selection/cache binding. D1 default audit does not alter gates; D2 baseline key never omits checked tree. All Build/ladder/profile cases and gate feedback that can run without Shape/witness now green or exact draft conflicts. Recheck mandatory affected traces. | Shape/witness default and experiment gates. |
| I5 — Shape and adapters | I4 + 47–52,49 | Register Shape, real command/ExUnit/Rails selection, predicates and witness. Every Shape case, proof/reuse cases, exact progress and card warnings. Primary/fallback raw prefix continuity, malformed-frontmatter regression, all roles pinned fixture. Both audit calls run even after a ledger gap. ExUnit tier reported separately. | Grok/optional backend/full-scope admission. |
| I6 — full common spec and v1.3 reconciliation | I5 + 37,53–56,61,64,65 | Bind Grok/vault/Lite/checkpoint/recipe/edge. Local P1–P13, default-off experiment gates, diagnostic traces. Use committed e19dd1c CHANGES-v1.3 and versioned suite/model follow-ups; retain236-case receipt with conflicts labeled, not silently waived. No v1.3 release claim without its oracle. | Packaging and comparison tooling. |
| I7 — release and comparison admission | I6 + 62,63 | `make check`; compiled-artifact full 236 suite on macOS+Linux with login/no skips and matching implementation SHA; mandatory replay matrix from frozen inputs; finalized v1.3 suite and D1/D2/D3 crash matrix. Record cases/instances/fakes, artifact/toolchain hashes. Prepare feasible cache-smoke protocol and equal Rust/Go admission rules; live runs remain a separate dispatch. | Comparison campaign under frozen rules. |

The gate sequence is I0→I1→I2→I3→I4→I5→I6→I7. Packets38/42 require I1; packets43/44/45/47/48/50 require I2 before their command-level acceptance. Packaging62 requires I6. Other packets may run as soon as their numeric dependencies merge. A packet listed in an earlier round need not turn its not-yet-runnable later case green in that round; its pending closure is explicit. Final I7 has no such exception.

If a readiness dependency changes an interface, invalidate dependent unmerged branches and rebase/recheck. A branch's own `make check` is insufficient for fast-forward admission after another package lands. The coordinator maintains STARTED/COMMITTED/ACCEPTED/FAILED states and actual source SHAs; successful completion of a worker process does not equal integration acceptance.

## v1.3 acceptance additions

These are **local planned tests**, not upstream case IDs. Publish language-neutral versions through the independent spec/suite process and run them against all three arms.

| Label | Closing owner | Required observation |
| --- | --- | --- |
| D1-a |45 | A1 passes, required A2 fails; auditor says over_strict/contradicts. Default gate remains red, A2 not demoted, candidate cannot land. |
| D1-b |45 | Auditor verdict does not change candidate ordering; malformed/duplicate/unknown advice never grants eligibility. auditor_demotion defaults false; true is refused without admitted exact-policy calibration. green-or-advisory cannot weaken the current gate. |
| D1-c |44/45 | Parallel audit order cannot change winner or landing; witness has no demotion. Role/model telemetry agrees with explicit config. |
| D2-a |46 | Same setup_inputs and commands, source-only checked-base change: setup products reused, baseline checks rerun. Subsequent candidate cannot be excused by stale red baseline. |
| D2-b |46 | Exact checked tree/check/env/adapter/toolchain bind baseline key; successful card+hash on same tree reuses it, setup failure never publishes. |
| D3-a |26 | SIGKILL after first model edit before snapshot: recovery preserves regular/untracked/mode/link/deletion state as unverified before deletion. |
| D3-b |26 | Kill during repair and after snapshot publication: later unsnapshotted progress survives; repeated recovery does not clobber refs/diffs or fabricate landed. |
| D3-c |26/40 | Preservation write/ref failure retains workspace and cleanup failure; crash after successful base CAS stays landed, finishes safe incoming cleanup and respects concurrent user checkout edits. |
| Draft Shape counters |47/48 | Turn/pass/style/auditor/transport counters follow shape-v1.3 reset/fallback rules and appear in shape-accounting.json on both success/failure; test primary-turn exhaustion and last-allowance success. |
| Draft provider-aware fallback |12/47/54 | Explicit shaper override honored; fresh fallback on Grok never calls ChatGPT; fallback inherits effective shaper model/effort/provider; explicit fallback_shaper key and cross-provider roles are rejected. |
| Draft cache criterion/static prefix |30/63 | Separate invocations share generic prefix bytes; task metadata occurs afterward; feasible workload requires E/T≥0.95 and observed C/T≥0.95 on designated warm requests; eligible reuse min(C,E)/E separate, zero eligibility inapplicable and unknown telemetry incomplete. |

Historical audit-related cases must be reviewed at minimum across B45, `v1.2-41-build-06`, `v1.2-68-build-44`, `v1.2-70-ladder-02`, `v1.2-86-ladder-18`, `v1.2-92-ladder-24`, `v1.2-95-ladder-27`, `v1.2-97-ladder-29`, `v1.2-98-ladder-30` and witness cases. Some still pass unchanged; inspect actual scripts/assertions before classifying. Removing an expected model request or demotion can change downstream scripted call order even when the case is nominally about a repair cap. List exact failing assertions and required new versioned cases. Do not claim all audit-containing cases are automatically superseded.

## Exact current black-box closure ownership

Inventory generated by reading the clean suite at `0f93bad988fb8d7a8eff4e94954d1db0a046c89d`, including `profiles/v1.2.json`. Each of the **236 active cases appears exactly once** below. Components also recheck their relevant shared cases after integration. Standard profile counts before overlay attribution: cli10, state19, approval23, shape20, build10, provider5, custody5, format7, v1.2 overlay137. Ladder cases all come from the overlay. There are no blanket login skips. Actual IDs, not legacy aliases, must be passed to `--case`.

Use a full profile selection plus `--case '<comma-separated B-set>'` so supersession rules remain active. Per-owner results must be green on the platform being claimed, except explicitly documented v1.3/v1.2 conflicts. Only a matching versioned v1.3 oracle can close those target cases. For an owner without a B-set, local acceptance is mandatory and final integration covers its production route.

### B01 — Public CLI grammar and output data (25 cases)

`cli-10, cli-15, cli-18, cli-19, cli-20, cli-22, format-06, format-09, v1.2-01-fixed-cli-help-and-grok, v1.2-07-cli-03-unknown-command, v1.2-08-cli-04-unknown-subcommand, v1.2-09-cli-05-unknown-option, v1.2-10-cli-06-missing-positionals, v1.2-11-cli-07-unexpected-argument, v1.2-12-cli-08-option-needs-value, v1.2-13-cli-09-boolean-takes-no-value, v1.2-14-cli-11-unknown-provider, v1.2-15-cli-12-watch-with-json, v1.2-16-cli-13-double-dash, v1.2-17-cli-14-options-before-command, v1.2-18-cli-16-short-option, v1.2-19-cli-17-help-bad-topic, v1.2-20-cli-21-invalid-slug, v1.2-21-cli-24-help-after-positionals, v1.2-33-shape-json-is-unsupported`

### B05 — Native process custody (4 cases)

`custody-01, custody-02, custody-03, custody-04`

### B07 — macOS confinement (2 cases)

`v1.2-119-custody-06, v1.2-120-custody-07`

### B11 — YAML flow collections and parser facade (2 cases)

`state-01, v1.2-128-format-05`

### B12 — Project resolution, schema and every role (5 cases)

`cli-23, state-03, state-13, state-16, v1.2-35-state-02-schema-errors`

### B13 — Intent parser and exact-byte hashes (2 cases)

`state-04, state-07`

### B14 — Lint, normalization and schema-rich prompts (6 cases)

`approval-21, format-02, format-03, format-04, state-05, v1.2-36-state-06-lint-card-warnings`

### B15 — Supervised Git port and trusted metadata (1 cases)

`v1.2-122-custody-09`

### B16 — Base-relative trees and Git ignore semantics (2 cases)

`v1.2-123-custody-10, v1.2-64-build-30`

### B18 — Checks, findings and gate feedback (11 cases)

`v1.2-136-format-10, v1.2-45-build-11, v1.2-46-build-12, v1.2-47-build-13, v1.2-48-build-14, v1.2-49-build-15, v1.2-50-build-16, v1.2-51-build-17, v1.2-52-build-18, v1.2-53-build-19, v1.2-54-build-20`

### B19 — Protected manifests and restorers (6 cases)

`approval-14, approval-15, approval-16, v1.2-127-build-10, v1.2-44-build-09, v1.2-55-build-21`

### B20 — Approval preflight and card (13 cases)

`approval-01, approval-03, approval-08, approval-09, approval-10, approval-11, approval-12, approval-13, approval-17, approval-19, approval-20, format-08, state-25`

### B21 — Immutable approval commit and CAS (9 cases)

`approval-02, approval-04, approval-05, approval-06, approval-07, state-08, state-09, state-29, v1.2-02-approval-hash-intent-and-test-bytes`

### B22 — Remove lifecycle (3 cases)

`approval-22, approval-23, approval-24`

### B23 — Durable run and request journal (1 cases)

`v1.2-130-state-11`

### B24 — Queue scheduler, claim and ownership (4 cases)

`build-01, build-32, build-35, build-41`

### B25 — Status derivation and renderers (16 cases)

`cli-28, state-17, state-19, state-24, state-30, v1.2-129-cli-27, v1.2-131-state-12, v1.2-132-state-23, v1.2-137-format-12, v1.2-22-cli-25-status-overview, v1.2-23-cli-26-status-slug, v1.2-25-state-20-status-next, v1.2-26-state-22-status-next, v1.2-27-approval-18-status-next, v1.2-92-ladder-24, v1.2-93-ladder-25`

### B26 — Recovery preservation before cleanup (4 cases)

`build-36, build-37, state-21, v1.2-06-crash-after-base-cas`

### B28 — Responses assembly and nullable usage (4 cases)

`v1.2-108-provider-06, v1.2-109-provider-07, v1.2-110-provider-08, v1.2-111-provider-09`

### B30 — Canonical sessions and wire shapes (8 cases)

`v1.2-03-consecutive-request-byte-prefix, v1.2-04-cache-key-session-headers, v1.2-05-missing-usage, v1.2-104-provider-01, v1.2-105-provider-02, v1.2-106-provider-03, v1.2-107-provider-04, v1.2-117-provider-20`

### B31 — Read/search/write/edit tool boundary (3 cases)

`provider-24, provider-26, v1.2-118-provider-25`

### B32 — Shell, finish and tool-output budgets (2 cases)

`v1.2-121-custody-08, v1.2-31-provider-23-tool-result-budget`

### B33 — Retry/wait and stream-continuation policy (14 cases)

`cli-30, shape-24, shape-25, v1.2-103-ladder-35, v1.2-112-provider-11, v1.2-113-provider-12, v1.2-114-provider-14, v1.2-115-provider-17, v1.2-116-provider-18, v1.2-125-ladder-36, v1.2-28-provider-13-planner-no-fallback, v1.2-29-provider-15-idle-stall, v1.2-30-provider-16-total-cap, v1.2-90-ladder-22`

### B34 — Accounts, selection and file credentials (3 cases)

`provider-19, v1.2-24-state-14-grok-account-row, v1.2-34-format-11-account-selection`

### B35 — ChatGPT PKCE login and callback (1 cases)

`v1.2-32-provider-21-login-flow`

### B36 — Refresh locks, logout and auth errors (2 cases)

`provider-10, provider-22`

### B38 — Public Build skeleton and planner (9 cases)

`build-39, build-40, state-10, v1.2-126-state-15, v1.2-37-build-02, v1.2-38-build-03, v1.2-56-build-22, v1.2-57-build-23, v1.2-69-ladder-01`

### B39 — Develop/verify/repair rung machine (6 cases)

`v1.2-39-build-04, v1.2-40-build-05, v1.2-41-build-06, v1.2-42-build-07, v1.2-43-build-08, v1.2-97-ladder-29`

### B40 — Guarded commit and landing CAS (1 cases)

`v1.2-67-build-43`

### B41 — Moved-base landing repairs (7 cases)

`v1.2-58-build-24, v1.2-59-build-25, v1.2-60-build-26, v1.2-61-build-27, v1.2-62-build-28, v1.2-63-build-29, v1.2-87-ladder-19`

### B42 — Queue public handlers, detach and signals (8 cases)

`build-38, build-42, cli-29, custody-05, state-18, v1.2-124-build-31, v1.2-65-build-33, v1.2-66-build-34`

### B43 — Serial ladder and repeated attempts (11 cases)

`v1.2-102-ladder-34, v1.2-68-build-44, v1.2-70-ladder-02, v1.2-72-ladder-04, v1.2-80-ladder-12, v1.2-88-ladder-20, v1.2-89-ladder-21, v1.2-94-ladder-26, v1.2-95-ladder-27, v1.2-98-ladder-30, v1.2-99-ladder-31`

### B44 — Parallel hard rungs and budgets (2 cases)

`v1.2-71-ladder-03, v1.2-86-ladder-18`

### B45 — Observational audits and deterministic selector (14 cases)

`v1.2-73-ladder-05, v1.2-74-ladder-06, v1.2-75-ladder-07, v1.2-76-ladder-08, v1.2-77-ladder-09, v1.2-78-ladder-10, v1.2-79-ladder-11, v1.2-81-ladder-13, v1.2-82-ladder-14, v1.2-83-ladder-15, v1.2-84-ladder-16, v1.2-85-ladder-17, v1.2-91-ladder-23, v1.2-96-ladder-28`

### B46 — Separate setup and approval-baseline caches (3 cases)

`state-28, v1.2-133-state-26, v1.2-134-state-27`

### B47 — Shape conversation loop and accounting (14 cases)

`format-07, shape-01, shape-03, shape-04, shape-05, shape-06, shape-07, shape-08, shape-09, shape-10, shape-11, shape-12, shape-13, shape-23`

### B48 — Shape validation, ledger and audits (5 cases)

`shape-15, shape-16, shape-17, shape-18, shape-21`

### B50 — Optional witness proof and reuse (3 cases)

`v1.2-100-ladder-32, v1.2-101-ladder-33, v1.2-135-shape-26`

## Private replay closure ownership

| Packet | Mandatory slices | Hand/generation acceptance |
| --- | --- | --- |
|57 |approve, intent |All frozen hand scenarios +500×25 for seeds 17/23/41, real hashing/ref/check effects. |
|58 |queue, status |Same full matrix; ordered queues remain ordered, no projection. |
|59 |rebase, recovery |Same full matrix against finalized models; real Git phase/crash matrix is additional. |
|60 |stream, session |Same full matrix; raw wire prefix/headers/usage are additional to model observations. |
|61 |accounts, gate, orchestration, setup-cache |Diagnostic only per frozen classification; historical resilience/prototype excluded. |

Replay generation and `spec` run on the isolated input-bundle copy. Report actual hand counts after freeze, implementation/adapter SHA, seed/trace/step counts and first divergent event/field. Spec/model revisions must match between Rust, Go and TypeScript.

## Effort and machine budget

66 packets total; individual limits sum to **5,805 minutes /96.75 hours**. Eight integration rounds add 8–12 hours; allow 20–35 hours for repairs and draft/OS reconciliation. The central campaign estimate remains **115–125 worker-hours**, range 94–146 as described in PLAN (limits are caps, not assumed consumption). Coordinator 8–14 hours is separate. Measure active worker effort and unattended test wait separately.

Three concurrent Luna-max workers on the 10-core Studio, one integration lock, initial conformance jobs 3, fake login 1455 serial. Local APFS scratch; 32 GiB RAM preferred; 20–30 GiB free; pinned host tools. Linux runner required. A stopped/failed packet retains branch, logs and worktree; dispatcher does not force-remove it. Worker final answer: changed behavior, source commit, exact validation results, remaining dependency/version gaps, active minutes and next owner.
