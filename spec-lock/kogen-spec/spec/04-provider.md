# 4. Provider, tools and the fake provider

Kogen is its own harness. Every model turn is an HTTP call that Kogen makes itself, and no other agent CLI is ever launched. Kogen uses only its own ChatGPT or Grok login. It never borrows another tool's.

## 4.1 Provider port and test seams
```
respond(ModelRequest) -> ModelResponse | ProviderError
ModelRequest  = { model, effort, instructions, input: [Item], tools: [ToolSchema], prompt_cache_key }
ModelResponse = { id, text, tool_calls: [{id, name, arguments: object}], usage, raw_items: [Item] }
usage         = { input (excluding cached), cached_input, cache_write, output, reasoning }
ProviderError = { class: login|usage_limit|overload|timeout|stall|malformed|transport|incomplete|unsupported, message, retry_after_ms? }
```
- **Stateless.** Every request replays the whole conversation. `previous_response_id` is never sent. An interrupted stream continues by appending the received items and one instruction (§4.9). It does not resume a server job.
- **`prompt_cache_key`** is the persisted cache-affinity key in §4.9. It is stable across conversations in one Build. `thread-id` and journal `conversation_id` identify a stage/attempt/rung/cache-epoch conversation.
- **Seams.** They exist only for tests; production never sets them.
  - `KOGEN_PROVIDER_URL` replaces the responses URL in both modes. `http://` is allowed.
  - `KOGEN_AUTH_URL` replaces `https://auth.openai.com` for login, refresh, discovery and JWKS.
  - `KOGEN_TIME_SCALE` (a decimal, default 1) multiplies every constant marked `scaled: true` in [data/constants.json](data/constants.json): provider first-byte, idle, total, backoff and usage-limit wait; rung walls, the Build budget and the landing allowance; the shell-tool deadline; the login wait; lock staleness and lock wait; and the `--watch` poll (with a 100 ms floor). Project `timeout_ms` values are never scaled. Journal fields such as `delay_ms` record the **unscaled** value.
  - `KOGEN_CREDENTIAL_STORE=file` (v1.1) keeps every login in `~/.kogen/credentials/` as 0600 files and never touches the OS keychain, so login tests cannot write to a real keychain. The conformance runner always sets it.

## 4.2 ChatGPT Responses wire
| Mode | When | URL | Extra headers |
|---|---|---|---|
| owned | the default: a `kogen provider login chatgpt` account | `https://api.openai.com/v1/responses` | run cache `session-id`, conversation `thread-id` (§4.9) |
| injected | `KOGEN_AUTH_PATH` is set (benchmarks and CI) | `https://chatgpt.com/backend-api/codex/responses` | `chatgpt-account-id`, `openai-beta: responses=experimental`, `originator: kogen`, run cache `session-id`, conversation `thread-id` |

- **Headers:** `authorization: Bearer <token>`, `content-type: application/json`, `accept: text/event-stream`. Owned mode sends `user-agent: kogen/0.1`. Injected mode sends `user-agent: kogen/<version>`.
- **Body field order.** Static controls are encoded first, in the order below, and the growing `input` array is the final field. Object keys inside controls and history items are sorted; there is no extra whitespace. On an appended turn using the same model and controls, the encoded bytes through the end of the earlier input array, with only its final `]}` removed, are a prefix of the next body and the next byte is `,`. Identical retry bodies are byte-identical. No implementation may reorder or rewrite earlier history items between turns.
- **Responses mode** (the default, `build.luna_provider_mode: responses`):
  - Injected: `model`, `instructions`, `tools`, `reasoning`, `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, `prompt_cache_key` when set, the controls below, then `input`.
  - Owned: the same order, without top-level `tools` and without `include`. The harness sends its complete canonical tool schema list as a leading input item `{"type":"additional_tools","role":"developer","tools":[…]}`.
  - The harness keeps those schemas identical across roles and limits callable tools with `tool_choice: {"type":"allowed_tools","mode":"auto","tools":[…]}`. A role with no callable tools sends `tool_choice: "none"` while retaining the shared schemas.
- **Controls on every ChatGPT request:** `tool_choice` is `"auto"` (or `"none"` or `"required"` when the stage says so). `parallel_tool_calls` is `false`. Luna (`gpt-6-luna`) sets `text.verbosity` to `"low"` and omits `reasoning.summary`. Other models set `reasoning.summary` to `"auto"`. `max_output_tokens` is sent only for a develop request when `build.model_generation_tokens` is set (§4.9).
- **Lite mode** (`build.luna_provider_mode: lite`) is an opt-in for injected Luna only. The model must be `gpt-6-luna`. `model_generation_tokens` must be unset. `previous_response_id` must be unset. `reasoning.context` is `"all_turns"`. `instructions` is `""`. There is no top-level `tools`. Input starts with an `additional_tools` developer item, then the shared developer instructions, the role-specific developer instructions, and history. The leading items have deterministic ids (§4.9). `include` is `["reasoning.encrypted_content"]`. The request adds headers `x-openai-internal-codex-responses-lite: true` and `session_id` set to a stable run-level protocol id. An owned login cannot select Lite. That attempt fails as `unsupported` with `Unsupported adapter or model-generation cap for this backend.` The same message is used when Lite is combined with a generation cap. A generation cap on an endpoint other than `https://api.openai.com/v1/responses` fails earlier, before credentials are loaded, with `Model-generation cap is unsupported on this endpoint/adapter.` There is no fallback to another shape.
- **Never sent:** `previous_response_id`, `temperature`, a body `session_id` (except the Lite header above), `conversation_id`.
- **Items:**
  - user message: `{"role":"user","content":[{"type":"input_text","text"}]}`
  - tool result: `{"type":"function_call_output","call_id","output"}`
  - The previous response's raw items are replayed verbatim, before its tool results.
