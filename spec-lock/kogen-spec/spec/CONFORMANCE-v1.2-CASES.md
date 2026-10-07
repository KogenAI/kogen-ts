# Conformance cases for v1.2

Grok cases exercise the provider name admitted by CLI-RULE.txt and the provider behavior in §4.10. This document proposes a future suite version and does not change the read-only frozen v1.1 suite. The ChatGPT cache cases remain a rewrite requirement.

v1.3-draft supersedes the distinct-run affinity assertion in P2; use the cross-session cases in [CHANGES-v1.3.md](../CHANGES-v1.3.md). Other unresolved v1.2 cases remain proposals.

These cases are not in the frozen suite (`conformance-v1.1`, 244 cases). A later suite adds them. This file does not change that suite.

The fake provider is §4.8. Inspection is `GET /_fake/requests`. Each case names the observations that must hold. A missing observation fails the case. Quoted text is byte-exact.

## P1. Conversation key is present and stable

One develop conversation, three turns, same stage, attempt, rung, and epoch.

- Every body has the same nonempty opaque `prompt_cache_key` on all three turns.
- The `session-id` header equals `prompt_cache_key`; the `thread-id` header is constant across these turns and is recorded as `conversation_id` in the journal.
- The journal records the cache key separately from the thread id. Neither value contains a path, token, or account secret.
- The key identities survive a process restart for the same Build run.

## P2. Thread identity changes with the rung; Build cache affinity does not

- A second rung, a `fresh-N` attempt, an escalation attempt, another stage, and another epoch each produce a different `thread-id`/`conversation_id` from P1 but retain the Build's `prompt_cache_key`/`session-id`.
- A fallback that changes `model` to `gpt-6.1-sol` and `effort` to `medium` keeps both identities.
- A distinct Build run has a distinct conversation/thread identity. Cache affinity may be shared under the evidenced adapter policy (§4.9.1).
- That fallback body is not a byte prefix of the previous body, because `model` changed.
- Encrypted reasoning items from the previous model are absent after the switch.

## P3. Prompt prefix is byte-identical from turn 2

Take bodies B1, B2, B3 of one conversation that stayed on one model.

- Delete the final two bytes `]}` of B1. Every remaining byte is a prefix of B2. The next byte of B2 is `,`.
- The same check holds for B2 against B3.
- `instructions`, tool schemas, `model`, `effort`, `store`, `stream`, and `prompt_cache_key` are unchanged across the three bodies.
- `store` is false. `previous_response_id` is absent.
- Earlier input items are unchanged and stay in order. New items are appended.
- The turn-budget note is one appended user item. It is not inside `instructions`. Its text is `System note: <N> turns remain. Run the targeted tests now and finish the smallest complete change.`
- It appears once, when completed turns reach `div(max_turns * 4 + 4, 5)` (48 when the cap is 60).

## P4. Completion is `finish`, not text

- A builder reply that is only text does not finish the turn. The next user item is: `Continue the entire approved Intent with the next useful tool call. Brief progress text does not finish the Build; call finish alone with {} when implementation and targeted verification are complete.`
- `finish` with `{}` as the only call returns `Completion requested. Kogen will run the gate.` and the gate runs.
- `finish` with any other arguments, or beside another call, returns `finish requires an empty object and must be the only tool call. Continue implementing, then call finish alone with {}.` and the gate does not run.
- The first `finish` with no implementation change returns `Kogen found no changed files. Make the requested change before claiming done.`
- The second such `finish` runs the gate.

## P5. Tool-result budget

Default `build.tool_result_tokens` is 2000. The cap is 8000 bytes.

- A short UTF-8 result is returned unchanged.
- A longer result keeps a head and a tail and contains this notice, with the real total, ranges, and handle filled in: `\n[truncated/range: <total> bytes; shown byte ranges <ranges>; retrieve with tool_output handle=<handle>, output_offset and output_limit]\n`
- `<handle>` is the lowercase SHA-256 of the redacted full text. The file `tool-result-<handle>.log` exists in the run logs.
- `tool_output` with that handle and a range returns that range. A symlink handle returns `ERROR: Unknown or unavailable tool-output handle.`
- Non-UTF-8 output starts `[non-UTF-8 output, base64 encoded]\n` and then the base64 of every byte.
- A search that would exceed 200 lines is not cut at 200 lines. The token budget is the only cut.
- A `write` stores the full file. Only the model-visible string is shortened.

## P6. Responses and Lite shapes

Responses mode, injected ChatGPT:

- Body includes `tools` and `include: ["reasoning.encrypted_content"]`.
- Luna sets `text.verbosity` to `low` and omits `reasoning.summary`. Another model sets `reasoning.summary` to `auto`.
- `tool_choice` is `auto` and `parallel_tool_calls` is false, unless the stage sets `none` or `required`.

Lite mode, injected, model `gpt-6-luna`, no generation cap:

- Header `x-openai-internal-codex-responses-lite` is `true`.
- Header `session_id` is SHA-256 of `kogen:responses:v1`, NUL, the expanded run directory, NUL, `session`.
- `instructions` is `""`. There is no top-level `tools`.
- `reasoning.context` is `all_turns`.
- An owned login that asks for Lite sends no request. The class is `unsupported`. The message is `Unsupported adapter or model-generation cap for this backend.` Lite plus `model_generation_tokens` uses that same message.
- `model_generation_tokens` on an endpoint other than `https://api.openai.com/v1/responses` fails before credentials are loaded. The message is `Model-generation cap is unsupported on this endpoint/adapter.`

## P7. Upstream cut continues the turn

Script a stream that delivers at least one output item and then stalls or drops.

- No tool call from that partial response runs.
- The next body is the previous input, then the received items, then this user text: `The response stream was interrupted. Continue the same turn from the received progress above. Preserve its findings and constraints; do not restart the task or repeat completed work. Proposed tool calls above were not executed; reissue any still needed.`
- `previous_response_id` is absent. No request polls a background job.
- The request row has `cut_after_ms` set to how long the interrupted stream ran, and `resumed: true` on the following attempt.
- A failure before any body byte records `cut_after_ms` null.

## P8. Deadlines and retries

Times below are unscaled (`KOGEN_TIME_SCALE` is 1).

- No body byte for 120 s, including a hang before connect, is class `timeout`. Response headers alone do not count as the first byte.
- A nonempty chunk, then 90 s of silence, is class `stall`. The message is `Provider stream sent nothing for <s> s after it started.`
- One attempt is killed at 20 min.
- `timeout`, `stall`, and `transport` retry while the wall can pay the backoff. `overload` and `malformed` stop at 4 attempts.
- The second consecutive `overload` on ChatGPT resends at once on `gpt-6.1-sol/medium`. `provider_switch.delay_ms` is 0. The planner does not switch. A Grok run does not switch.
- The first `login` or `usage_limit` after the in-call refresh does not stop the Build. The stage is paused and rerun. `provider_wait.budget_paused` is true. The pause is outside the 60 min wall.

## P9. Usage

- Journal `input` equals `input_tokens - cached_tokens` when both are present and cached is not greater than input. Otherwise the missing count stays null.
- `cache_hit_rate` on `kogen status <slug> --json` equals `sum(cached_input) / sum(input + cached_input)`.
- No measured input yields null, not 0.
- The rate does not include the preceding `intent shape` command.

## P10. Grok wire

With the provider selected as `grok`:

- The request is `POST https://cli-chat-proxy.grok.com/v1/responses`.
- Headers include `x-xai-token-auth: xai-grok-cli`, `x-authenticateresponse: authenticate-response`, `x-grok-model-override` equal to the model, `x-grok-client-identifier: kogen`, `x-grok-client-mode: headless`, and `user-agent: kogen/<version>`.
- `x-grok-req-id` is a new UUID on every HTTP attempt.
- When the cache key is non-empty, `x-grok-conv-id` and `x-grok-session-id` equal it. When it is empty, both headers are absent.
- The body has `include: ["reasoning.encrypted_content"]`, `store: false`, `stream: true`, and no `reasoning.summary`.
- `kogen provider login grok` prints `Grok sign-in code: <user_code>` and `Open: <uri>` before it polls.
- Success prints `grok:default signed in` and the email in parentheses when one was returned.
- `kogen provider logout grok` prints `grok:default signed out locally`.
- An empty profile list is two lines: `chatgpt: not signed in` and `grok: not signed in`.
- `kogen provider login grok` is not `unknown provider`.

## P11. Scheduling and status

- Frontmatter `blocks_on` and `priority` round-trip. A higher priority is next.
- Status text contains `Next: <slug> (priority <n>; no dependencies; ties by approval time and slug)` when that Intent is ready.
- An unmet dependency is under `Blocked:` and the detail contains `waiting for delivered dependencies: <slug>`.
- Overview JSON objects include `"priority"` and `"blocks_on"`.
- A reachable commit whose trailer is `Kogen-Intent: <slug>` reports `landed` even when the checkout `intent.md` has since changed.

## P12. Rails detection

- A checkout with both `Gemfile` and `config/application.rb` uses acceptance source `.kogen/acceptance/<slug>_test.rb`, candidate path `test/acceptance/<slug>_test.rb`, and runner `bundle exec rails test <path>`.
- A checkout with only one of those two files does not select Rails.

## P13. Checkpoint epoch

When `build.context_bytes` is at least 16000 and a checkpoint is accepted:

- The summarizer request uses epoch `checkpoint-<turn>`.
- The following builder request uses a new epoch: SHA-256 of the canonical JSON of the checkpoint item.
- That item's text starts with `Continuation of the same approved Build.\n\n`.
- An empty or oversized checkpoint stops the Build with `continuation_failed`.
- Status shows `context continuations: <n> (same approved Build; checkpoints in journal)`.
