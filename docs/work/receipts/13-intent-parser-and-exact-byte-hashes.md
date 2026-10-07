# Packet 13 receipt — Intent parser and exact-byte hashes

## Source and scope

- Base SHA: `f4b364a643b05caa824d288876c0c301f2779327` (packet 11 is merged in this base).
- Tested implementation HEAD: `19192bd8d7e8a2a50bb424b9e23fba17234512e2`.
- Exact owned files:
  - `packages/core/src/intent/parse.ts`
  - `packages/core/src/intent/hash.ts`
  - `tests/intent-parse/intent.test.ts`
  - `docs/work/receipts/13-intent-parser-and-exact-byte-hashes.md`
- Effort/model: about 5 active minutes by session-clock estimate; no dedicated worker timer was exposed. Codex/GPT-6; exact deployment ID and token count are unavailable in this API session.

## Changed behavior

- Parses the frozen Intent frontmatter schema and defaults with the packet 11 YAML parser, including allowed and rejected keys, required fields, size, domains, gate flag, limits, dependencies, priority, predicates, and optional source.
- Parses known sections and `A<n>` Acceptance/Verify entries. Verify accepts `test`, `test keep`, `integration`, `domain=`, and `after=` modifiers; the last domain wins. Unknown `## X` text remains in the Brief until a known section starts, then becomes a parse error.
- Keeps Request bytes and the complete source bytes unchanged, including CRLF and invalid UTF-8 within Request. Slug validation is a separate helper; parsing does not run lint.
- Computes `intent_sha256` over exact Intent bytes and the approval digest over exact Intent bytes, one NUL byte, and exact acceptance-source bytes.

## Checks

- `GIT_CONFIG_GLOBAL=/dev/null make check`: **PASS** on macOS 26.7.1 arm64; Biome, TypeScript, native compilation, freeze/dispatch checks, and 144 tests passed (0 failed; 1,667 assertions).
- Named local command `bun --no-install test --max-concurrency 1 ./tests/intent-parse`: **PASS**, 16 tests / 46 assertions.
- The local parser cases consume the frozen `state-04` rejected rows and frozen `state-07` CRLF Request/hash fixture. The `state-07` approval digest matches `388aa63a3e8f5ba696802e4687c543495cd6f27d621490f7669a42e3f5ab016c`.
- Exact brief conformance command for `state-04,state-07`: **NOT RUNNABLE / harness error**, not a parser pass or behavioral failure. The runner reported `FileNotFoundError` for `$ROOT/dist/kogen` before starting Kogen: `state-04` 16/16 instances errored; `state-07` 1/1 errored; 17 expanded instances total. No Kogen process was launched, so fake-request matching was not observable and cannot be claimed green. Results were recorded at `/var/folders/8f/khnp6qk51mvgk_jkxz169nr40000gn/T/kts-13-ez5OdX/results.jsonl`.
- Xspec replay is not a Packet 13 runnable check. Packet 57 owns the approve/intent adapter and I3 owns mandatory hand/seed acceptance; no replay counts, seeds, or divergences are claimed here.

## Pending acceptance and next owners

- The required actual rejected `syn-06` and `syn-20` frontmatter bytes are not present in this checkout. I asked for their paths/contents and did not fabricate replacement fixtures. Their explicit fixture coverage remains pending that source.
- Public CLI wiring and `dist/kogen` are not present in this bootstrap. Integration I0/coordinator must connect the parser to the public path; the exact B13 cases remain **awaiting integration acceptance** until then.
- The frozen black-box oracle is v1.2; the target is the v1.3-draft `e19dd1c` bundle and no matching v1.3 overlay is available here. Only macOS was exercised; Linux remains unverified.
- Next implementation owners: packet 14 for lint/normalization, packet 57 for production Intent replay, and I0/coordinator for CLI composition. Fixture provenance for `syn-06`/`syn-20` is needed from the user/coordinator.