- **ToolSchema:** `{"type":"function","name","description","parameters":{"type":"object","properties","required","additionalProperties":false},"strict":false}`. The builder's `finish` tool is `strict: true` (§3.6).

## 4.3 Streaming
- **Framing.**
  - Normalise CRLF and CR to LF. A frame ends at a blank line.
  - Only `data:` lines count; one leading space is stripped, and multiple data lines are joined with `\n`.
  - `[DONE]` and empty data are skipped. The last partial frame is flushed when the stream ends.
- **Events:**
  - `response.output_item.done` → collect its `item`.
  - `response.completed` → keep its `response`. A second one is malformed.
  - `error`, `response.failed`, `response.incomplete`, or any non-null top-level `error` → a failure, classified by substring of the lowercased event:
    - `usage_limit`, `usage limit`, `rate_limit` or `rate limit` → `usage_limit`;
    - otherwise `overload` → `overload`;
    - otherwise `transport`.
  - Other objects are ignored. Invalid JSON is malformed.
- **Assembly.** The first matching rule decides:
  - A failure wins.
  - Then malformed.
  - No `completed` event → malformed.
  - Otherwise assemble the response:
    - `status` must be `completed` and `id` must be non-empty.
    - `raw_items` = `completed.output` if it is non-empty, otherwise the collected items in arrival order.
    - `text` = the `output_text` parts of `message` items.
    - `function_call` items need `call_id`, `name`, and `arguments` as an object or as a JSON string of an object.
    - `usage` comes from `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens` (≤ input), `cache_write_tokens` and `output_tokens_details.reasoning_tokens`.
- **Size cap:** a body over 16 MB is malformed.

## 4.4 Error classes
| Condition | Class | Message |
|---|---|---|
| HTTP 401 or 403 | login | `ChatGPT rejected the login; sign in again.` |
| HTTP 429, or a body with `usage_limit` / `usage limit` | usage_limit | `ChatGPT subscription usage limit reached. Manage usage: https://chatgpt.com/settings/usage` |
| HTTP 5xx, or a body with `overload` | overload | `ChatGPT service is temporarily overloaded.` |
| any other non-2xx | malformed | `ChatGPT rejected the request (HTTP <status>).` |
| first-byte, idle, or total deadline | timeout | `ChatGPT request timed out.` |
| stream went silent after bytes | stall | `Provider stream sent nothing for <s> s after it started.` |
| connect, TLS, reset, or proxy failure | transport | `ChatGPT request could not connect.` |
| response `incomplete` | incomplete | `Model response incomplete (<reason>); no tool calls were executed.` |
| generation cap on an endpoint that rejects it | unsupported | `Model-generation cap is unsupported on this endpoint/adapter.` |
| injected auth file missing, malformed or with an expired JWT | login | `Codex login is missing, invalid, or expired.` |

On a 429 or 503, the `retry-after` header (seconds) or a `resets_in_seconds` field in the body sets `retry_after_ms`.

## 4.5 Deadlines, retries, waits, fallback
v1.2 follows the deadlines and retry decisions the Build tests assert. The v1.1 figures of 120 s idle, 600 s total, and a second stage-retry layer do not.
- **Per-request deadlines:**
  - First byte within **120 s**. This clock starts before the refresh lock, credential load, and connect. Headers alone are not body bytes. A nonempty body chunk, including a comment or a keepalive, counts.
  - After the first byte, at most **90 s** of silence. That is a `stall`, not a `timeout`. The HTTP read allows 300 s between chunks. The 90 s clock fires first.
  - At most **20 min** for one attempt (`1_200_000` ms). That is a last resort. Hard turns reason for more than 10 minutes, so the cap is not 10 minutes.
  - An upstream stream that dies at about **900 s** while bytes are still arriving is a cut (§4.9). It is not a client constant. The client continues the turn. It does not raise the idle timer to outlast it.
