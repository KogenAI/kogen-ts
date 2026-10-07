# Kogen in TypeScript on Bun — implementation plan

Planning snapshot: 7 October 2026. This directory contains plans only. Do not create `kogen-ts`, install tools, run providers, dispatch workers, or modify the spec, suite, Rust checkout or build workflow as part of this planning job.

Build a fresh-process `kogen` CLI and a separate private `kogen-xspec` executable from one TypeScript core. Target macOS Apple silicon and Linux. Use the same frozen contract, prompts, model roles, task fixtures and measurement rules for Rust, Go and TypeScript. Rust is a structural and failure-history reference, never a competing behavioral authority. The detailed dispatch order and acceptance ownership are in [QUEUE.md](QUEUE.md).

## Contract and source freeze

| Input read | Snapshot | How it controls the build |
| --- | --- | --- |
| `~/Areas/Kogen/kogen-spec/CLI-RULE.txt`, `spec/*.md`, normative `spec/data/` | Final read HEAD **`e19dd1c21c19c5be1201c3b6a42c59c28b5c2887` (v1.3-draft)**; initial v1.2 read `1118f7f` | Fixed CLI, observable behavior and data. No added commands or flags. |
| `quint/{CLASSIFICATION,ADAPTER,PLAN-NEXT}.md`, slice models/scenarios/harness | Same HEAD, **dirty working tree** including stream/session/approval/intent changes | Eight mandatory slices; full observations, same production transitions. Freeze actual contents, not HEAD alone. |
| `~/Areas/Kogen/kogen-conformance` | Clean `v1.2`, HEAD `0f93bad988fb8d7a8eff4e94954d1db0a046c89d` | Read-only black-box oracle. Active standard selection contains **236 cases**: 99 surviving old cases + 137 overlay cases. |
| `~/Areas/Kogen/kogen-rs` | HEAD `a402540b39cedc7f788472297add7ae2f8a6631a` | Four-crate boundaries, real effect drivers, integration failures and subsequent repairs. |
| `/tmp/claude-501/krs/*.md`, `/tmp/claude-501/cache-ab/*.md` | Read as local dated evidence | Shape prompt/continuity, cache affinity, role pins, login and safety regressions. Older reports describe earlier binaries. |
| iCloud `careful-rebuild/build/WORKFLOW.md`, `tools/krs-dispatch.sh` | Read through `~/Library/Mobile Documents/com~apple~CloudDocs/Areas/Kogen/` | Isolated worktrees, Luna-max workers, dependencies must be merged, serialized rebase/check/fast-forward integration. |
| `/tmp/claude-501/reviews-astra/SPEC.md`, `/tmp/claude-501/cx/prompts/KSPEC-FIX.md` | Independent review and accepted spec-worker brief | Established the accepted changes before the draft landed during planning; final read includes `kogen-spec/CHANGES-v1.3.md` at `e19dd1c`. |

Before implementation, create an immutable **input bundle inside the future implementation repository**, recording source commit, dirty diff/content hashes, help/constants/lint/YAML corpus hashes, suite supersession manifest, Quint models/scenarios/goldens and adapter protocol. Preserve provenance. Do not rewrite upstream inputs. `CHANGES-v1.3.md` arrived during planning at `e19dd1c`; use that draft revision and update the bundle and trace goldens from it. Its changed approve/gate/recovery/session models still require coordinated scenario/golden migrations; do not pair them with old observations. Use this identical bundle for all three languages. Freeze prompts and effective role tables alongside it for experiments; serializer implementations may differ only within the adapter contract.

Some supplied overview documents still describe the old 244-case suite or six delta cases. The current suite files and `profiles/v1.2.json` define the executable inventory. Run:

```sh
SUITE=/absolute/path/to/frozen/kogen-conformance
"$SUITE/bin/kogen-conformance" run --kogen "$PWD/dist/kogen" \
  --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
  --jobs 3 --time-scale 0.02 --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
```

Here `RESULTS` is a pre-created private absolute result directory. Explicitly selecting `v1.2` is essential: `--profile shape` alone runs old, superseded assertions. `exunit` is a separate six-case stack tier, outside the 236-case denominator; implementing the ExUnit adapter remains in scope. Include login cases, no blanket skips, and record expanded instances as well as cases (the Shape-root report recorded 570 instances at its suite snapshot; calculate the current count). Never retry a failing case into a green official result. Diagnostic reruns get separate receipts.

### v1.3 draft: concrete target and remaining version freeze

