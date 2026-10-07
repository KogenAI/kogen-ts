# Conformance boundary for any implementation

The rewrite ships the fixed `kogen` CLI and a **separate private** JSON-lines replay executable, called `kogen-xspec` here. The private executable is not a `kogen` subcommand and adds nothing to [CLI-RULE.txt](../CLI-RULE.txt). It must call the same production transition functions the CLI uses. A Rust implementation can expose these as library functions and keep `kogen-xspec` in a separate binary target. The adapter contains JSON decoding, deterministic effect injection, and observation mapping; it contains no queue, approval, gate, provider, or landing policy.

## Two kinds of evidence

| Boundary | Black-box `kogen-conformance` | Quint trace replay |
|---|---|---|
| CLI grammar, help, stdout/stderr, exit, signals | Authority: run the read-only `cli` and `format` profiles. | No CLI parser model; do not use trace passes as a CLI substitute. |
| Intent files, approval hash, check execution, approval ref CAS | Authority: `state` and `approval`, with real Git and the `command` adapter. | `approve` and `intent`: order of refusals, unchanged prior ref, race/no-write invariants. |
| Queue and status | Authority: `cli`, `state`, and `build` with real processes, refs and restart. | `queue` and `status`: priority/time/slug ordering, one owner, stop semantics, status precedence. |
| Gate, candidate, landing, recovery | Authority: `build`, `custody`, and eventually promoted `ladder` cases with real Git trees and crashes. | `rebase` and `recovery` are mandatory for CAS/crash phase transitions; `gate` and `orchestration` are diagnostic until their L/E parts are settled. |
| Provider login, SSE, tool/custody effects | Authority: `provider` and `custody` with the fake HTTP/OAuth server and child processes. | `stream`: retry/fallback/wait decisions under injected clocks and provider outcomes. |
| Prompt cache wire and usage | Fake-provider request bodies/headers and journal `cached_input` check deterministic rules. A live repeated-turn smoke separately checks the >0.95 release threshold. | `session`: affinity and thread identity, turn/repair stability and checkpoint boundaries. |
| Grok provider wire/account detail, setup cache, witness, edge probes | CLI-RULE admits `grok` on the existing provider verbs; §4.10 and P10 specify its behavior, but the frozen v1.1 suite lacks Grok coverage. | `accounts` remains diagnostic while its L-level precedence details are being validated; other experimental slices are diagnostic until promoted. |

The frozen suite in `~/Areas/Kogen/kogen-conformance` is **read-only** and is tagged v1.1. Its `README.md` says 244 cases/600 instances, with `cli`, `state`, `approval`, `shape`, `build`, `ladder`, `provider`, `custody`, `format`, and `exunit` profiles. A pass there proves those frozen assertions, not v1.2-only prompt-cache or Grok behavior. Do not report a v1.2 release pass from frozen cases alone. Add a future suite version in that repository through its own review; until then, use the explicit local wire cases in [CONFORMANCE-v1.2-CASES.md](../spec/CONFORMANCE-v1.2-CASES.md) as requirements, and mark unimplemented tests as gaps.

## Minimal JSON-lines adapter, xspec/1

Launch one long-lived process per slice. The harness passes the slice through the private executable's argv, for example `kogen-xspec queue`. It writes one UTF-8 JSON object per line to stdin and reads exactly one JSON object per line from stdout. Diagnostics may go to stderr. EOF closes the process. No network, credential store, checkout, or production account is read; all outside results are explicit event fields. In production, these same decisions run around actual effects.

| Request | Required result |
|---|---|
| `{"op":"reset"}` | Reset all slice state and return the exact initial observation. |
| `{"op":"apply","event":{"tag":"Start"}}` | Call the real transition with the decoded event, persist its state in memory, return the exact observation. |
| `{"op":"apply","event":{"tag":"Enqueue","value":{"slug":"alpha","time":1,"priority":0}}}` | Same, using the event payload as effect input. |

Every slice's `xspec.json`, Quint `type Event` and `type Obs`, and checked-in `golden/hand/*.json` define its exact event/observation schema. Arrays that represent sets are canonicalized by the harness; ordered arrays remain ordered. Unknown tags or malformed input are protocol errors on stderr with a nonzero process exit, never a fabricated observation. `no_seam` is a **failure**, never a conformance result. No projection of observation fields can be called a pass. Existing `adapter/*.exs` files and projected replay counts in `COVERAGE.md`/`MISMATCHES.md` are historical Elixir diagnostics only.

For effectful transitions, events carry observations of **the effect**, not a suggested policy result. Examples: `approve.prefixOk` is calculated from actual `intent.md` + NUL + acceptance-source bytes; `approve.stableBeforeCas` records a second read immediately before the ref CAS; `rebase.Cas.won` is the injected result of a compare-and-swap; `stream` receives fake HTTP error class, elapsed time and usage. The adapter must not compute `prefixOk` from the supplied `sha` string alone, copy expected observations, or keep a parallel state machine. For a filesystem or Git effect that cannot be injected into the real transition layer, implement a temporary-origin effect driver and report the tested boundary explicitly.

## Running and acceptance

From `quint/prototype/`:

```sh
XSPEC_SLICE=../slices/queue python3 harness/xspec.py spec
XSPEC_SLICE=../slices/queue python3 harness/xspec.py gen --traces 500 --steps 25 --seed 17
XSPEC_SLICE=../slices/queue python3 harness/xspec.py conform -- /path/to/kogen-xspec queue
```

`spec` verifies hand expectations against Quint and writes their full observations. `gen` checks invariants on each generated step and writes randomized traces. `conform` requires **exact** observations at reset and every event. Its `--project` option exists solely to diagnose an old partial seam, prints `DIAGNOSTIC PROJECTION ONLY`, and exits 2 even if projected fields agree. Use distinct seeds 17, 23, and 41 before calling a guaranteed slice accepted; preserve the scenario and trace seed in the report. The private adapter and the public CLI must be built from the same revision. The user-facing release gate is the black-box suite plus the guaranteed trace slices and the live cache smoke, with version gaps reported separately.

The shell invocation uses an argv vector; no shell evaluates the adapter command. The protocol has no token, URL, or implicit environment lookup, so replay can run on a blank temporary HOME.
