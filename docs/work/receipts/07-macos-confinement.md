# 07 — macOS confinement receipt

**Status:** Implemented locally; awaiting public Build integration acceptance.

## Source and effort

- Base SHA: `c6c143ade697e586c3b4159e4fec98ff2df5108f`.
- Implementation commit/head SHA: `ac4456f482b4dc522e090cd769160d9b05c1ca93` (`Implement macOS sandbox confinement`). This receipt is a separate follow-up commit.
- Dependency 06 is in the base, including its child environment and private script transport.
- Exact owned files changed:
  - `packages/core/src/sandbox/policy.ts`
  - `packages/core/src/sandbox/macos.ts`
  - `tests/sandbox-macos/sandbox.test.ts`
  - `docs/work/receipts/07-macos-confinement.md`
- Active effort: approximately 10 minutes; estimated because worker-time telemetry is unavailable. Check runtime was brief.
- Model: Codex/GPT-6. Serving variant, effort label, and token count were not exposed by the runtime.
- Host: macOS 26.7.1 arm64; Bun 1.4.2 and Git 2.54.0. Linux was not tested in this packet.
- Frozen target: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`.

## Behavior

- `policy.ts` resolves `confined`, `unconfined`, and `off` distinctly. It honors `KOGEN_SANDBOX=unavailable` and `KOGEN_SANDBOXED=1`, emits the exact unavailable warning text, returns the `sandbox_unavailable` event tag, and suppresses wrapping when Kogen already runs confined.
- `macos.ts` generates a deny-by-default SBPL profile. It permits writes only in the Build workspace, run scratch, `/tmp`, `/dev/null`, and the configured tool caches; allows network and process execution; denies writes to checkout and local origin roots; blocks reads from SSH, GnuPG, Codex, Keychain, `.kogen/credentials*`, and the injected auth path.
- Profile paths are normalized to physical paths where available, including macOS `/tmp` resolution. The wrapper uses `/usr/bin/sandbox-exec -f <profile> ...` without shell interpolation.
- The capability probe checks that `sandbox-exec` can launch a command under a valid profile and confirms that the kernel denies a uniquely named write. Probe failures become a reason for the policy's unconfined warning path.
- The local real-confinement fixture proved workspace/cache writes and localhost network access, denied checkout/origin writes and secret reads, and kept protected bytes unchanged. The forced-unavailable policy fixture selected unconfined mode without wrapping. Public Build integrity detection and event/report persistence remain integration-owned.

## Verification

- Named local acceptance, `GIT_CONFIG_GLOBAL=/dev/null bun test tests/sandbox-macos/sandbox.test.ts`: **PASS**, 5 tests / 0 failures / 54 expectations. Includes the real Seatbelt fixture and the production capability probe.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: final run **PASS**, 201 tests / 0 failures / 2,006 expectations. Biome, TypeScript, shell syntax, frozen-input and dispatcher checks, warning-clean native compilation, and isolated tests passed. The first check attempt caught import-order formatting; it was corrected before the final passing run.
- Exact named conformance command from the brief on macOS 26.7.1 arm64: **ERROR**, not a behavioral pass or fail. `v1.2-119-custody-06`: 0 passed, 0 failed, 1 error, 1 instance. `v1.2-120-custody-07`: 0 passed, 0 failed, 1 error, 1 instance. Both errors are `FileNotFoundError` for `/Users/almirsarajcic/Areas/Kogen/kogen-ts-wt/07-macos-confinement/dist/kogen`; the bootstrap has no built executable. Results: `/private/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-07-oBdB2A/results.jsonl`.
- The suite reached no fake provider requests. Each case's three scripted provider exchanges remained unused because the Kogen process could not start; no endpoint request count or behavioral unmatched-request result is available.
- Replay is not assigned to this packet: hand cases 0, seeds 17/23/41 not run, first divergence not applicable.
- No incompatible v1.2 assertion was observed; both cases stopped before their behavioral assertions. This is not a v1.3 conformance claim.

## Pending integration and next owner

The `dist/kogen` executable, Build composition, and public queue/status handlers are not present at this base. The coordinator owns composition and the I2 Build integration; it must connect the policy decision to the supervised command path, print the warning once, persist `sandbox_unavailable`, and expose the report field. The forced-unavailable checkout/origin integrity fixture and the two named B07 cases remain pending that integration. The local macOS profile and capability probe are verified on this host; Linux parity is owned by packet 08 and was not evaluated here.
