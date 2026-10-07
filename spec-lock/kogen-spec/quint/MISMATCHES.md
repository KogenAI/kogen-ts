# Adapter mismatches and seams

Historical Elixir replay record only. The reference implementation will not be repaired. A rewrite implements the private adapter in [ADAPTER.md](ADAPTER.md) using production transition code; `no_seam` and projected observations never count as conformance.

Replay reference: `careful-rebuild` library replayed at
`0d3ff7290aed98b439d120dde4d5bf0ce89295ca`; current HEAD is
`f98073684280da3f4eb97c940638386d70830ab3` (only benchmark and end-to-end test files changed);
provider cache source: T98 `3644d35d7b83f171cf4461f931885daccad1014a`. Both checkouts were
read-only. Counts below use the checked-in hand scenarios plus 500 generated traces per
slice (seed 17, max 25 steps). A projected replay compares only the named observation fields;
counts from different projections overlap and must not be added.

## Model bugs fixed

- `resilience`: generated invariant traces found that an eighth shaping attempt with a login
  result entered refresh before checking the 8-attempt cap, permitting attempt 9. The cap
  check now precedes login refresh (while an eighth-attempt success remains successful).
  Added hand case `18-shaping-cap-before-login-refresh`; all 18 hand cases and 500 generated
  traces pass `quint` invariants.
- `session`: the first adapter check fabricated a non-null `previous_response_id`, which
  tested codec support rather than Kogen's normal request. It now calls
  `Kogen.Harness.Codec.request/5`; that builder sets the field to `nil`. Previous-response
  behavior no longer accounts for replay mismatches.
- `status`: the adapter initially forced watch exit to zero. It now projects the real
  `StateView.watch_exit`; full replay passes.

## Kogen drift against v1.2

- **Gate selector:** `gate` winner projection agrees on 244/505 traces. The model orders by
  passing undemoted items, blocking count, diff size, then rung. Current
  `Kogen.Build.Selector` ranks `checks_green` first, then failing acceptance, failing tests,
  and diff size. The hand selector case picks rung 3 in the model and rung 2 in Kogen.
- **Accounts/provider commands:** `accounts` projection
  `chatDefault,chatAlpha,chatBravo,broken` agrees on 507/509 traces. Kogen permits `use`
  after logout when a profile record remains, while v1.2 requires a signed-in account. When
  `provider use --project` names a missing path and no default exists, Kogen can serialize a
  bare `chatgpt:` key that reads as a broken file; v1.2 requires a project to exist and a
  valid empty mapping. Further projection `selectedDefault,resolvedProvider,resolvedLabel,
  resolvedSaved` agrees on 72/509: current `Accounts.label` only resolves project ChatGPT
  choice, committed account, then default; it does not apply the spec's environment/provider
  precedence. `last,exit` agrees on 2/509: current CLI accepts only `chatgpt`, has no Grok
  list/login/logout/use, and uses different refusal codes for some invalid labels and
  signed-out records. See also the `no_seam` limitation below for real OAuth effects.
- **Lite session id:** `session` agrees on 80/506 across
  `epochClass,keyChanged,lite,last,stage,previous`. All 426 mismatches are `lite`: v1.2
  requires the Lite header's `kogen:responses:v1` session hash, while current `Exchange`
  passes the v2 `PromptCacheKey.for_run_stage(..., :session)` value. The regular v2 prompt
  key is expected and is covered by the other session observations.
- **Usage-limit refresh:** `stream` agrees on 251/510 full observations after wiring the
  adapter to Kogen's real `Retry`, `Recovery.continue/2`, and checkpoint helpers. All 259
  remaining traces first differ on a `usage_limit` or `login` result: the adapter exposes the
  pure `Retry.next` seam, which stops these classes, while provider refresh and Build pause
  require provider/runner effects. Within that boundary, current ChatGPT provider code only
  forces refresh for `login`; v1.2 requires owned ChatGPT and Grok to refresh once for both
  `login` and `usage_limit`. Grok is also absent from current HEAD. Partial-stream continuation
  now agrees through the real `Kogen.Resilience.Recovery` helper.
- **Historical resilience slice:** its projected replay agrees on 2/518 traces. It encodes
  the retained v1.1 policy (fallback after 3, no per-request cap, shaping cap 8), while current
  Kogen uses a 2-overload switch and four-attempt caps for overload/malformed. The v1.2
  provider state machine is the `stream` slice; this historical slice remains unchanged apart
  from the invariant fix above.
- **Setup-cache digest:** `setup-cache` models equality-relevant key material and replays the
  file-backed cache behavior, but does not compare SHA bytes. Spec §2.9 requires SHA-256 of
  canonical JSON; current `Kogen.Project.SetupKey` hashes deterministic Erlang term encoding
  of a tuple. Its full cache-outcome adapter replay agrees on 507/507 traces. The digest
  representation is source-level v1.2 drift that cannot be seen in the cache outcome fields.

## Not fully replayed: no pure apply seam

These adapters return an explicit `no_seam` observation instead of fabricating Kogen state;
the harness therefore reports reset mismatches, not conformance passes.

| Slice | Adapter result | Missing boundary |
|---|---:|---|
| `approve` | 0/517 | `Approval.prepare` reads files/refs and runs setup/checks; CLI `decide/2` is private. |
| `intent` | 0/506 | Intent shape/remove and approval ref CAS are owned by CLI/Git operations. |
| `orchestration` | 0/506 | Build table drives child processes, Git worktrees, checks, and a run journal. |
| `rebase` | 0/507 | Landing mutates Git refs and worktrees while coordinating checks. |
| `recovery` | 0/505 | Recovery reads process liveness, journal events, commits, and refs together. |

Other projections cover only a real pure submodule, not the entire modeled concern:

- `queue` lock projection (`held,alive,stop`) agrees on 1/507; `Queue.Lock` is exercised,
  but serial drain, per-Intent Build results, and stop-after-current behavior have no pure
  seam in this adapter.
- `stream` uses deterministic maximum-jitter draws so its recorded ceiling is reproducible;
  the provider pause/refresh path is not called because it can wait or contact OAuth.
- `accounts` invokes local credential storage and account selection with a temporary home.
  Browser OAuth, token exchange/revocation, and remote Grok calls are modeled as profile
  effects and are not issued by the adapter.
- `status` uses the real selectors/renderers and state view for 508/508 traces, but Git-ref
  discovery, journal recovery, and watch process polling are represented by input events.
- `gate` invokes the real pure selector only; check/acceptance/auditor rows are model inputs.
- `session` invokes the real cache-key and codec helpers; byte-prefix histories are scenario
  inputs rather than captured live HTTP bodies.

The setup-cache model compares key identity, not the digest bytes. Its adapter exercises the
real cache's hit, restore, failure, input-recheck, and eviction behavior in temporary
directories. SHA compatibility remains unverified until Quint or a separate adapter computes
the v1.2 canonical JSON digest; intermediate crash states inside atomic publication are not
modeled.
