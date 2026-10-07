# Worker rules

Read your brief, PLAN.md, QUEUE.md, and frozen spec CLI-RULE.txt before editing.
The spec v1.3-draft e19dd1c is authority; Rust is read-only structure/failure evidence.
The frozen v1.2 suite is read-only. Report exact incompatible old assertions;
never weaken the target, introduce fake-endpoint legacy behavior or claim v1.3 parity.

Own only the brief's allowlist and its docs/work/receipts/<package>.md receipt.
Never edit other packages, root manifests/locks/config, central barrels/composition,
CLI main, xspec registry or native registrations unless your brief explicitly owns
that initial file. Request interface amendments from the coordinator. Prefer direct
imports; production transitions and real effect ports are shared with xspec.
Never touch other worktrees, never merge main, never push. Keep failed worktrees intact.
At 90 active minutes preserve/commit work and request a split; do not lower acceptance.

Use plain `git commit` with the user's normal identity/signing config. Never pass
`-c commit.gpgsign=false`, alter signing config, use --no-gpg-sign, add AI attribution,
coauthor trailers or other invented trailers. Hermetic test fixtures alone set their
own local identity and signing off; product public approval/removal/landing respects
user signing and only normative trailers. A fix worker resolves/continues rebase in
its own worktree, commits normally, then returns to the dispatcher for integration.

Run `GIT_CONFIG_GLOBAL=/dev/null make check`, package local acceptance and exact
conformance commands from the brief. Provision frozen dependencies before checking;
checks never install or use live providers/keychain/credentials. Use fake HTTP and
KOGEN_CREDENTIAL_STORE=file. Port 1455 login cases are serial. No skipping, editing
or automatic retries of official cases; diagnostics use separate receipts.
Missing public wiring is awaiting integration, never accepted from reducer-only tests.
Mandatory xspec slices use full observations, all hand cases and 500 x 25 for each
seed 17/23/41; no --project/no_seam. Diagnostic slices never increase the guaranteed count.

Apply the Rust lessons from PLAN.md:
- Prove a real public R1 Build at I2; production stubs cannot satisfy acceptance.
- Preserve one append-only request context per conversation, raw item bytes,
  sticky routing and run affinity; retries resend identical bytes. Freeze generic
  cross-run prompt/tool prefix before variable metadata. Journal nullable usage.
- Give Shape full schema/examples before its first request, retain rejected bytes
  and exact validation feedback; both audits run even after a ledger gap.
- Resolve every requested/effective role centrally and record provider/model/effort;
  fallback aliases effective shaper. Never claim all Luna from incomplete pins.
- Include owned fake login, injected rejection and concurrent refresh from I2.
- Build anchored safe-fs and supervised process/Git before all writers/checks.
  Trusted metadata, actual Git ignore semantics and saved-base snapshots are mandatory.
- Keep tests independent of host HOME/Git config/signing. Production signing stays real.
- Audits are observational: no demotion, ranking or landing permission; true demotion
  is refused without calibration. Baseline keys always bind the checked base tree.
- Preserve all crashed tracked/untracked nonignored bytes, modes and links durably
  as unverified before cleanup; failed preservation retains work and cleanup_pending.

Receipt/final answer: changed behavior, base/head SHA, exact owned files, active
minutes/model/tokens, make check and exact case pass/fail/instances/unmatched fake
requests, replay hand counts/seeds/first divergence, pending wiring/version/OS gaps
and next owner. Successful worker exit is not integration acceptance.
