# Mac Studio bootstrap receipt — 7 October 2026

Created the main-branch repository scaffold and dispatcher inputs, 66 package briefs,
66 dependency rows, explicit integration readiness gates, worker rules and guide.
No implementation package or release acceptance is claimed. Coordinator starts dispatch.

Read PLAN.md and QUEUE.md fully. Frozen target spec is e19dd1c v1.3-draft plus hashed
working Quint edits; frozen suite is committed v1.2 0f93bad, reference Rust a402540.
The live dirty v1.3 suite checkout and all upstream repositories remained untouched.
The frozen suite inventory is exactly 236 standard cases and 570 expanded instances.
All 236 case IDs appear once across the closure-owner briefs; package 08 additionally
rechecks package 07's two custody cases on Linux. ExUnit's six cases are separate.

Validation:
- `GIT_CONFIG_GLOBAL=/dev/null make check`: PASS, Biome format/lint, strict tsc,
  Bash 3 syntax, all available native units (none yet), four bootstrap tests.
- Fresh `bun install --frozen-lockfile --offline`: PASS, eleven installed packages.
- Blank HOME/minimal environment, network denied with sandbox-exec, explicit pinned
  Bun/Git passed to make: PASS with the same four tests. Test fixture lock identities
  are deterministic because macOS refuses privileged ps inside a sandbox.
- Dry-run: all 66 nodes scheduled in dependency order, MAX=4, no dispatch mutations.
- Extracted integration functions on disposable origins: red check never merges;
  preserves failed worktree; repaired commit rechecks/ff-only merges/removes it;
  real Git rebase conflict preserves work and main; resolved rebase re-merges.
  Actual dispatcher scheduling loop and real worker launcher were never run.

Pinned toolchain/host details and binary hashes: toolchain.lock.json. Declaration-only
skipLibCheck/hoisted-linker rationale: docs/work/decisions/bootstrap.md.
Runtime archive hashes unavailable from old mise caches are explicitly marked; npm
archive SHA-512/native variants are frozen in bun.lock. Bash 3 is the owner's explicit
exception to the reference Bash pin. No global mise config changed. Optional fixture
and Linux tooling remains integration work. Open common-contract/golden migrations
remain packet 00/I6 work and cannot be silently accepted by workers.

The installed `~/cx/kdispatch-ts.sh` matches tools/kdispatch-ts.sh. Logs/state are under
`~/cx/kts/`; dry output is logs/bootstrap-dry-run.txt and its committed receipt copy.
No worker, provider, push, remote or real keychain operation was started.
