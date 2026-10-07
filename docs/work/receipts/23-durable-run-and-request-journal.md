# Packet 23 receipt — durable run and request journal

**Status:** Implemented; awaiting I2 public-command acceptance.

## Source and ownership

- Base SHA: `d35207aeb70e3dd305fdc43dcfd7f25366dcdd61`
- Implementation head SHA: `6111327ac4af6c7605792e67f03b0f502903051b`
- Dependency 04 is present in the base: implementation `ab1839383b4a893e5dea3b9b1dd46f49c5b80741`; receipt `b86114dba11abe1707f09ffe0b63c2510b7efd93`.
- Inputs: frozen v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`; frozen CLI-RULE.txt; v1.2 conformance suite snapshot `0f93bad988fb8d7a8eff4e94954d1db0a046c89d`.
- Owned files changed:
  - `packages/core/src/run/store.ts`
  - `packages/core/src/run/journal.ts`
  - `packages/core/src/run/transcript.ts`
  - `tests/run-store/run-store.test.ts`
  - `docs/work/receipts/23-durable-run-and-request-journal.md`
- Effort: approximately 20 active minutes; estimated, since this session exposes no worker-time telemetry. Model variant/effort and token usage were not exposed, so no Luna/max or token-count claim is made.

## Behavior

- Validates and writes the schema-2 run record, including `recovery` and `cleanup_pending`, exact recovery alternatives, nullable `landing`, SHA-1/SHA-256 object IDs, and millisecond integer fields. JSONL uses stable UTF-8 key ordering and rejects unsafe numbers and incomplete trailing rows.
- Appends each event before atomically replacing `run.json`. Failure results distinguish an unattempted write from an unknown append/rename outcome. `landing_prepared` can gate a supplied base-CAS callback; the callback only runs after the event append and snapshot publication both report success.
- Records one redacted request-attempt row per provider attempt in `transcript.jsonl`: adapter/provider/model/effort, endpoint host and path, header names, opaque cache/thread/conversation IDs, request byte size, prefix digest, start/end/cut duration, resumed state, and nullable token counts. It stores no prompt/body bytes, URL credentials/query, or header values.
- Redacts common credentials in transcript text, command logs, and candidate diffs. Non-UTF-8 logs/diffs are replaced by a length and digest marker. Published log and diff files use mode `0600`.

## Validation

- `bun test --max-concurrency 1 tests/run-store`: **PASS**, 10 tests, 58 assertions. Covers schema defaults, recovery/cleanup fields, append-before-snapshot order, append failure, crash after append before rename, CAS ordering, rename acknowledgement loss, redaction, nullable usage, and timestamp units/ranges.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS**; formatting/lint, TypeScript, native compilation, freeze/dispatch checks, and all repository tests (**168 passed, 0 failed**).
- Required case command: **ERROR**, `v1.2-130-state-11`, 1 instance / 0 pass / 1 error. The runner could not execute the missing `dist/kogen` (`FileNotFoundError`). Its hint reports no request reached the fake provider; unmatched provider requests were therefore not evaluated.
- The frozen v1.2 case also has a version conflict: its `run_json.match` uses `$exact: true` with only `schema`, `run_id`, `slug`, `approval_sha256`, `approval_commit`, `target_branch`, `status`, `landing`, `owner_pid`, `owner_started_ms`, and `started_ms`. The v1.3-draft schema additionally requires `recovery` and `cleanup_pending`. Do not weaken the target to satisfy the old exact-key assertion; a versioned v1.3 oracle is required.
- Replay: not owned by B23; no hand traces or generated seeds were run. Hand count `0`; seeds `17/23/41` not run; first divergence not applicable.

## Pending integration

- The bootstrap has no executable CLI or public Build wiring. I2/coordinator must wire the shared production transitions and build `dist/kogen`; B23 remains unaccepted until the exact named command is rerun after I2.
- Validation ran on macOS 26.7.1 arm64. Linux host behavior and real public command execution remain unverified.
- Next owner: I2 coordinator for public run-store/Build wiring, then the B23 closure owner for the named case and a versioned v1.3 schema case.