- **Transient errors** are `timeout`, `stall`, `transport`, `overload`, and `malformed`. Record `provider_retry`.
  - **Identical resend.** When the attempt received no items, resend the same request.
  - **Continuation.** When the attempt received items and the class is `timeout`, `stall`, `transport`, or `malformed`, the next input is the previous input, then those items, then the continuation instruction in §4.9. `previous_response_id` stays unset.
  - **Attempt cap.** `overload` and `malformed` get at most **4** attempts. `timeout`, `stall`, and `transport` do not spend that cap while the wall budget can pay the next backoff. With no wall budget, every class stops at 4 attempts.
  - **Backoff.** The ceiling after the n-th failed attempt is 2, 4, 8, 16, 32, then 60 s. The delay is drawn uniformly between half the ceiling and the ceiling. `provider_retry.delay_ms` records the actual, unscaled delay. A retry whose delay does not fit in the remaining wall budget is not made.
  - **Model switch.** After **2 consecutive `overload`** errors on one request, any other class resets the streak. The request is resent at once (`delay_ms` 0) on the role's fallback. Record `provider_switch` (`from_model`/`to_model` as `<model>/<effort>`). The default fallback is `gpt-6.1-sol/medium` for the builder, the context role, and the reviewer. The planner has no fallback. A role already on its fallback does not switch. A Grok run has no fallback (§4.10). `build.model_fallback: false` or `KOGEN_BENCH_NO_FALLBACK=1` keeps the same model and retries `overload` for as long as the wall budget lasts. Encrypted reasoning from the previous model is dropped on a switch. Same-model retries keep it.
  - **No second stage-retry layer.** When the request policy stops, the Build ends **`stopped provider/<class>`**. The Intent stays queued. The drain stops with exit 4. Provider trouble never fails an Intent.
- **Budget clock.** Backoff waits and login or usage-limit pauses do not count against the Build budget. Request time does.
- **`usage_limit` and `login` are not transient retries.** They do not spend the attempt cap.
  - **Inside the provider call.** Owned ChatGPT, and Grok, do one forced token refresh and resend once. That resend happens only when the stored access token is still the rejected one.
  - **On a Build.** If the error is still `usage_limit` or `login`, the ladder pauses and reruns that stage. Each pause is **5 min** (`300_000` ms). Pauses sit outside the Build budget. They stop after **24 h** (`86_400_000` ms) in total. Record `provider_wait` with `budget_paused: true`. The Build then stops (`stopped provider/<class>`) and the drain exits 4.
  - **Shaping** has no ladder pause. The same per-request rule applies, then shaping exits 4.
- **`incomplete`.** No tool call from that response runs. Reported token counts are kept. A missing count stays null. The class is not retried as a success.
- **One retry layer.** The request policy above is the only place that retries provider errors.

## 4.6 Logins and credentials
**Credential store interface.** A credential is stored per provider and label.
```
get(label) -> Credential | none     put(label, Credential)     delete(label)
Credential = { client_id, access_token, refresh_token, id_token, expires_at, scopes, subject, email|null, host_id }
```
Secrets never go into a repo, argv, logs or transcripts, and are never world-readable. The backend is up to the implementation; the reference uses an 0600 JSON file on Linux, and on macOS an AES-256-GCM file whose key is kept in the Keychain. With `KOGEN_CREDENTIAL_STORE=file` (a test seam, §4.1) every platform uses the 0600 JSON file under `~/.kogen/credentials/`.

**Loopback port.** The callback listener on 127.0.0.1:1455 binds with address reuse, so a second login within the TCP TIME_WAIT of the first still works.

