# Packet 49 — Assumptions and shared-contract recheck

## Status

The predicate and Build pre-start policies are implemented and locally tested. Approval preflight and the Build controller still need coordinator wiring; this receipt does not claim integrated or public-command acceptance.

- Assigned base SHA: `999a78cde4c4c0dec2f65ff509c468355562075e`.
- Tested implementation head: `824a883a04b31bd6a520a3243a2e863088a6e9dd`.
- Branch: `kts/49-assumptions-and-shared-contract-recheck`.
- Active effort: approximately 22 minutes by session-clock estimate; no dedicated active-time counter is available.
- Model: Codex / GPT-6. Exact serving variant and token usage are not exposed in this session.
- Host: macOS 26.7.1 arm64; Bun 1.4.2; Git 2.54.0.
- Target: frozen `v1.3-draft` input bundle `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.
- Review findings: `docs/work/REVIEW-MIDBUILD.md` assigns no finding to this packet.

## Exact owned files

- `packages/core/src/intent/predicates.ts`
- `packages/core/src/build/prestart.ts`
- `tests/predicates/predicates.test.ts`
- `docs/work/receipts/49-assumptions-and-shared-contract-recheck.md`

The receipt is committed in a documentation-only follow-up; the tested implementation SHA above identifies the code and tests checked below.

## Behavior

- Added shared predicate checks for `assumptions` and `shared_contracts`. Approval validation reads each path through an anchored filesystem port rooted at the caller's exact-base workspace, checks `contains` against raw file bytes, refuses missing/changed/invalid predicates, and skips reads for an empty list.
- Added a Build pre-start policy that reads the approved Intent and exact current base. It checks every `blocks_on` slug against `Kogen-Intent` trailers reachable from that base, then rechecks predicates. An unlanded dependency returns a blocked detail; a missing/changed predicate returns `shaping_stale` fields and a status explanation; a successful check returns `shaping_rechecked` with the base, predicates, and dependency commits.
- Predicate evaluation exposes no Shape/model effect, so this pre-start check cannot start another shaping pass. No public command, option, or flag was added.
- These rules follow frozen spec §3.2.8 and the B4 pre-plan gate in §3.4. Approval preflight must call `validateApprovalPredicates`; the Build controller must call `checkBuildPrestart` before the first planner request and persist its returned event/outcome.

## Checks

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** — 627 passed, 1 Linux-only skip, 0 failed; 628 tests across 81 files and 4,870 assertions. Biome, TypeScript, shell, input-freeze, dispatcher dry run, native compilation, and isolated tests passed. The skipped test requires Linux user namespaces and bubblewrap; this run was on macOS 26.7.1 arm64.
- Named local acceptance: `GIT_CONFIG_GLOBAL=/dev/null bun --no-install test --max-concurrency 1 ./tests/predicates ./tests/queue-policy ./tests/status` — **PASS**, 40 tests / 136 assertions / 0 failures across 5 files. This covers the new predicate and pre-start cases plus the existing P11 queue/status cases.
- Fake HTTP/provider requests: **0 issued, 0 unmatched**. These tests use filesystem and Git fakes only.
- Standard conformance: packet 49 has no owned B-set, so no frozen CLI case was selected. Conformance cases/instances run: **0**. `dist/kogen` and public approval/Build wiring are absent; that is pending integration, not a pass.
- Replay: not assigned to packet 49. Hand cases: **0**; seeds 17/23/41 not run; first divergence: not applicable.
- No exact incompatible v1.2 assertion was identified. No v1.3 parity claim is made because the frozen v1.2 suite has no matching v1.3 predicate overlay.

## Pending integration and next owner

- Coordinator: wire `validateApprovalPredicates` into `approval/preflight.ts` against the exact checked-base scratch, before approval can publish.
- Coordinator: wire `checkBuildPrestart` into `build/controller.ts` after current-base resolution/recheck and before planner/model effects. Persist `shaping_rechecked`; on stale, persist `shaping_stale` and its explanation so status retains it; on unmet `blocks_on`, do not plan or start R1. Re-run approval, Build, queue, and status acceptance after wiring.
- Public CLI/conformance and the v1.3 oracle remain pending integration/release gates. Linux behavior was not run here; one Linux-only make-check case remains skipped on this macOS host.
