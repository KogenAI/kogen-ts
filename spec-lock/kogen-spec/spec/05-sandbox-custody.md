# 5. Process custody, environment, sandbox, workspaces

This section specifies behaviour only; how each OS achieves it is the implementer's choice (§6). Supported hosts are macOS on Apple silicon and Linux, at parity.

## 5.1 Process custody (success-relevant: deadlines, hangs, ARG_MAX)
Every process Kogen starts has these guarantees:
1. It runs in its own process group or session.
2. Its wall deadline does not depend on its output. Output goes to a log file, so a chatty child still stops on time (within 1 s).
3. To stop it, Kogen sends TERM to the group, waits 200 ms, then sends KILL to the group. Kogen also reaps the group after a normal exit, so stray grandchildren die.
4. If Kogen dies, even by `kill -9`, every live child group is stopped within 2 s.
5. **No content in argv.** Prompts, commit messages, model commands, secrets and file contents reach a child through stdin or a private file in the run dir. No argv element exceeds 4 KiB.
6. The child gets exactly the environment Kogen built (§5.2), and none of Kogen's own runtime paths are on its `PATH`.
7. A result is `{exit_status|null, timed_out, output_tail (16 KiB), log_path, duration_ms}`. A child killed by signal N reports 128+N. A missing executable reports **unavailable**, the same as exit 126/127.
8. Default timeout is 120 s. Project commands use their `timeout_ms`; the acceptance runner uses `acceptance.timeout_ms`.

## 5.2 Environment
1. **Base.** Kogen's own environment, filtered by an allowlist: `PATH HOME LANG LC_ALL TERM USER SHELL`, the proxy variables, `GIT_*`, `MISE_*`, and stack homes the adapter names (`MIX_HOME HEX_HOME` for exunit).
2. `TMPDIR` is set to `<run dir>/tmp`.
3. **mise.** If `mise` is on `PATH`, Kogen merges the output of `mise env -C <dir> --json --quiet` (run unconfined, 30 s limit). It sets `MISE_STATE_DIR` and `MISE_CACHE_DIR` under the run dir and adds the project root and workspace to `MISE_TRUSTED_CONFIG_PATHS`. The mise binary's directory is prepended to `PATH`.
4. **Project.** The project's `env` is merged last and wins. A project `PATH` is used verbatim.
5. **Kogen's own git calls** get the base environment. The user's global identity and signing apply. Tests set `GIT_CONFIG_GLOBAL` and turn signing off.

## 5.3 Sandbox
**What is confined.** Commands that run project or candidate code: the shell tool, search, fixers, checks, the acceptance runner, setup and acceptance checks.

**MUST, during a Build.** Nothing writes to the user's checkout or the origin except Kogen's landing protocol. Kogen enforces this with confinement where it is available. Where it is not, Kogen detects it: if the checkout's HEAD, index or tracked files, or the origin's refs, changed during a Build, the Build stops as a Kogen bug.

**SHOULD.** Writes are limited to these locations:
- the workspace and the run dir;
- `/tmp`;
- tool caches (`~/.cache/mise`, `~/.hex`, `~/.cache/rebar3`, `~/.npm`, `~/.cargo/registry`, `~/.cargo/git`, `~/.cache/go-build`, `$GOMODCACHE`).

Reads of `~/.kogen/credentials*`, `~/.ssh`, `~/.gnupg`, `~/.codex`, the OS keychain and the `KOGEN_AUTH_PATH` file are denied. The network is allowed. Shaping and approval run in the checkout, so there the checkout is writable.

**No confinement available** (resolved call 4). This happens when the host has no mechanism, or when `KOGEN_SANDBOX=unavailable` is set (a test seam). Kogen then builds unconfined and:
- prints `kogen: warning: sandbox unavailable: <reason>; building unconfined` on stderr, once per command;
- records `sandbox_unavailable`;
- reports `sandbox: "unconfined"`.

**Other cases.**
- `sandbox: false` turns confinement off; `sandbox` is then reported as `"off"`.
- When Kogen itself runs confined (`KOGEN_SANDBOXED=1` in Kogen's own environment), it does not wrap commands again.

## 5.4 Workspaces and git
- **One clone per rung** at `<state root>/<run_id>-<rung>`. The clone is made with `git clone --local --no-hardlinks --no-checkout --template=`, then the build base is checked out detached. The origin is only touched through the landing protocol.
- **Seeding.** The `setup_outputs` directories (else the adapter's `seed_dirs`) are copied copy-on-write where the filesystem supports it, otherwise as plain copies, and never as links.
- **Workspace git config is ignored.** Inside a workspace, Kogen's git calls are not influenced by the workspace's `.git/config` or `.git/info/exclude`: no hooks, no fsmonitor, no filters, no textconv, no extra excludes. Commits use `--no-verify`.
- **Tree hash** = `read-tree <build base>`, then `add -A`, then `write-tree`, all on a private index. It covers the build base plus every change, untracked non-ignored files included, wherever HEAD points. **Changed paths** = a name-only diff of the build base against that tree.
- **Cleanup.** Workspaces may be deleted only after required candidate preservation has completed. Dead-run cleanup MUST follow §3.10, including preservation of latest unsnapshotted work and retention/retry on failure. A deletion failure is recorded (`cleanup_failure`), never ignored; no cleanup deletes the only candidate.

## 5.5 Black-box behaviours
1. A command printing continuously past its deadline stops within deadline + 1 s.
2. A TERM-trapping child is killed after the grace period.
3. A background grandchild of a finished check is stopped.
4. `kill -9` on `queue start` stops the shell-tool group within 2 s.
5. SIGTERM gives exit 143 and status `Interrupted`; SIGINT gives exit 130.
6. A check writing into the checkout fails (when confined), and in every case the checkout is unchanged after the Build.
7. Running with `KOGEN_SANDBOX=unavailable` gives the warning, the event and the report field, and the Build still lands.
8. A 300 KiB heredoc written by the shell tool never puts an argv element over 4 KiB.
9. A workspace `.git/config` hook or filter never runs, and `info/exclude` cannot hide a change from the landed tree.
10. Landed trees are right when the builder deletes, renames, sets `chmod +x`, adds a symlink, or commits by itself.