**Sign in with ChatGPT (PKCE).**
1. **Discovery** at `<auth>/.well-known/openid-configuration`. The issuer must be `https://auth.openai.com`.
2. **Authorize** at `<auth>/api/accounts/authorize`.
   - Query: `client_id`, `ext_agent_host_id`, `response_type=code`, `redirect_uri=http://127.0.0.1:1455/auth/callback`, `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, `state`, `nonce`, `code_challenge_method=S256`, `code_challenge`.
   - The first registration uses `client_id=dynamic_agent_client` and adds `agent_name_hint=Kogen`.
3. **Loopback.** Wait up to 300 s. Answer `Kogen sign-in complete. You can close this tab.`, or `Kogen could not verify this sign-in callback.` on a mismatched `state`.
4. **Token exchange** at `<auth>/api/accounts/oauth/token`. The response must include `chatgpt.tokens.use.direct` among its scopes.
5. **id_token checks:** RS256 via JWKS; `iss`; `aud` contains the client id; `exp` in the future; `nonce` matches; `sub` is non-empty. If `sub` changes for an existing label, refuse.

**Refresh.**
- When the token expires within 300 s, and once after a 401.
- Use the lock `~/.kogen/locks/chatgpt-<label>.lock`. Its owner file holds `<pid> <ms> <token>`. It goes stale after 60 s. Waiters poll every 25 ms for up to 90 s. An empty owner file is not stale while the writer holds the directory. Staleness then uses the directory's modification time. Grok uses the lock name `grok-<label>`.
- Re-read the credential after taking the lock. Only one process refreshes.

**Logout:** revoke the token, then delete the credential.

**Injected auth.** `KOGEN_AUTH_PATH` points at `{"tokens":{"access_token":"<JWT>","account_id":"<id>"}}`.
- The JWT's `exp` must be in the future; the signature is not checked.
- The file is re-read before every request and never refreshed.

**One account per run.** Each run resolves one account label (§2.7) and records `credential_source` and `credential_label`. It never falls back to another account.

## 4.7 Tools
| Role | Tools |
|---|---|
| builder (shell recipes, including `ladder`) | `shell`, `finish`, `tool_output` |
| builder (`direct`, `direct-escalate`) | `read`, `search`, `edit`, `write`, `shell`, `finish`, `tool_output` |
| shaper | `read`, `search`, `write` (`write` only to its two paths) |
| planner, auditor | none |

| Tool | Parameters | Result |
|---|---|---|
| `shell` | `cmd` | Writes the command bytes to a mode-0600 private script in the run dir and runs `sh <script path>`; the command is never an argv element. stdin is `/dev/null`; the working directory is the workspace; the sandbox applies (§5.3); the deadline is a fixed 120 s; stdout and stderr are merged. The model sees the full process log, then the tool-result budget (§4.9.3). If the log is missing, the result starts `[process log unavailable; captured tail may be incomplete]\n`. A timeout result starts `timed out after 120 seconds\n`. |
| `finish` | `{}` only | Builder only. `strict: true`. It must be the only tool call. Result: `Completion requested. Kogen will run the gate.` Any other shape: `finish requires an empty object and must be the only tool call. Continue implementing, then call finish alone with {}.` (§3.6). |
| `read` | `path`, `offset` (default 1), `limit` (1–400, default 200) | `<rel>:\n<n>: <line>…`, plus `\n[continue with offset=N]` if more remains. Errors: `ERROR: File does not exist.`, `ERROR: File is binary or is not UTF-8 text.`, `ERROR: limit must be between 1 and 400.` |
| `search` | `pattern`, `path` (default `.`) | `rg`, falling back to `grep`. There is no 200-line cap. The tool-result budget is the cap (§4.9.3). No matches: `No matches.` |
| `write` | `path`, `content` | `Wrote <rel>.` The file bytes are not shortened. Writes outside the shaper's scope get `ERROR: Write target is outside the shaper's two-file scope. Allowed paths: <a>, <b>.` |
| `tool_output` | `handle`, `output_offset`, `output_limit` | Reads a stored tool result (§4.9.3). A bad handle: `ERROR: Unknown or unavailable tool-output handle.` |

- **Paths** resolve through symlinks and must stay inside the workspace; otherwise the result is `Path escapes the worktree.`
- **Other errors:** an unknown tool gets `ERROR (tool_not_allowed): This stage does not allow the requested tool.`; bad arguments get `ERROR (invalid_arguments): Tool arguments do not match the schema.`; extra arguments (such as `timeout_ms`) are ignored.
- **Tool-result budget** (§4.9). The 10,000-character tail clip is not used. A result the model sees is bounded by `build.tool_result_tokens`. The file a `write` creates is not shortened. Only the text returned to the model is.

## 4.8 Fake provider (conformance)
One fake server is written once and shared by every implementation's test run.
### 4.8.1 Endpoints
- **`POST /v1/responses`.** Record `{headers, body}`, then serve the first unconsumed script step whose `expect` matches. If none matches, return HTTP 400 `{"error":{"message":"scripted_mismatch"}}` and mark the request unmatched.
- **Inspection:**
  - `GET /_fake/requests` → `[{step, role, turn, headers, body}]`
  - `GET /_fake/remaining`
  - `POST /_fake/reset`
- **OAuth endpoints** (fake browser flow): `/.well-known/openid-configuration`, `/api/accounts/authorize` (302 to the callback with the same `state`), `/api/accounts/oauth/token`, `/jwks`, `/revoke`.
### 4.8.2 Roles and turns
**Role.** The fake infers the role from a marker sentence that implementations MUST include verbatim in that role's system prompt:

| Role | Marker |
|---|---|
| shaper | `You are Kogen Intent shaper.` |
| planner | `one-shot implementation plan for a cheaper coding agent` |
| builder | `You are Kogen's builder.` |
| requirement auditor | `You are Kogen's requirement auditor.` |
| test auditor | `You are Kogen's acceptance test auditor.` |

