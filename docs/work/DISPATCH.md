# Dispatcher operation

The installed dispatcher is `~/cx/kdispatch-ts.sh`; its versioned source is
`tools/kdispatch-ts.sh`. Both use macOS `/bin/bash` 3.2 features only.
Start in the foreground: `MAX=4 ~/cx/kdispatch-ts.sh`. The coordinator starts it.
`DRY_RUN=1 ~/cx/kdispatch-ts.sh` prints a DAG simulation and never starts workers,
creates worktrees, or writes dispatcher state. MAX defaults to 4 by owner request;
PLAN recommends starting at 3 when measuring Studio load (`MAX=3` is supported).

State/events, attempt logs, copied runner logs and prompts live under `~/cx/kts/`.
Implementation workers run `~/cx/run.sh KTS-<package> <worktree> <prompt> gpt-6-luna max`.
Worktrees are `~/Areas/Kogen/kogen-ts-wt/<package>` on `kts/<package>`.
Numeric dependency IDs match the Rust queue format; the TS graph has 66 packets,
not Rust's older 15. Only MERGED dependencies are ready. Packet 00 still owns full
contracts/freeze reconciliation; this bootstrap is not its implementation acceptance.

Worker completion uses a tracked PID/start identity and an atomic result file.
The launcher masks Codex's exit status; the dispatcher reads its final `exit=` line
and copies its logs. No `pgrep` completion heuristic. Successful process exit alone
cannot merge an empty branch. A serialized mkdir lock protects scope validation,
rebase on main, `GIT_CONFIG_GLOBAL=/dev/null make check`, a main-SHA recheck and
`git merge --ff-only`. Checks never provision. A new worktree is provisioned using
`bun install --frozen-lockfile --offline` before its worker starts.

Conflicts/check/scope failures record FAILED and retain branch, worktree and logs.
One fix worker (same model/effort) resolves/continues the rebase, repairs owned files,
checks and commits; the dispatcher revalidates and merges. `MAX_FIXES` defaults to 1.
Further failure stops that package for the coordinator; no repeated test retries.
Merged clean worktrees are removed without --force; retained branches preserve SHAs.
Cleanup failures remain MERGED with cleanup.pending rather than losing dependency state.
SIGINT/TERM stops the dispatcher; already launched workers keep their isolated worktrees
and completion records. Restart with the same command to collect/recheck them.
Incomplete lock publication requires coordinator inspection; never blindly delete a
lock or worktree. Review stale PID/start identities before repairing incomplete locks.

Integration gates are not automatic acceptance from module unit tests. GATES.txt and
INTEGRATION.txt retain I0–I7 from QUEUE.md. At a gate the dispatcher eventually stops
BLOCKED once no independent work is ready. The coordinator performs the round, commits
`docs/work/receipts/I<n>.md` on main with actual checks/cases and source SHAs, then runs:

```sh
~/cx/kdispatch-ts.sh --accept-gate I0 <the-main-commit-containing-the-receipt>
MAX=4 ~/cx/kdispatch-ts.sh
```

Gate acceptance verifies prior gates, required MERGED packages and the committed receipt.
A gate SHA must remain an ancestor of main. Record interface amendments/dependent branch
invalidations in those receipts before resuming. I7 is coordinator-owned after all 66
packages merge; package completion is not a release claim. Version conflicts, missing
Linux validation and affected draft goldens remain explicit in every round.

The dispatcher never pushes or resets checkouts. Workers and fix workers never merge;
the dispatcher integrates serially. Coordinator composition/registry/native registration
work belongs to integration rounds. Provision optional fixture tools separately before
admitting their OS/stack acceptance. Real keychain and live experiments are not bootstrapped.
