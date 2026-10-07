# Packet 25 receipt — status derivation and renderers

**Status:** Synthetic derivation and renderers implemented; public status/watch acceptance awaits I1/I2 integration. This is not integration acceptance.

## Source and ownership

- Base SHA: `9c10511f3ef2d25f760cfdd0a2f7a2590d580671`
- Source implementation head SHA: `198b58a67547674098455ee677046d344568be6d` (the receipt is a docs-only follow-up).
- Dependencies 13, 21, 23, and 24 are present in the base: `19192bd` (Intent parsing), `4b003ec` (approval commits/CAS), `6111327` (run journal), and `73fee61` (queue scheduler/claim).
- Spec authority: v1.3-draft `e19dd1c21c19c5be1201c3b6a42c59c28b5c2887`, frozen `CLI-RULE.txt`, and the read-only v1.2 suite.
- Owned files changed:
  - `packages/core/src/status/derive.ts`
  - `packages/core/src/status/report.ts`
  - `packages/core/src/status/render.ts`
  - `packages/core/src/status/watch.ts`
  - `tests/status/status.test.ts`
  - `docs/work/receipts/25-status-derivation-and-renderers.md`
- Effort: approximately 45 active minutes, manually estimated; session timing is not exposed. Model: GPT-6 Codex; exact serving variant, effort setting, and token count were unavailable.

## Behavior

- Status derivation gives reachable `Kogen-Intent` trailers precedence over all run and approval state. It reduces each slug to its latest reachable landing and does not compare the checkout's current Intent bytes, so reusing a slug remains landed while its trailer is reachable. Runs are indexed by slug and current approval commit; stale failed/parked runs do not classify a re-approved Intent. It derives claimed Builds, interrupted owners, blocked dependencies, queue order/positions, and the next queue entry using packet 24's selector.
- Overview rendering follows §1.7.5 ordering and queue wording, includes only nonempty sections, and shows the five newest landed Intents followed by an earlier count. Slug rendering includes the current Build summary and report details without a legacy `verdict:` line. JSON Lines overview and the §2.10 slug report emit every required field, explicit nulls, agent rows, measured token/cache data, and acceptance/check/audit/failure details.
- The watch reducer emits the initial complete frame and changed frames only, separates later frames with a blank line, polls at the specified two-second interval (with a 100 ms test scale floor), and returns the specified idle/slug exit code. Its source contract requires the caller to provide a fresh snapshot after recovery; live CLI/Git/process wiring is pending I2.

## Validation

- `bun --no-install test tests/status/status.test.ts`: **PASS**, 13 tests / 47 assertions. Synthetic coverage includes reachable landing precedence and slug reuse, current-approval runs, blocked/next/interrupted states, JSON nulls and cache rate, five-row history, streaming frames and exits, and the 50-Intent/200-run one-second timing target.
- `GIT_CONFIG_GLOBAL=/dev/null make check`: final invocation **PASS**, 404 passed / 1 skipped / 0 failed across 405 tests, 3,348 assertions. Biome, TypeScript, shell, native, and isolated checks passed. The skip is the Linux namespace/bubblewrap mount fixture on macOS 26.7.1 arm64. An earlier invocation had one corrected assertion in this packet and an unrelated host-bridge parent-SIGKILL failure; the final exact invocation passed.
- Required B25 conformance command was run once with all 16 cases listed below, profiles `cli,state,approval,shape,build,ladder,provider,custody,format,v1.2`, `--jobs 3`, and `--time-scale 0.02`.

  ```sh
  ROOT="$(git rev-parse --show-toplevel)"
  SUITE="$ROOT/spec-lock/kogen-conformance"
  RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/kts-25-XXXXXX")"
  chmod 700 "$RESULTS"
  mkdir -p "$RESULTS/work"
  "$SUITE/bin/kogen-conformance" run --kogen "$ROOT/dist/kogen" \
    --profile cli,state,approval,shape,build,ladder,provider,custody,format,v1.2 \
    --case 'cli-28,state-17,state-19,state-24,state-30,v1.2-129-cli-27,v1.2-131-state-12,v1.2-132-state-23,v1.2-137-format-12,v1.2-22-cli-25-status-overview,v1.2-23-cli-26-status-slug,v1.2-25-state-20-status-next,v1.2-26-state-22-status-next,v1.2-27-approval-18-status-next,v1.2-92-ladder-24,v1.2-93-ladder-25' --jobs 3 --time-scale 0.02 \
    --workdir "$RESULTS/work" --out "$RESULTS/results.jsonl"
  ```

  Result: **16 cases / 16 instances; 0 pass, 0 assertion failures, 16 harness errors, 0 skipped**. Every case failed before Kogen launch because `<repo>/dist/kogen` is absent (`FileNotFoundError`). No Kogen process started and no fake provider request was issued; unmatched fake requests were **not evaluated**, not zero. Results: `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T//kts-25-osEg8q/results.jsonl`. The required command was not retried.

  Cases: `cli-28`, `state-17`, `state-19`, `state-24`, `state-30`, `v1.2-129-cli-27`, `v1.2-131-state-12`, `v1.2-132-state-23`, `v1.2-137-format-12`, `v1.2-22-cli-25-status-overview`, `v1.2-23-cli-26-status-slug`, `v1.2-25-state-20-status-next`, `v1.2-26-state-22-status-next`, `v1.2-27-approval-18-status-next`, `v1.2-92-ladder-24`, and `v1.2-93-ladder-25`.
- Replay is not assigned to B25: hand cases run: 0; seeds 17/23/41 not run; first divergence: not applicable. Packet 58 owns queue/status replay closure.

## Version and integration gaps

- Exact incompatible frozen v1.2 assertions are in `v1.2-132-state-23-slug-reuse.json`: after editing the Intent under a slug whose `Kogen-Intent: greet` trailer remains reachable, it expects `greet: draft; review it with kogen intent approve greet`; after approval it expects `greet: queued, 1 of 1`; then it expects `queue start` to build and land `greet` again. Frozen v1.3-draft §2.11 says the reachable trailer wins without comparing current Intent bytes, so the correct status remains `greet: landed <sha8>` while that trailer is reachable. These assertions conflict with the target version and must remain labeled as a v1.2 version conflict; the frozen suite was not changed. The case could not reach its assertions in this run because the executable was absent.
- The public CLI, real status snapshot loader, recovery-before-read wiring, and live watch are absent from this bootstrap. I1 owns status registration and synthetic status integration; I2 must wire the live queue/Build and recovery effects, build `dist/kogen`, and rerun the 16 B25 cases. Reducer-only tests do not close B25.
- Linux behavior is unverified. The local check skipped its Linux-only mount fixture on macOS. There is no v1.3 frozen executable suite, so no v1.3 public parity is claimed.

**Next owner:** I1/I2 coordinator for public status and recovery/watch wiring and rerunning B25 after `dist/kogen` is available; packet 58 for the mandatory queue/status replay matrix.