Settled in v1.1: the **build auditor** (§3.8.2) and the **witness adjudication** (§3.2.7) use the test-auditor marker (the reference's build-time auditor uses it). The **fallback shaper** uses the shaper marker; the fake tells it apart by its model and its fresh conversation. The **requirement auditor** replies `{"rows":[{"constraint","maps_to"}]}`, the shape of `ledger.json`.

**Conversation and turn.**
- A **fresh conversation** is a request whose `input` holds exactly one user message (not counting the `additional_tools` item).
- **`turn`** = 1 for a fresh conversation, plus 1 for each later request of the same role whose input extends the previous one.
### 4.8.3 Script steps (JSON Lines)
```json
{"id":"s3","expect":{"role":"builder","model":"gpt-6-luna","effort":"max","tools":["shell"],"turn":2,
  "input_contains":["## Request"],"last_output_contains":"exit 0"},
 "reply":{"calls":[{"name":"shell","arguments":{"cmd":"printf 'Hello, Almir!\\n' > lib/greet.txt"}}]}}
```
- **Replies:**
  - `{"text"}`: one assistant message. For a builder this is progress, not completion (§3.6). Completion is a `finish` call.
  - `{"calls":[{name, arguments}]}`: call ids are `call_<step>_<i>`, and `arguments` are serialised as a JSON string.
  - `{"items":[…]}`
  - `{"sse":[data…]}`
  - `{"http":{"status","body","headers"}}`
- **Modifiers:** `first_byte_ms`, `chunk_gap_ms`, `drop_after_events`, `repeat`, `side_effect_sh` (a command the server runs before replying, for example a commit that moves the origin's base).
- **Delays** are given unscaled; the server divides them by `KOGEN_TIME_SCALE`.
- **Successful replies** stream one `response.output_item.done` per item, then `response.completed` with `id` `resp_<n>`, `status` `completed`, empty `output` and usage. Frames are written `event: <type>\ndata: <json>\n\n`.
- **Pass condition.** A test passes only with no unmatched requests and, unless it says otherwise, no remaining steps.

## 4.9 Provider requests and prompt caching
These rules are what a fake provider can observe. They exist so a conversation stays cacheable. The owner's ≥ 0.95 release target applies to designated warm requests of a frozen, feasible smoke workload (§4.9.5), not to every third-and-later request in arbitrary workloads. A scripted test proves the wire rules below. It does not prove a live cache hit.

Source reading for the rewrite: the local Codex source (`benchmark-night-2026-10-01/harness-mining/src/codex/codex-rs/core/src/client.rs`, `prompt_cache_key` and `responses_session_id`) keeps cache affinity stable and supplies it to the Responses request and root session header. The local pi source (`pi-mono/packages/ai/src/providers/openai-codex-responses.ts`, `buildRequestBody` and `buildSSEHeaders`) carries a caller session id into `prompt_cache_key` and the SSE `session_id` header. Kogen's v3/run key and v2/thread separation below are its own deterministic contract, inferred from those patterns and D44; neither source fixes Kogen's exact hash formula. No credentialed run is required to verify this source reading.

### 4.9.1 Conversation key
Cache affinity and conversation identity are separate.

The cache-affinity key is a nonempty opaque identifier selected by the versioned adapter and persisted with the invocation. It is safe to send to the provider (no path or secret) and identical after a process restart. Run-scoped affinity is permitted, but distinct Builds or Shapes need not have different affinity keys. An adapter MAY use a broader safe scope only with separate-session versus same-session replay measurements; keep provider/model cache namespaces and account/security boundaries separate, without putting credentials in the key. A lowercase hex SHA-256 of the following NUL-separated material is one permitted construction, not a wire requirement:

```
kogen:responses:cache:v3
<expanded run directory>
```

- The key is stable across every stage, attempt, rung, retry and context epoch in one Build run. It is sent as the body field `prompt_cache_key` and the `session-id` header. Different run directories always have distinct conversation identities, even when the adapter selects shared cache affinity.

The conversation thread id is a distinct opaque identifier for each `(run, stage, attempt, rung, epoch)` tuple. Reconstructing that same tuple after a restart yields the same thread id. A lowercase hex SHA-256 of the following NUL-separated material is one permitted construction, not a wire requirement:

```
kogen:responses:v2
<expanded run directory>
<stage>
<attempt>
<rung>
<epoch>
```

- `attempt` defaults to `builder`. `rung` defaults to the attempt. `epoch` defaults to `initial`.
- The same thread id is used for every turn, retry, and same-session repair of that stage, attempt, rung and epoch. A different rung, fresh attempt, stage or epoch has a different thread id. The run-level `prompt_cache_key` does not change with it.
- The model and effort are not part of the thread id. A fallback model keeps the thread id, while its serialized request changes for the model; encrypted reasoning from the old model is removed.
- Mutation advice uses epoch `mutation-advice`. A checkpoint summarizer uses epoch `checkpoint-<turn>`. After a checkpoint is accepted, the next epoch is the lowercase hex SHA-256 of the canonical JSON of the checkpoint item, and only when that item's text starts with `Continuation of the same approved Build.\n\n`.
- The thread id is sent as the `thread-id` header and recorded as `conversation_id` in the request journal. The journal separately records `cache_key` and `thread_id`. Tests compare identity and stability, not their hash bytes.
- Lite's `session_id` header is a separate stable run-level protocol id; it is not the cache-affinity key or conversation thread id.

### 4.9.2 Byte-stable prefix
For the same adapter/prompt/tool-schema version, the harness MUST use byte-identical generic developer instructions and complete canonical tool schemas across roles and independent invocations: separate Shapes, separate Builds, and Shape-to-Build. Timestamps, run ids, paths, request/Intent bytes and other variable task data MUST follow the static prefix. Conversation identity remains distinct; provider/model cache namespaces remain separate. Role-specific developer instructions follow that shared prefix. `allowed_tools` restricts which schemas each role may call; a role with no callable tools uses `tool_choice: "none"` but retains the shared schemas. For GPT-6 and GPT-5.6 models the shared instruction item carries an explicit cache breakpoint, with implicit caching enabled.

For successive requests on the same model in a conversation:

- Role instructions, tool schemas and their order, `model`, `effort`, `store`, `stream`, `include` or its absence, `prompt_cache_key`, and thread id are unchanged.
- Every earlier input item is unchanged, in order.
- New items are appended: the response's raw items, then each tool result, then later user notes.

A model fallback changes `model` and drops encrypted reasoning from the prior model, so the different model cannot reuse that model's cached tokens.

When a new stage, attempt, rung or epoch starts, the shared instructions and canonical schemas remain byte-identical so the new conversation can reuse that prefix when model and other cache-relevant settings match. The run cache key and `session-id` header keep the request in the same cache affinity, while its `thread-id` remains distinct. Across independent invocations, the static prefix remains identical under matching versions even if affinity differs; publish request-level telemetry for both same-session and separate-session fixtures. Shared affinity is a measured adapter choice, not a presumed cache benefit.

The late turn-budget note is one of those appended user items. It is not written into `instructions`. It is appended once, when completed turns reach `div(max_turns * 4 + 4, 5)` (48 when the cap is 60), and it stays in the history. The text is `System note: <N> turns remain. Run the targeted tests now and finish the smallest complete change.`

Approved Intent bytes and the plan lead the history. Controller failures, protected-file notes, and the continuation instruction append after them.

`store` is `false`. The harness does not set `previous_response_id`.

A closed JSON object cannot be a byte prefix of a larger closed object. The check removes only the final `]}` of the earlier body for turns that append at least one input item; every remaining byte is a prefix of the next body, and the next byte is `,`. A retry without an appended item has the same body bytes instead.

An opt-in context checkpoint intentionally replaces history. It changes the thread id but keeps the run cache-affinity key and shared static prompt prefix.

### 4.9.3 Tool-result budget
`build.tool_result_tokens` defaults to **2000**. The allowed range is **128** to **100000**. The project value wins over the machine value. A tool call may set `tool_result_tokens` for that call. The estimate is **4 UTF-8 bytes per token**. The cap is `tokens * 4`.

`output_offset` (default 0) and `output_limit` (default the rest of the text) select a zero-based byte range. Read's `offset` and `limit` still select source lines, and they apply first.

- A complete result that fits is returned unchanged.
- Otherwise a notice of 320 bytes is reserved. If the selected text plus the notice fits, the notice is appended. If not, the result keeps half of the remaining cap from the start and the same amount from the end, with the notice between them.
- The notice is: `\n[truncated/range: <total> bytes; shown byte ranges <ranges>; retrieve with tool_output handle=<handle>, output_offset and output_limit]\n`
- Boundaries move inward so a UTF-8 code point is not split.
- Non-UTF-8 output becomes `[non-UTF-8 output, base64 encoded]\n` plus base64 of the whole payload, and then the budget applies.
- The handle is the lowercase SHA-256 of the redacted full text. The full text is stored as `tool-result-<handle>.log` in the run's logs. `tool_output` reads it back. The handle must be 64 lowercase hex characters and the file must be a regular file. A symlink is refused: `ERROR: Unknown or unavailable tool-output handle.`
- Search is not capped at 200 lines. The token budget is the cap.
- Shell output is the full process log. If the log is missing, the result starts `[process log unavailable; captured tail may be incomplete]\n`.
- Bytes written to a file are not shortened. Model-generated tool arguments are not shortened.

`build.model_generation_tokens` is optional. The range is **1** to **100000**. It is unset by default. It applies only to develop requests, as `max_output_tokens`. It is separate from the tool-result budget. It is rejected, before credentials are loaded, on Lite and on an endpoint other than `https://api.openai.com/v1/responses`, unless that endpoint is marked as supporting the cap.

An incomplete response does not execute tool calls. Items still marked in progress in a completed envelope do not execute either.

### 4.9.4 The upstream cut and continuation
The ChatGPT backend has been observed to cut a stream at about 901–931 s while bytes are still arriving. That is not a client timeout. Kogen does not poll a background job and does not send `background: true`.

On `timeout`, `stall`, `transport`, or `malformed`, when any items were received:

1. Keep partial assistant text, completed encrypted reasoning, reasoning summaries, and proposed tool arguments.
2. Do not execute those tool calls. Even a completed proposal must be reissued.
3. The next request's input is the original input, then the received items, then this user message:

```
The response stream was interrupted. Continue the same turn from the received progress above. Preserve its findings and constraints; do not restart the task or repeat completed work. Proposed tool calls above were not executed; reissue any still needed.
```

Repeated cuts accumulate. On success, assistant text from the continued items is prefixed to the final text, and those items stay in the history. A changed model drops encrypted reasoning from the previous model.

The request journal has one row per attempt. `cut_after_ms` is how long an interrupted stream ran, or null when the attempt failed before any body byte. `resumed` is true when the attempt carries progress from an earlier attempt.

### 4.9.5 Usage
`input` in the journal excludes cached tokens: `input_tokens - cached_tokens`, when both are present and cached is not greater than input. `cached_input` is `cached_tokens`. Missing counts stay null.

```
cache_hit_rate = sum(cached_input) / sum(input + cached_input)
```

Output and reasoning are outside that denominator. No measured input means null, not zero. `kogen status <slug> --json` and the benchmark `usage.json` include `cache_hit_rate` as a fraction from 0 to 1. The Build rate excludes the preceding shape command. The offline report groups requests by provider/model/adapter/prompt version, invocation and `conversation_id`. It reports raw weighted hit rate and eligible-prefix reuse separately. For request i, let P_i be the unchanged repeated prefix under the adapter's tokenization and cache controls, E_i the cache-eligible token count after its declared minimum, block rounding, retention and namespace rules, C_i the observed cached input, and T_i total input. Report `eligible_prefix_reuse = min(C_i, E_i) / E_i` only when E_i > 0 and all inputs to that calculation are known; report zero-eligible requests as inapplicable. Report excess C_i rather than hiding it in that ratio. Block size (including the review's supplied 1,024-token premise) is adapter-specific, never a universal guarantee. Missing usage or unknown eligibility is **incomplete measurement**, distinct from an observed cache miss, and cannot establish a release pass. Weighted totals with unknown attempts are explicitly partial.

**Frozen release replay.** Before measuring, freeze the model/endpoint/adapter/prompt versions, cache namespace/affinity policy, tokenizer or captured token counts, minimum/block rules, retention intervals, request sequence, designated third-and-later warm requests and appended-token budget. Demonstrate theoretical feasibility: `E_i / T_i >= 0.95` for every designated warm request. Keep the owner threshold: complete telemetry and observed `C_i / T_i >= 0.95` on every such request are required. Report eligible-prefix reuse as a diagnostic alongside it. A feasible live replay is required; fake usage proves accounting only. Arbitrary production conversations report metrics without this universal threshold: perfect reuse of 4,096 repeated tokens with 1,000 appended tokens gives only 80.38%. D44/D49 are historical decisions, not calibration data; their later cancellation note remains part of the history. v1.3-draft neither claims a qualifying live receipt nor lowers the owner's threshold.

### 4.9.6 Opt-in context checkpoint
`build.context_bytes`, minimum 16000, opts into a checkpoint. It is serialized history bytes, not a token count. Omission leaves the normal loop. Machine defaults do not enable it.

Before the next builder turn, the same builder makes one request with no tools. The next conversation starts with the original approved request and plan, verbatim, plus the checkpoint. The checkpoint's text starts with `Continuation of the same approved Build.\n\n`. Invalid, empty, or oversized checkpoints stop the Build with `continuation_failed`. The worktree, approval, turn cap, wall budget, and repair policy do not reset. `status <slug>` reports how many continuations the Build used. The summarizer has its own cache epoch. The compacted history starts a new epoch (§4.9.1).

## 4.10 Grok provider
Grok is a second provider. The verbs are the ones in §1.2. There is no new flag.

### 4.10.1 Selection
`KOGEN_BENCH_PROVIDER` must be `chatgpt` or `grok` when set. Otherwise the provider is the checkout's `selection.projects` row, else `selection.default`, else `chatgpt`. The account is `KOGEN_BENCH_ACCOUNT` when set, else that provider's project row, else a committed `account:` only for ChatGPT, else that provider's `default`, else `default`. `KOGEN_AUTH_PATH` is ChatGPT only. Grok ignores it.

`accounts.yaml` gains, beside the ChatGPT map:

```yaml
grok:
  default: <label>
  projects:
    - path: "<canonical checkout>"
      account: <label>
selection:
  default: chatgpt
  projects:
    - path: "<canonical checkout>"
      provider: chatgpt
```

A builder model that starts with `grok-` keeps every role on Grok. Defaults when unset: builder and shaper `grok-4.6` at effort `high`. There is no effort whitelist. The string is sent as `reasoning.effort`. Its Shape fallback conversation inherits the effective Grok shaper and stays on Grok (§3.2.1); this is a fresh-conversation retry. A Grok run sets no overload model fallback. Overload stays on the same model.

### 4.10.2 Sign-in
Device-code OAuth against `https://auth.x.ai`. Kogen does not launch the Grok CLI and does not read its credential file.

1. Discovery: `GET <issuer>/.well-known/openid-configuration`. HTTP timeout 20 s.
2. Device request: form body `client_id=b1a00492-073a-47ea-816f-4c329264a828` and `scope=openid profile email offline_access grok-cli:access api:access`. If discovery omits the device endpoint, use `<issuer>/oauth2/device/code`. The token endpoint comes from discovery. Both must be `https` with no userinfo.
3. Print `Grok sign-in code: <user_code>` and `Open: <verification_uri_complete or verification_uri>`.
4. Poll the token endpoint with grant `urn:ietf:params:oauth:grant-type:device_code`. Wait before every poll, including the first. The interval is `max(interval, 1)` seconds, or 5 s when the interval is missing. `interval: 0` waits 1 s. The deadline is `expires_in` seconds. `authorization_pending` retries. `slow_down` adds 5 s. `expired_token` and `access_denied` stop.

Refresh uses grant `refresh_token`, the same client id, a 20 s HTTP timeout, and the lock `grok-<label>`. A token is stale when it expires within 300 s. A new refresh token replaces the old one and is saved before reuse. A missing refresh token keeps the old one. HTTP 401 does one forced refresh when the stored access token is still the rejected one, then one replay.

Stored fields: `access_token`, `refresh_token`, `expires_at` (unix seconds), `scopes`, `email` or null, `client_id`, `token_endpoint`. The profile side file records `email`, `expires_at`, and `signed_in` under `grok.<label>`. On macOS the secret is AES-256-GCM in `~/.kogen/credentials/grok-<label>.enc`. The keychain service is `kogen` and the account is `grok:<label>:key`. Other platforms, and `KOGEN_CREDENTIAL_STORE=file`, use `~/.kogen/credentials/grok-<label>.json` mode 0600. Logout deletes the credential and sets `signed_in` false. It does not revoke the remote token.

### 4.10.3 Request
`POST https://cli-chat-proxy.grok.com/v1/responses`. Per attempt: 300 s HTTP read, 120 s to the first byte, 20 min total. The 90 s idle stall is the same as ChatGPT.

Headers:

```
authorization: Bearer <access_token>
x-xai-token-auth: xai-grok-cli
x-authenticateresponse: authenticate-response
x-grok-model-override: <model>
x-grok-client-identifier: kogen
x-grok-client-mode: headless
x-grok-client-version: <version>
user-agent: kogen/<version>
accept: text/event-stream
x-grok-req-id: <a new UUID on every HTTP attempt>
x-grok-conv-id: <prompt_cache_key>
x-grok-session-id: <prompt_cache_key>
```

The two cache headers are omitted when the key is empty.

Body: `model`, `instructions`, `input`, `tools`, `reasoning: {"effort"}`, `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, and `prompt_cache_key` when set. No `reasoning.summary`. No `previous_response_id`. The full input is sent every turn. The same conversation key and the same prefix rules as §4.9 apply. Tool calls and usage use the ChatGPT item shapes and the same `input = input_tokens - cached_tokens` rule.

| Condition | Class | Message |
|---|---|---|
| no saved login | login | `Grok login is missing or invalid; run \`kogen provider login grok\`.` |
| HTTP 401 | login | `Grok rejected this session; run \`kogen provider login grok\`.` |
| HTTP 403 | login | `This Grok account cannot access the requested model.` |
| refresh timed out | login | `Grok session refresh timed out.` |
| refresh could not connect | login | `Grok session could not refresh. Check the network and sign in again.` |
| refresh failed again | login | `Grok login is unavailable; run \`kogen provider login grok\`.` |
| HTTP 429, or a body with `usage_limit`, `usage limit`, `quota exceeded`, or `rate limit` | usage_limit | `Grok subscription usage limit reached.` |
| HTTP 5xx, or a body with `server_is_overloaded`, `overloaded`, or `overload` | overload | `Grok service is temporarily overloaded.` |
| deadline | timeout | `Grok request timed out.` |
| connect failure | transport | `Grok request could not connect.` |
| body over the size cap | malformed | `Grok response exceeded the size limit.` |
| bad stream | malformed | `Grok returned a malformed response stream.` |
| other non-2xx | malformed | `Grok rejected the request (HTTP <status>).` |

Device-login failures print a single sentence and exit 4 when they are a login class, otherwise they are a Kogen bug only if the implementation fails to map them. The mapped sentences are: `Grok sign-in timed out.` · `Grok sign-in could not connect to xAI.` · `Grok sign-in was cancelled.` · `Grok sign-in code expired; run \`kogen provider login grok\` again.` · `Grok returned an invalid sign-in endpoint.` · `Grok returned an invalid sign-in discovery document.` · `Grok returned an invalid device sign-in response.` · `Grok returned an invalid sign-in token response.` · `Grok sign-in discovery failed (HTTP <status>).` · `Grok device sign-in failed (HTTP <status>).` · `Grok sign-in polling failed (HTTP <status>).` · `Invalid Grok account label.`

Retries are §4.5, except there is no model fallback. `login` still does the one refresh and one replay inside the provider call.
