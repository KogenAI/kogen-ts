# Mid-build review: remaining findings

The I1 fixes for findings #1, #4, #5, #8, and #9 are recorded in `receipts/I1.md`.
The following findings remain assigned to later packages and gates. Workers must
close every finding assigned to their package or gate and record the evidence in
their receipt.

**Authoritative coordinator spec note:** kogen-spec `96cefde` (8 Oct) — provider
exhaustion stops the Build, keeps the Intent queued and exits 4, with no
per-Intent provider failure; only login refreshes.

| Finding | Required repair and owner |
| --- | --- |
| #2 P1 — Provider retry cap counts exempt failures | Package 33 amendment before packages 38/43 integration. Keep telemetry attempts separate from cap-spending attempts; login, budget-funded timeout/stall/transport failures do not spend the overload/malformed cap (§4.5). |
| #3 P1 — Credential work falls outside the first-byte deadline | Packages 29/36/54 amendments, closed through I2/I6. Start the deadline before credential loading and lock waiting for both authenticated senders. |
| #6 P2 — Required cache breakpoint absent | Package 30 amendment with packages 38/47 integration. Package 63 verifies actual request bytes and cache telemetry, including the shared-instruction breakpoint for GPT-6/GPT-5.6. |
| #7 P2 — Run snapshot updates can lose concurrent changes | Packages 38/44 establish one serialized run-state writer; coordinate package 23 amendment. Add a barrier-controlled interleaving regression. |
| #10 P2 — Concurrency tests miss approval preflight race | Package 36 amendment and I1/I2 integration tests. Use explicit readiness barriers for refresh and simultaneous approval preflight, staging, and cleanup. The review did not establish a Rust-style shared-scratch race in the unique I1 scratch roots. |

Review source: `/Users/almirsarajcic/cx/logs/KTS-MIDREVIEW.findings.md`.
