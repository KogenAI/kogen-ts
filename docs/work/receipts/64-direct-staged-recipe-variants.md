# Packet 64 — Direct and staged recipe variants

## Scope and source freeze

- Base SHA: 38297e6139e36dde63777ed5c41c5b7ea9b42c0d.
- Validated implementation head: 8cacaf99d2efbc57e1e8005b7a3e5850e4c77099.
- The receipt is a follow-up commit; final worktree HEAD is reported in the
  worker handoff.
- Target authority: v1.3-draft e19dd1c21c19c5be1201c3b6a42c59c28b5c2887.
  Dependencies 31, 32, 38, 39, and 43 are present in the base ancestry.
- REVIEW-MIDBUILD.md: no remaining finding is assigned directly to packet 64.
  The listed open findings belong to packages 29, 30, 33, 36, 38, 44, and 54.
  No change outside this packet's recipe boundary was needed.

## Behavior implemented

- createDirectRecipePlan admits the four no-plan recipes. Every attempt has
  plan: null and receives the approved Request. Direct variants get the
  existing read, search, edit, write, shell, finish, and tool_output builder
  authorization; shell variants get the existing shell-only authorization.
- direct-escalate and escalate-shell reuse the shared ladder's centrally
  resolved builder profiles (builder, Sol-medium, Sol-high) while keeping all
  attempts planless. runDirectRecipe routes each attempt through the supplied
  shared rung/gate effect and returns every verified candidate so the outer
  Build selector can retain the best candidate. It does not acquire a claim or
  land; those remain with the shared Build controller.
- createStagedRecipePlan resolves context, planner, builder, and reviewer
  roles from the central role table. Context, planner, and reviewer requests
  have no authorized tools; the builder keeps the shell recipe toolset.
- runStagedRecipe calls context before the shared plan/build/gate path and
  calls review only for a green gate-verified candidate, before the caller's
  landing step. The review output is retained as a note and does not change the
  gate verdict or landing eligibility. Claim acquisition/release and landing
  CAS remain caller-owned shared machinery.
- The config/role fake cases load all 12 admitted recipe names and resolve all
  six configured roles. The direct/staged fake-task cases cover direct tool
  sets, escalation, Grok role locality, context → core → review ordering, and
  skipping review on a red gate.

The spec names the staged context and review stages and roles but does not
freeze their prompt or response schemas. This packet leaves those provider
effects to integration. Direct/staged +edge is refused by the recipe
resolvers because the frozen recipe rule admits that suffix for ladder recipes
only; project-schema cleanup for its broader parser acceptance belongs to the
coordinator.

## Verification

- bun --no-install test --max-concurrency 1 ./tests/recipe-variants/recipes.test.ts:
  6 passed, 0 failed, 193 assertions.
- The three fake-task flows invoked 7 fake effects total (2 direct attempts,
  3 staged green-path stages, and 2 staged red-path stages). No HTTP fake
  endpoint was used: 0 provider requests, 0 unmatched requests.
- GIT_CONFIG_GLOBAL=/dev/null make check: PASS, 578 passed, 1 skipped,
  0 failed; 4,592 assertions across 579 tests in 74 files. The skipped case is
  real Linux mounts require Linux user namespaces and bubblewrap on Darwin.
- No B-set is assigned to packet 64. No frozen conformance command was run.
  Consequently no v1.2 assertions were executed or classified as incompatible;
  no v1.2 compatibility or v1.3 conformance claim is made.
- No xspec slice is assigned to this packet. Hand scenarios, generated seeds
  17/23/41, and first-divergence observations were not run.

## Integration and version gaps

- The bootstrap has no executable public CLI. BuildController still invokes
  planning unconditionally and has no context/review hooks, so these recipe
  policies are not wired into a public Build yet. This is local implementation
  evidence only; integration remains pending and is not a pass.
- The coordinator/I6 integrator owns composition and must route direct attempts
  through the shared workspace, gate, selector, claim, and landing machinery;
  staged hooks must be bound around the shared plan/build/gate and pre-landing
  path. The staged provider prompts and response schemas need a common contract
  decision before a live fake-provider mapping is claimed.
- The v1.3 suite is not frozen. Linux behavior is unverified on this macOS
  host; the Linux mount case remains skipped by the hermetic check.
- No incompatible historical assertion was identified, but the frozen suite
  was not run and no assertion is cleared by this receipt.
- Next owner: coordinator/I6 integrator for public composition and full-spec
  recipe integration.

## Source and effort

- Exact changed files:
  - packages/core/src/build/recipes/direct.ts
  - packages/core/src/build/recipes/staged.ts
  - tests/recipe-variants/recipes.test.ts
  - docs/work/receipts/64-direct-staged-recipe-variants.md
- Host: Darwin 25.6.0 arm64 / macOS 26.7.1, Bun 1.4.2, Git 2.54.0.
- Active effort: approximately 7 minutes by elapsed-time/manual estimate,
  excluding unattended check time.
- Model/token telemetry: GPT-6 Codex worker; exact serving sub-variant,
  effort setting, and token count are not exposed to this worker.
