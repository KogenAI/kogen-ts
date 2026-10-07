# Quint coverage

Historical baseline only: the counts below precede the 6 October rewrite review and describe Quint self-checks and Elixir projections. They are not current Rust or rewrite conformance. See [ADAPTER.md](ADAPTER.md) for the required full-observation replay and [PLAN-NEXT.md](PLAN-NEXT.md) for acceptance.

Review rerun (6 Oct 2026): guaranteed slices `approve` 18/18, `intent` 6/6, `queue` 9/9, `rebase` 7/7, `recovery` 5/5, `stream` 10/10, `session` 7/7, and `status` 8/8 hand scenarios pass. Each also completed 500 invariant-checked traces × 25 steps at seed 17. The changed `approve`, `queue`, and `session` slices also passed seeds 23 and 41. No rewrite adapter exists yet, so these are **spec self-checks only**. New hand cases cover approval re-read before CAS, queue priority and a non-outage provider failure, and cache affinity across stage/rung/run changes.

Spec baseline: v1.2 in `../spec/` (6 Oct 2026). Every modeled slice passed its hand
scenario expectations/invariants and generated invariant run: 500 traces × up to 25 steps,
seed 17 (12,500 events per slice). The retained landing prototype was run separately with
1,000 traces × 30 steps, seed 42. Adapter counts are trace counts; projected fields are named
in `MISMATCHES.md` and projections from one slice can overlap.

| Slice | Spec sections | Hand scenarios | Generated traces / events | Quint status | Current Kogen replay |
|---|---|---:|---:|---|---|
| `prototype/landing` | §2.5.3, §3.9–3.11 | 18 | 1,000 / 30,000 | 18/18; invariants hold | Go 1,018/1,018; Rust 1,018/1,018; Elixir 1,018/1,018. These are the retained prototype implementations, not the `careful-rebuild` CLI. |
| `approve` | §1.7.2, §2.5.1, §3.3 | 17 | 500 / 12,500 | 17/17; invariants hold | 0/517; explicit `no_seam` adapter. |
| `intent` | §1.7.1, §1.7.3, §2.5.1, §3.2.5 | 6 | 500 / 12,500 | 6/6; invariants hold | 0/506; explicit `no_seam` adapter. |
| `queue` | §1.7.4, §3.11 | 7 | 500 / 12,500 | 7/7; invariants hold | 1/507 for `held,alive,stop`; lock-only projection. |
| `orchestration` | §3.0–3.5 | 6 | 500 / 12,500 | 6/6; invariants hold | 0/506; explicit `no_seam` adapter. |
| `gate` | §2.4.1, §3.7–3.8 | 5 | 500 / 12,500 | 5/5; invariants hold | 244/505 for `winner`; selector ranking differs. |
| `rebase` | §2.8, §3.9 | 7 | 500 / 12,500 | 7/7; invariants hold | 0/507; explicit `no_seam` adapter. |
| `recovery` | §2.5.3, §2.11, §3.10 | 5 | 500 / 12,500 | 5/5; invariants hold | 0/505; explicit `no_seam` adapter. |
| `resilience` | §4.4–4.5 (retained v1.1 slice) | 18 | 500 / 12,500 | 18/18; invariants hold | 2/518 on `last,model,consec,attempts,decision`; historical policy differs from current Kogen. |
| `stream` | §4.3–4.5, §4.9.4, §4.9.6 | 10 | 500 / 12,500 | 10/10; invariants hold | 251/510 full observation; remaining refresh/pause effects are documented. |
| `session` | §4.1–4.2, §4.9.1–4.9.2 | 6 | 500 / 12,500 | 6/6; invariants hold | 80/506 on `epochClass,keyChanged,lite,last,stage,previous`; Lite key drift. |
| `setup-cache` | §2.9 | 7 | 500 / 12,500 | 7/7; invariants hold | 507/507 full observation; real `SetupReuse` in temporary directories. |
| `status` | §1.7.5, §2.11 | 8 | 500 / 12,500 | 8/8; invariants hold | 508/508 full observation. |
| `accounts` | §1.7.6, §2.7, §4.6, §4.10 | 9 | 500 / 12,500 | 9/9; invariants hold | 507/509 (`chatDefault,chatAlpha,chatBravo,broken`); 72/509 (`selectedDefault,resolvedProvider,resolvedLabel,resolvedSaved`); 2/509 (`last,exit`). |

The 13 core slices contain 111 hand scenarios and 6,500 generated traces (162,500 events).
The prototype adds 18 hand cases and 1,000 traces. `prototype/run.sh` detected all 17 seeded
Go implementation mutations and all 4 spec mutants; every implementation mutant failed at
least one hand or generated trace, and the spec mutants failed a scenario or invariant.

## Effect boundary

The setup-cache key is represented by its equality-relevant material, not the SHA-256 bytes;
Quint has no SHA-256 primitive. Its adapter checks the real disk-backed `SetupReuse` behavior
in temporary directories. Actual Git, process, shell, and OAuth effects remain outside pure
transitions. See `MISMATCHES.md` for adapter projections and reference drift.