1. **Observational auditor by default.** An audit may explain failures or suggest repairs. It cannot demote acceptance, alter candidate ranking or permit landing. `build.land` defaults to `green`; legacy `green-or-advisory` has identical eligibility. `build.auditor_demotion` defaults false and true is refused with `build.auditor_demotion has no admitted calibration` until exact-policy frozen calibration plus prospective confirmation qualify it. No calibration is admitted. Default candidate scores and eligibility use every approved item; `demoted` stays false and advisory items stay empty. Keep the auditor port independent of gate policy; journal observational advice without manufacturing `acceptance_demoted` events.
2. **Approval baseline always binds the checked base tree.** Setup products may reuse a narrowed `setup_inputs` key; check baselines may not. Use distinct typed keys. The canonical v3 baseline material is `{v:3, checked_base_tree, setup_key, checks, child_env, toolchain, os, arch, adapter_version}`. Unknown check-affecting identities prohibit reuse; old keys miss. Check the resolved base tree in scratch when necessary, never record a dirty checkout as that tree. A source-only base change must rerun checks even when setup products hit.
3. **Preserve crashed work before cleanup.** Capture every dead-run workspace with unsnapshotted progress, including untracked non-ignored files, executable modes and symlinks. Publish a create-only `refs/kogen/candidates/<run_id>/recovery-<workspace>` or durable lossless archive/manifest, explicitly unverified, without modifying the source workspace. Record identity/base/workspace in `run.json.recovery` and `recovery_preserved` before cleanup. Adopt a complete preexisting publication after a crash; preserve differing later work under a new identity. Failure retains workspace/refs, records `cleanup_failure` and `cleanup_pending: true`, and retries even for terminal runs. Release the owned claim after recording outcome/preservation. Recovery never overwrites the sole candidate or lands an unverified artifact.

The landed draft also defines **shape-v1.3**: two conversations, each at most three counted validation passes, 60 logical shaper turns and two free style repairs. Primary turn **or** pass exhaustion starts fallback once; valid completion on the last allowance succeeds. Fallback exhaustion exits 1; provider/environment errors do not invoke it. Finish guards spend turns only; retries/continuations spend HTTP attempts within the same logical turn; auditor requests are separately counted and combined validation feedback spends one new pass. Persist schema-1 `shape-accounting.json` in scratch on success and failure, including assigned/effective roles, counters, known tokens, unknown-usage attempts and all-in elapsed time. `fallback_shaper` is an **internal alias of effective shaper/provider/model/effort**, not a configurable role; cross-provider role models are refused. Ordinary Shape still has no total wall. The draft retains ≥95% only for designated requests of a frozen theoretically feasible live replay; static generic instructions/schemas must match across Shapes, Builds and Shape-to-Build. Variable metadata follows. Use run-scoped affinity initially; broader sharing requires separate-session measurements and provider/model/account boundaries.

The current 236-case v1.2 suite expects automatic demotion in several ladder cases. The comparison must have **two labeled receipts**: v1.2 historical compatibility and v1.3 target behavior. The landed draft explicitly refuses demotion true without calibration; it provides **no enabled compatibility toggle**. Report incompatible old assertions as version conflicts; do not weaken the target or claim 236/236 v1.3. Historical Rust v1.2 receipts remain separate evidence; an optional separately versioned v1.2 build is outside the target estimate. Never detect fake endpoints to enable legacy behavior. A versioned v1.3 overlay and regenerated affected Quint observations must be published through the spec/suite owners' process before v1.3 conformance can be claimed. Queue package 45 and integration I6 own reconciliation. The changelog leaves review findings 4/5/8/11–16 open (post-CAS ordering, provider terminal table, serialization/tool_choice, coverage/citations, comparators, schema, provenance); put unresolved choices in the common contract bundle before dispatch, not language-specific worker guesses.

## Toolchain and dependency decisions

Pins are intentional known releases, not floating `latest` requirements. No installation happens now.

