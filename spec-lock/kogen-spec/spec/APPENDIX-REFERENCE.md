# Appendix: what the Elixir reference must change

Historical gap list only. The Elixir reference will not be improved further; builders should use [quint/PLAN-NEXT.md](../quint/PLAN-NEXT.md) for the rewrite.

v1.2 records the current disagreements in [DRIFT-v1.2.md](DRIFT-v1.2.md). Where that file and this appendix differ, DRIFT-v1.2 is the later choice. The list below is the v1.1 gap list and is kept so older notes still resolve.

**Update (v1.1):** the per-case status of HEAD `80a4dd97` (ladder, test auditor, provider resilience, per-request records) is in kogen-conformance `TRIAGE-80a4dd97.md`, with one self-build task per behaviour. The list below is the 97ef563d baseline.

This appendix is for the team working on `~/Areas/Kogen/careful-rebuild` (HEAD `97ef563d`). It does not define the spec; it lists every place where today's Elixir code differs from it.

## Seams the conformance suite needs first
- `KOGEN_PROVIDER_URL`, `KOGEN_AUTH_URL`, `KOGEN_TIME_SCALE` and `KOGEN_SANDBOX=unavailable` (§4.1, §5.3). Today the endpoints are compile-time constants.
- The `command` acceptance adapter and the `acceptance:` key (§2.4.3).

## CLI
- Errors print Elixir terms, e.g. `controller/{:intent_unavailable, :enoent}`. They should be the mapped error lines.
- A missing `project.yaml`, a non-git directory, a missing base and a missing Intent all exit 70. They should exit 3 (or 2).
- Boolean flags accept `=true` and `--no-…` forms.
- `--help` is also matched when it appears as the value of an option.
- An invalid slug gives exit 70 on `remove` and `not_found` on the other commands.
- `mise` is required by every project command.
- A parked Build stops the drain with exit 70.
- `status` elapsed times are taken from the `run.json` mtime.
- `provider use --project` silently drops a project path that does not exist.
- A turn limit hit inside a shaping pass exits 70.
- There is no SIGINT handling and no `skipped` or `stopped` drain line.
- The approval hash covers only `intent.md`. The test bytes must be added; this also changes how `bin/kogen-bench` computes the hash.
- The hash is compared only after the checks have run.

## Formats and state
- The journal has no `ts`; reasons are written as `{"tuple":[…]}`; `run.json` has no start times.
- `run.json` status has no `stopped` value.
- `approval.json` is schema 1: no `approval_sha256`, the old baseline shape, no witness.
- Landed status means "any trailer reachable", so a reused slug is landed forever.
- The setup cache key uses Erlang term encoding and the whole process environment.
- `accounts.yaml` can be written in a form the reader rejects.
- A scalar `domains` value crashes the loader.
- Duplicate check names are accepted.
- `env:` may set `KOGEN_SANDBOXED`.
- Shaping setup runs unconfined.
- The stdin temp file is created inside the working directory.
- The shell tool runs `sh -c <cmd>`, which puts model content in argv.
- The tree hash is computed from HEAD, not from the build base.
- No `TMPDIR` is set per run.
- The acceptance runner uses the default 120 s timeout.

## Build
- There are six recipes. Spec: one recipe, `ladder`; the builder is shell-only; there is no judge.
- Repairs are capped at 2 + 1. The spec uses a progress-based cap of 6.
- `unchanged`, turn caps and wall caps end the Build. In the spec they move to the next rung.
- Gate exit-level heuristics put candidate failures into the environment class: timeouts, "No such file" text, and a tool that ran but reported no findings.
- A check with no findings is never excused as base-red. A check that is unavailable on the base blocks green.
- A moved base is refused at start, and `base_acceptance_failed` stops the Build.
- On `timeout` or `transport` the provider stops at once after a single 200 ms retry. A stream that keeps trickling is never cut off. There is no backoff, no model switch, no wait on usage limits, and no outage handling. Shaping stops on the first provider error.
- Not built yet:
  - the ladder, the build auditor with citations, the selector, verdicts and best-candidate emission;
  - the `Difficulty` entry rule;
  - the requirement ledger and the shaping audit;
  - the shaping fallback conversation;
  - style-lint repairs that do not count against the pass budget;
  - `Concerns:` parsing;
  - the witness path.
- Shaping ends a pass on the first successful write. This causes the 207 `generated_file_missing` cases.
- A landing `.lock` or a lost CAS is retried once, then the Build is parked or fails. Deleting the incoming ref fails the Build even after the CAS succeeded.
- On a moved base, rebase conflicts park the Build; there are no integration repairs.
- On Linux the sandbox is not applied. The spec prints a warning and builds unconfined.