| Tool | Pin / policy | Purpose |
| --- | --- | --- |
| Bun | **1.4.2**, runtime and package manager | Run TypeScript, built-in tests, fetch, compilation. Pin in `mise.toml`, `packageManager`, version checks and release receipts. [Release](https://bun.com/blog/bun-v1.4.2). |
| TypeScript | **5.9.3**, dev dependency | `tsc --noEmit`; stable checker baseline, independent of Bun transpilation. [Release](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3). |
| `@types/bun` | **1.4.2** → `bun-types` **1.4.2** | Development declarations matching the runtime. Registry availability verified. |
| `@types/node` | **24.10.1**, override; `undici-types` **7.16.0** override | Prevent Bun's wildcard Node types and their transitive range from drifting. These are declarations, not an HTTP runtime. |
| `@biomejs/biome` | **2.3.11**, dev dependency | One formatter/linter rather than separate ESLint/Prettier trees. [Release](https://github.com/biomejs/biome/releases/tag/@biomejs/biome@2.3.11). |
| Git | **2.54.0** reference host pin; record platform build | All objects/refs/ignore decisions use the CLI. Test SHA-1 and SHA-256 repositories. |
| Python | **3.14.7** reference harness pin | Read-only suite and Quint harness. Runner itself requires only Python stdlib; no pytest/pip. |
| Node / Quint | **24.21.0** / `@informalsystems/quint` **0.33.0** | Replay tooling only; pin the prototype's current `^0.33.0` choice exactly in the input bundle. Node never runs Kogen. |
| C helper | C17; macOS **Apple clang 21.0.0 (clang-2100.3.34.2)**; Linux **LLVM clang 19.1.7** | Native primitives missing from safe standard JS APIs. `-Wall -Wextra -Werror`; libc/POSIX, macOS Security.framework only. Record SDK/linker. |
| Host OS | macOS reference **26.6.2 / 25G83**; Linux target Ubuntu **24.04.3 LTS**, kernel **6.8** baseline | Record Studio's actual OS/SDK before dispatch; the observed macOS pin is this planning host, not a claim about Studio. Linux image/package hashes go into its host receipt. |
| Linux confinement | bubblewrap **0.11.0**, optional system prerequisite | Kernel namespace capability is probed; failed probe becomes specified unconfined mode. [Release](https://github.com/containers/bubblewrap/releases/tag/v0.11.0). |
| Dispatch shell | Bash **5.2.37** reference pin | `mapfile`/arrays needed; macOS `/bin/bash` 3.2 is insufficient. Product wrappers can use POSIX sh. |
| Make / version manager | macOS GNU Make **3.81**, Linux GNU Make **4.4.1**; mise **2026.9.14** | Keep Makefiles portable to the macOS baseline; mise provisions pins outside checks. Record the actual selected binary, not only the shim path. |
| Optional ExUnit fixture tier | Elixir **1.18.4**, Erlang/OTP **27.3.4** | Conservative fixture pins, shared across language arms; independent of Kogen's runtime. Verified release tags: [Elixir](https://github.com/elixir-lang/elixir/releases/tag/v1.18.4), [OTP](https://github.com/erlang/otp/releases/tag/OTP-27.3.4). |
| Optional Rails fixture tier | Ruby **3.4.4**, Bundler **2.6.9**, Rails **8.0.2** | Fixture Gemfile.lock freezes transitive gems; not npm/runtime dependencies of Kogen. Verified releases: [Ruby](https://www.ruby-lang.org/en/news/2025/05/14/ruby-3-4-4-released/), [Bundler](https://rubygems.org/gems/bundler/versions/2.6.9), [Rails](https://rubygems.org/gems/rails/versions/8.0.2). |

Commit text `bun.lock`, exact package versions and overrides. `bun install --frozen-lockfile` is provisioning, separate from `make check`. Record tool archive hashes and native platform variants in `toolchain.lock.json` when the future build is created. Disable runtime auto-install. No runtime npm dependencies are initially required.

The planning host's Bun command currently resolves to an unconfigured mise shim. Provision the selected runtime on the Studio before workers start; this plan does not claim Bun checks have already run. Optional stack versions may change only as a common fixture-version amendment applied to every comparison arm.

| Capability | Choice and justification |
| --- | --- |
| HTTP | Built-in `fetch`, `URL`, `URLSearchParams`, `AbortController`, `ReadableStream`. Stream bytes; no Axios, undici package or OpenAI SDK. Own request bytes, headers, retries and deadlines for the spec's owned/injected/Lite/Grok adapters. [Bun fetch](https://bun.com/docs/runtime/networking/fetch). |
| SSE | Small spec-specific incremental byte parser. EventSource is unsuitable for POST/auth and cannot implement partial-item continuation. Test CR/LF splits, multiline data, partial EOF, duplicate completion, errors and the 16 MiB cap. |
| JSON and hashing | `JSON.parse`, deliberately canonical encoder, `TextDecoder`, `Buffer`, `node:crypto` / WebCrypto. Validate closed input schemas with typed guards; disk JSON readers ignore extra fields as specified. Reject invalid UTF-8 and unsafe integer counts. No Zod/Ajv/JSON library required. |
| YAML | Purpose-built parser for §2.6, split lexical/block/flow work. General YAML parsers admit tags, implicit types and forbidden grammar; a restrictive prefilter is not a proof. Preserve lines and earliest error priority from normative data. |
| Git | Supervised CLI with explicit argv, bounded output, private indexes and sanitized control repository. No libgit2/isomorphic-git/simple-git. Host Git already implements object formats, refs, signing and ignore rules. |
| OAuth/JWT | Built-in HTTP/server, random bytes, SHA-256/base64url, `node:crypto` RSA verification from validated JWKS. Fixed PKCE/device flows; explicitly verify RS256, issuer, audience, expiry, nonce, subject and required scopes. No JWT decode-only shortcut and no inherited agent login. An OAuth framework would add unrelated flow and storage policy. |
| Credentials | Private 0600 files for Linux and the file test seam. macOS AES-256-GCM with key accessed through the native Security.framework helper using pipes. Never pass keys/tokens via `security ... -w <secret>` argv. Grok has its specified service/account names. |
| Processes | `node:child_process.spawn` boots the native helper using pipes and small argv; the helper owns process groups, watchdog, output pumping and reaping. No shell interpolation. [Bun spawn](https://bun.com/docs/runtime/child-process) documents runtime spawning; it does not prove the required SIGKILL/grandchild guarantees. |
| Sandboxing | macOS `/usr/bin/sandbox-exec` with generated private SBPL file; Linux bwrap with read-only host mounts, explicit writable/cache paths, hidden secrets, network allowed. Both behind one port with a real probe. OS capability, not an npm sandbox package. |
| Globs / ignores | Small protected-pattern matcher for the finite specified glob language. Git ignore semantics are delegated to `git check-ignore --no-index -z --stdin` against trusted temporary Git metadata; never substitute glob matching for ignore rules. |
| Tests/build | `bun:test`, `node:assert`, Biome, tsc, C compiler and make. No application framework, database, HTTP server dependency or bundler dependency. |

Adding a runtime dependency later requires a written gap demonstrated by the relevant package spike, a precise version and a revised cost/build-effort receipt. Native helper effort, size and startup overhead belong to the TypeScript arm; call it **TypeScript/Bun with native OS support**, not a pure TypeScript implementation. It must contain no Kogen policy.

## Future repository structure

One private root package with four workspace packages; no public publishing. Preserve Rust's CLI/core/replay/test-support separation without one npm package per module.

```text
kogen-ts/
  package.json  bun.lock  bunfig.toml  tsconfig.json  biome.json  mise.toml
  Makefile  toolchain.lock.json
  spec-lock/                    immutable provenance/data/replay bundle
  packages/core/src/
    contracts/                  typed ports, events, errors, clock; no effects
    yaml/  project/  intent/    strict parsing, schema, roles, lint, hash
    fs/  process/  sandbox/     host bindings, environment and confinement
    git/  workspace/           supervised Git, clean metadata, tree snapshots
    gate/  adapters/           ledger, findings, verification, stack runners
    approval/  run/  cache/     package/ref CAS, journal, separate cache keys
    queue/  status/  recovery/  scheduling, derivation, durable preservation
    provider/                  http, sse, session, retries, tools, auth, accounts
    build/  shape/              production state transitions and effect loops
  packages/cli/src/             argv, output, handlers, composition, signals
  packages/xspec/src/           JSONL protocol; one thin decoder per slice
  packages/test-support/src/    fake clocks/ports/temp Git/oracle fixtures
  native/                      host protocol, safe-fs, supervisor, keychain
  tests/                       owner-specific tests and shared integration tests
  tools/                       check/build/replay/conformance/dispatch/measure
  docs/work/                   worker briefs, queue, receipts, decisions
  dist/                        compiled CLI, private replay, native helper
```

ES modules; `target: ES2023`, `module/moduleResolution: Preserve/Bundler`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, `noEmit`. Only Bun/Node declarations. No `any` outside narrowly reviewed wire decoding. Use built-in `Map`/`Set`, filesystem and crypto APIs rather than utility libraries. A byte string and a decoded UI string are different types. Use byte-order sorting, not locale sorting. Use `Map` or null-prototype records for untrusted keys; canonical JSON recursively sorts UTF-8 keys and retains nulls. Milliseconds and counters must be safe integers; do not silently round oversized JSON values.

Every policy uses explicit event/state/effect types. Examples: `Approval.step`, `Queue.step`, `Rung.step`, `Landing.step`, `Recovery.step`, `Retry.step`, `Session.step`. Effects run through filesystem, process, Git, HTTP, credential, clock and random ports. The public CLI and replay import those same transitions. Merely exposing a replay-only reducer is insufficient: integration must prove the actual command reaches it.

### Rust evidence and changes to the build method

| What was hard in Rust | Evidence read | TS consequence |
| --- | --- | --- |
| Core transitions passed while public queue handlers were unavailable | [INTEGRATION-1.md](/Users/almirsarajcic/Areas/Kogen/kogen-rs/docs/INTEGRATION-1.md), particularly the missing queue/Build dispatcher | I2 must run a real public R1 Build before advanced recipe acceptance; reducers alone never close a packet. |
| Cache-affinity repair required wire, sticky routing and journal changes together | Commit `7725095`; [SHARED-PREFIX-NOTES.md](/tmp/claude-501/cache-ab/SHARED-PREFIX-NOTES.md) | One persistent session context, frozen shared prefix and explicit request receipts; broad prefix experiments can break frozen fake expectations and need versioned migration. |
| Shape reconstructed request contexts and lost continuation state | Commit `2755de6`; [SHAPE-FIX.md](/tmp/claude-501/cache-ab/SHAPE-FIX.md) | Primary/fallback contexts own append-only history, routing and identities across every pass, tool result and stream cut. |
| Models improvised `{}` frontmatter or omitted size because prompt lacked the format | Commit `19040e9`; [SHAPE-ROOT.md](/tmp/claude-501/krs/SHAPE-ROOT.md) | Explicit schema/example before the first model request; preserve exact receiving-pass validation feedback and rejected fixture bytes. |
| Configured auditor role was not honored; an allegedly all-Luna experiment still used Sol | Commit `3b2e8a9`; [SUMMARY.md](/tmp/claude-501/cache-ab/SUMMARY.md), [FAIL-DIAG.md](/tmp/claude-501/cache-ab/FAIL-DIAG.md) | Central role resolver and receipts for every request. Validate acceptance ID/report consistency before comparing model or cache arms. |
| Owned login/refresh and header details remained after a near-green suite | Commit `47558d2`; [CONF-LOGIN.md](/tmp/claude-501/krs/CONF-LOGIN.md) | Include owned fake login, injected rejection and concurrent refresh from I2; never use a blanket login skip in the release denominator. |
| Safety hardening touched 41 files after feature integration | Commit `a402540`, `safe_fs.rs`, `git.rs`, `gate/workspace.rs`, `run/process.rs`, recovery | Safe-fs and supervised process/Git primitives precede every writer, checker, snapshot and landing operation. Test ignore semantics with tracked and untracked paths. |
| Host Git signing/config made checks non-hermetic | Commit `af47e54` and later check receipts | Isolate HOME/global Git config and disable signing only in test fixtures; preserve public signing in production. |

These are read-only historical findings, not newly executed TS or latest-Rust validation. The Shape-root report's 236/236 at its recorded build proves that v1.2 receipt, not the newly landed v1.3 behaviors. The dispatcher's original 15 broad packets needed substantial integration repairs; this queue splits those boundaries and assigns actual command-level closure explicitly.

### Native OS support and first spikes

Keep a small C17 helper, built separately for each host. Protocol: versioned bounded length-prefixed frames with operation and byte fields; content arrives over pipes, never argv. Separate source files own path traversal, publication, supervision and Keychain operations. Reject unknown operations. It has no model roles, approval rules, queue state or landing choices. Bound buffers, descriptors, paths and syscall errors. Package 02 proves framing, compiled discovery, SIGKILL watchdog and fd support before dependent work.

Safe filesystem operations anchor at opened canonical roots. Walk using directory fds and `openat`/`fstatat` with no-follow flags; forbid traversal escapes. Controller outputs reject symlink components/final links. Model tools resolve allowed in-root links with bounded link resolution and then operate through anchored descriptors; outside links fail. Snapshot reads preserve link target bytes as links, never recursively follow them. Protect run files, scripts, ledgers, credential dirs, cache markers, candidate diffs, approval scratch and restored manifest paths. `realpath` followed by an ordinary `writeFile` leaves a race and is insufficient. Atomically replace from an exclusive same-directory temp file, fsync before rename and fsync the parent at durable publication boundaries. Stop model children before taking an authoritative verification/publication snapshot.

The supervisor forks/execs the child into a new session/group. A separate inherited **control pipe** remains owned only by Kogen and the helper; close-on-exec in children prevents grandchildren keeping it alive. EOF detects parent death even after SIGKILL. It logs full stdout/stderr without buffering unbounded text, enforces wall deadlines independently of output, sends group TERM, waits 200 ms, sends KILL and reaps. Clean residual grandchildren after a normal leader exit. Linux uses subreaper facilities where available; macOS tracks/reaps its children and kills the group. Test the spec's group-based cases plus escaped-session risk explicitly; do not claim universal descendant confinement from group killing alone. A failed native prerequisite is an installation failure, distinct from unavailable **sandbox confinement**.

All subprocesses, **including controller Git, mise, browser opener and credential helper operations**, have deadlines and bounded output. The only direct spawn sites bootstrap the helper and an intentional detached queue owner. Long model shell commands use private 0600 scripts; commit messages use stdin/private files; each argv element is at most 4 KiB. Detach has a startup handshake and transfers ownership to the drain's own supervisor before the caller exits.

## Behavior to implement from day one

**Prompt and session construction.** Freeze generic instructions and the full canonical tool-schema list once per adapter/prompt version. Place variable task/role data after the common prefix. Use role allowlists even when all schemas are present; tool-less roles send the defined `none` control. Build each conversation once and append canonical immutable item bytes. The wire builder accepts the frozen schema list through its port; tool definitions/dispatch have one owner (packet 31), avoiding a session↔tool registration dependency. Keep controller-added interrupted-progress and repair notes, raw reasoning/assistant items, then call-id results, then user notes. Identical retries reuse body bytes. With input last, the old body minus final `]}` prefixes an appended body and the next byte is comma. A model switch retains thread identity, drops prior encrypted reasoning and intentionally changes controls. A checkpoint changes epoch/thread, preserves cache affinity/worktree/approval/counters, and requires the exact continuation marker.

Persist one safe opaque run cache key and distinct `(stage, attempt, rung, epoch)` thread identity. Sticky routing from responses belongs to that persistent request context; do not rebuild it every Shape turn. Record adapter/endpoint host+path, header names, key/thread, body size, prefix hashes, per-attempt start/end, cut/resumed and nullable usage without secrets or prompt text. Keep Shape and Build totals separate. Run-scoped affinity remains a permitted initial choice; shared affinity is deferred until measured. Static prompt bytes are cross-run stable regardless.

**Intent schema in the shaper prompt.** Supply actual frontmatter with required `title`, `size: small|medium|large`, `domains: [configured-name]`, allowed optional keys and section examples. Show matching `A<n>` Acceptance/Verify and adapter-specific test tags. Show limits, Notes `Approach:` and gate declaration rules. Required title cannot be replaced with a body heading. Preserve the exact first-message template and verbatim request bytes. Do not add `## Request` twice. Journal exact validation feedback to the receiving pass. Prompt changes are versioned and shared across implementation arms.

**Every model role resolved explicitly.** One resolver implements project > machine > defaults, field-wise merge, provider restrictions and finalized fallback rules. It covers builder, planner, shaper, auditor, reviewer, context and any draft-admitted rung roles; the fallback alias cannot appear as an accepted user role. Both requirement and test audits use the resolved auditor. Record requested and effective model/effort/provider. Never claim “all Luna” when an unpinned auditor remains Sol. Default roles are the spec's roles; smoke/benchmark role tables explicitly pin every used role, fallback, recipe/rungs and provider. No hidden hard-coded override after resolution.

**Git safety and tree identity.** Use a controller-owned metadata repository/private indexes outside model-writable locations, with explicit object format and sanitized config. Never trust builder `.git/config`, `.git/info/exclude`, filters, textconv, fsmonitor, hooks, templates or object-store redirection. Snapshot against the saved build base, regardless of builder HEAD/index/commits; preserve deletion, rename, mode and link behavior. Enumerate filesystem bytes safely, run trusted Git ignore logic against current nested `.gitignore` files, retain base-tracked paths even if now ignored, include untracked non-ignored files, hash with `--no-filters`, build the tree by NUL-framed index input. Keep protected globs separate from ignores. A shortcut that captures every untracked cache product is incorrect.

Use user's real identity/signing for public approval/removal/landing operations, no hooks and only normative trailers. Private snapshot commits may use isolated controller identity/config. Signing can start subprocesses, so remains supervised and may require an OS integration fixture. Hermetic tests disable signing only in their temporary Git config; production does not disable it. Handle 40/64-character Git IDs without assumptions.

**Publication and recovery.** Re-read approved Intent/test bytes immediately before approval CAS; mismatch initially runs no checks. Claim serially per origin. Landing persists expected parent, candidate and verified tree before incoming push/base CAS. Move base only via CAS; a lost CAS or moved base triggers rebase/full gate/allowance-bounded repair. Verify the final tree and sole parent immediately before publication. After CAS, outcome stays landed; cleanup/synchronization errors cannot downgrade it. Synchronize clean checkouts race-safely and retain dirty user edits with the specified warning. Recover partial journal/run.json writes using a frozen ordering rule, not ad-hoc newest-file guesses. Capture crashed progress before cleanup under v1.3, including landed runs with later workspace progress; terminal cleanup_pending runs are retried without changing their recorded outcome.

**Build persistence.** No re-plan or return to Shape after startup. Implement green core first, then actual ladder, parallel hard rungs, best-candidate retention and stopped-vs-failed drain behavior. All gates, commands and timers use the same process/clock ports. Resolve the existing §3/§4 provider-terminal and budget contradictions at input freeze; centralize one table thereafter. Partial/incomplete streams never execute proposed tools. Request wall, first byte (body, not headers), idle and transport are distinct observations.

**Stack adapters.** Command is first, then ExUnit and Rails. They share staging/restore, runner classification, report validation, tree mutation guard and findings. Shape must choose the configured/detected adapter, never hard-code an extension or generic command runner. ExUnit formatting code is adapter data, not a dependency of the TypeScript core. Rails discovery uses both required files. Witness and edge remain explicit optional settings but must be built if claimed in the common full-spec arm.

## Replay and verification

`kogen-xspec <slice>` is a private entrypoint, never a public subcommand. One long-lived process reads one UTF-8 JSON line and writes exactly one JSON observation line for each request. `reset` returns full initial observation; `apply` decodes the slice event and calls production policy plus injected effect results. Invalid JSON/tags/schema terminate nonzero with diagnostics on stderr. EOF cleans temporary fixtures. No credentials, real checkout or network are implicit replay inputs.

Mandatory slices: **approve, intent, queue, status, recovery, rebase, stream, session**. For each run all hand scenarios from the frozen bundle and **500 traces × 25 steps for each seed 17, 23, 41**. Store seed-separated generation outputs. Regenerate matching goldens from the committed v1.3 models plus explicitly frozen existing working edits for approve/recovery/session and diagnostic gate changes. Current observed hand counts are approve 18, intent 7 (new seventh scenario untracked), queue 9, status 8, recovery 5, rebase 7, session 7, stream 11 (the 11th stream scenario is uncommitted); recount after freeze. Whole gate/orchestration/accounts/setup-cache slices are diagnostic under CLASSIFICATION; historical resilience and prototype landing are not release evidence. Classification does not waive ladder/shape black-box cases for the full implementation comparison.

Use the existing Python harness from an isolated bundle copy so `spec`/`gen` never write the read-only source repo. Example, with working directory the copied `quint/prototype`:

```sh
XSPEC_SLICE=../slices/queue python3 -B harness/xspec.py spec
XSPEC_SLICE=../slices/queue python3 -B harness/xspec.py gen --traces 500 --steps 25 --seed 17
XSPEC_SLICE=../slices/queue python3 -B harness/xspec.py conform -- /absolute/dist/kogen-xspec queue
```

The adapter maps observations only. Approval/Intent fixtures compute hashes from actual bytes and use temporary origins for real refs/CAS/check counts. Where models use symbolic hashes, document a reversible fixture mapping from symbolic content identity to real digest; never manufacture `prefixOk` from expected output or the event's claimed hash alone. A late-source-change event changes fixture bytes and the production second read catches it. Landing/recovery inject actual effect outcomes into shared reducers and run separate temporary-Git crash matrices. `--project`, dropped fields, `no_seam` and unsupported slices cannot count as passes.

`make check` is hermetic and local: verify tool versions; Biome check; tsc; compile native code with warnings as errors; run bounded Bun/native tests in fresh HOME/TMPDIR with an explicit nonsecret PATH, empty machine state, fixed locale/TZ, temporary Git identity, signing off, hooks off and `GIT_CONFIG_NOSYSTEM=1`. No installs/network/real keychain/machine mise settings/live provider. Resource-related tests run serially and use the fake HTTP server/file credential seam. Parent-death tests are real subprocess tests, not only fake clock tests. `make conformance` and `make replay` are explicit additional targets and produce receipts; no hidden exemption for a failing package.

Release artifacts: compile CLI and replay from the same revision via `bun build --compile` for the native target; ship the helper beside them with verified path/version/hash. Build native Linux on Linux and native macOS on macOS. A compiled CLI avoids dependency resolution and an external runtime requirement. Test compiled, not only source-run, signal handling, helper discovery and detach. [Bun executable packaging](https://bun.com/docs/bundler/executables). Do not enable bytecode/minification performance experiments before conformance. Wrappers suffice during integration.

## Worker dispatch, resources and effort

Reuse the Rust dispatch **method**, not its scripts unchanged. Future dispatcher reads the structured queue, starts only packages whose dependency commits and required integration gates have merged, assigns a clean worktree/branch, file allowlist and fake ports, and runs `gpt-6-luna` at `max`. Workers commit locally and never merge/push. Serialized integration rebases, checks the file allowlist, runs hermetic check and named oracle cases, then fast-forwards with base/commit CAS. No auto-install, push or resetting dirty checkouts. Integrator alone owns central composition/handler registration and changes approved interfaces between rounds. Do not use `pgrep` as authoritative completion, delete failed worktrees automatically, or repeatedly retry test failures. Track worker PID/start identity, outcome, commit, dependencies, measured effort and persistent receipts.

The queue has **66 bounded implementation packages**, nominally 60–90 minutes each, plus eight 60–90 minute integration rounds. This is a task sizing target, not a guarantee that any worker finishes a safety subsystem in one attempt. If a packet hits 90 minutes, preserve its branch/receipt and split its remaining acceptance into a new packet with new files; do not silently extend the worker or lower acceptance. Package 02 can require a design amendment if the chosen helper/runtime bridge fails.

| Effort component | Planning estimate |
| --- | --- |
| Package implementation/check effort | 66–99 worker-hours; central estimate ~80 |
| Eight integration rounds | 8–12 worker-hours; central estimate ~10 |
| Expected rework, v1.3 reconciliation and OS failures | 20–35 worker-hours |
| **Full scope estimate** | **94–146 worker-hours; plan around 115–125** |
| Coordinator preparation/review/reporting | Additional 8–14 hours; record separately |
| Live comparison and cache evidence | Separate experimental budget; not hidden in implementation hours |

On the **10-core Studio**, start at **three concurrent Luna-max workers** (Rust dispatcher default was three), one serialized integration/check job, and at most three black-box jobs while workers are active. Model waiting often dominates, but native compilation, cloning and subprocess tests still contend. Increase to four only after measured RSS/load and custody timing remain stable. Do not copy the workflow's 10-worker Campfire setting or its load-average <40 threshold onto a 10-core host. Rough elapsed build campaign: 4–6 working days with three workers and long integration chains, excluding provider waits and benchmark scheduling; worker-hours are the comparison metric.

Studio needs local APFS scratch outside iCloud, ~20–30 GiB free disk for worktrees/logs/caches (larger task fixtures measured separately), ideally **32 GiB RAM** (16 GiB: start with two workers), Xcode Command Line Tools, pinned Bun/Git/Python/Quint/Bash, and billing worker execution access. Product tests use fake credentials. A Linux machine/VM with 4–8 vCPU, 8–16 GiB RAM and namespace-enabled kernel is required for Linux parity; macOS bwrap emulation is no substitute. Do not repurpose or occupy benchmark hosts during controlled grade windows. Port 1455 login cases are serial; allocate other fake ports per worker. Capture baseline CPU/RAM/OS/disk and throttle by observations, not core count alone.

## Comparison after implementation

Freeze a comparison protocol before scoring. Admit each language arm using the same spec/suite revisions, host-specific conformance gates, mandatory replay matrix and role/prompt fixtures. Compare Rust/Go/TypeScript **at the same contract version**; current Rust must receive the same v1.3 fixes before comparison. Report historical compatibility separately. Any incomplete scope becomes a labeled gap rather than a changed denominator.

1. **Conformance:** per-profile cases and instances, errors/skips/unmatched requests, first failing assertion, mandatory full-observation traces, platform, source/artifact SHA, protocol/input bundle hashes. Include added v1.3 safety cases and a fault-injection matrix for durable writes/ref moves/crashes. No combined score disguises missing Linux coverage.
2. **Real tasks:** preselect fixed task/fixture commits, graders, time limits, model/provider/effort per role, recipe/rung/fallback policy, concurrency and repeats. Randomize paired arm order on the same host; use enough repeated trials to expose model variance. Measure Shape yield separately and Shape→approval→Build success on the full task denominator; also report Build success conditional on admitted identical approvals. Grade independently of Kogen's audit/landing verdict. Retain infra/interrupted/failure counts and paired task-level outcomes. Start with small admission tasks (Intent format, tool edits, repairs, moved base, long context) before broader rounds. No live runs in this planning job.
3. **Cost:** uncached input, cached input, output, reasoning, nullable/missing telemetry, calls/retries/pauses by stage and total. Apply one frozen pricing schedule if reporting equivalent USD; subscription consumption is not an inferred bill. Shape is included in end-to-end cost, separately excluded from the spec's Build cache rate. Record model switches and auditor roles. Report cost per attempted task and successful task with the denominator visible.
4. **Speed:** paired end-to-end and Shape/Build time, active time versus pauses, cold CLI startup/status, SSE parse/serialize, Git/tree and helper overhead, peak RSS/CPU, clean/incremental build and `make check` time. Run deterministic fake-provider microbenchmarks separately from model latency. Do not compare raw Mac timings to Linux timings as language effects.
5. **Build effort:** actual worker active hours, wall hours, worker model/effort, tokens/cost, package retries, rebase/integration failures, coordinator hours, dependency/native code footprint and time to first runnable happy path/full host parity. Record inherited Rust reference knowledge and already-built Rust status; a new TS build versus historic Rust includes order/learning confounding.

Caching evidence has two layers: deterministic request replay/prefix/affinity checks, and a **frozen feasible live workload** under the draft's defined release criterion. Record eligible repeated-prefix length, appended content, block/minimum assumptions, model/endpoint/retention, request gaps, each warm numerator/denominator, raw weighted rate and missing-usage count. `4096/(4096+1000) = 80.4%` even with complete previous-prefix reuse; the old universal >95% rule is not a general workload guarantee. Preserve the owner threshold only on its finalized feasible smoke, and require theoretical `E_i/T_i ≥0.95` plus observed `C_i/T_i ≥0.95` for each designated warm request. Report `min(C_i,E_i)/E_i` as a separate diagnostic when eligibility is known and positive. Missing usage means incomplete measurement, not demonstrated cache reuse. The cache-ab reports show that stable bytes alone do not guarantee live hits or real-task success.

## Main risks and mitigations

| Risk | Mitigation / release evidence |
| --- | --- |
| Draft not frozen; current prose/suite/model contradictions | Bundle exact inputs; explicit three-fix tests; suite-owner follow-ups; versioned receipts. Draft demotion refusal and fallback alias are explicit; remaining schema ambiguities need common resolution. |
| Native shim grows into another implementation | Only OS primitives, per-file owners and protocol; measure all its effort/size; review safety boundaries before higher-level use. |
| Bun compatibility, compiled helper/pipe behavior, GC stalls | Early host spike and compiled subprocess smoke; bounded data, monotonic deadlines, native custody; pin runtime; measure status <1 s target separately. |
| TOCTOU and symlink restoration/publication | Directory-fd primitives, stopped writers before snapshots, hostile parent/link swap tests; no unchecked convenience writes. |
| Ignore/config/filter divergence and SHA-256 repositories | Trusted metadata + actual Git ignore engine; raw byte paths; adversarial workspace and object-format tests. |
| False auditor advice changes acceptance indirectly | Advice cannot mutate score or gate; no default demotion; external grader and failing-item fixtures; witness never demotes. |
| Crash recovery or partial journal loses sole candidate | Preserve-before-cleanup and idempotence tests; durable record-before-CAS; retain workspace on preservation failure. |
| macOS sandbox deprecation / Linux user namespaces unavailable | Real capability probe and observable unconfined fallback; checkout/origin integrity detection; both OS custody receipts. |
| Prompt/cache optimization masks role or acceptance changes | Freeze every role/prompt/adapter; preserve raw fake request assertions; live evidence separate; no all-Luna label without full pins. |
| Small worker packets still overrun complex tasks | 90-minute checkpoint/split rule, measured receipts, 20–35-hour reserve; no worker marked done before command-level acceptance. |
| Full optional recipe coverage underestimated | Command/green core first; separately budget witness/Grok/Lite/checkpoint/direct/staged/edge packets; list unverified features explicitly. |

Implementation release is a recorded outcome of the gates, not this plan. Planning deliverables are only this document and the executable work breakdown in `QUEUE.md`.
