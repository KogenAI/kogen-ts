# Plain-English source: provider resilience (verbatim excerpts from the Kogen core spec)

ModelRequest  = { model, effort, instructions, input: [Item], tools: [ToolSchema], prompt_cache_key }
ModelResponse = { id, text, tool_calls: [{id, name, arguments: object}], usage, raw_items: [Item] }
usage         = { input (excluding cached), cached_input, cache_write, output, reasoning }
ProviderError = { class: login|usage_limit|overload|timeout|malformed|transport, message, retry_after_ms? }
```


## 4.4 Error classes
| Condition | Class | Message |
|---|---|---|
| HTTP 401 or 403 | login | `ChatGPT rejected the login; sign in again.` |
| HTTP 429, or a body with `usage_limit` / `usage limit` | usage_limit | `ChatGPT subscription usage limit reached. Manage usage: https://chatgpt.com/settings/usage` |
| HTTP 5xx, or a body with `overload` | overload | `ChatGPT service is temporarily overloaded.` |
| any other non-2xx | malformed | `ChatGPT rejected the request (HTTP <status>).` |
| first-byte, idle or total deadline | timeout | `ChatGPT request timed out.` |
| connect, TLS, reset or proxy failure | transport | `ChatGPT request could not connect.` |
| injected auth file missing, malformed or with an expired JWT | login | `Codex login is missing, invalid, or expired.` |

On a 429 or 503, the `retry-after` header (seconds) or a `resets_in_seconds` field in the body sets `retry_after_ms`.

## 4.5 Deadlines, retries, waits, fallback
- **Per-request deadlines:** first byte within 120 s; at most 120 s between body chunks; at most 600 s in total. Missing any of them is a `timeout`.
- **Transient errors** (`timeout`, `transport`, `overload`, `malformed`): resend the identical request after 2, 4, 8, 16, 32, then 60 s on every later retry, and record `provider_retry`.
  - **Model switch.** After 3 consecutive `overload` or `timeout` errors on one request, switch that stage to the `build.fallback` model (Luna ↔ Sol). Record `provider_switch`; it lasts for the rest of the stage.
- **Budget clock.**
  - Backoff waits do not count against the Build budget (`provider_wait`); request time does.
  - If no request has succeeded for longer than the **outage window** (30 min), the Build ends as **`stopped provider/<class>`**. The Intent stays queued and the drain stops with exit 4.
- **`usage_limit`.** Wait `retry_after_ms`, or 15 min if there is none, with the budget paused. Repeat until the usage limit has lasted 6 h in total; then stop the Build (`stopped provider/usage_limit`).
- **`login`.** Do one forced token refresh (owned mode). If that fails, stop the Build (`stopped provider/login`); the drain stops with exit 4.
- **Shaping** uses the same rules with no budget clock and at most 8 attempts per request, then exits 4.
- **One retry layer only.** No other layer retries provider errors.

Journal events (02-formats.md):
| `provider_retry` | stage, rung, reason, delay_ms (unscaled) |
| `provider_switch` | stage, from_model, to_model |
| `provider_wait` | reason, wait_ms (unscaled), budget_paused true |

Constants (data/constants.json, provider group, unscaled values): first_byte_ms 120000, idle_gap_ms 120000, request_total_ms 600000, backoff_ms [2000,4000,8000,16000,32000,60000], switch_after_consecutive 3, outage_window_ms 1800000, usage_limit_max_wait_ms 21600000, usage_limit_default_wait_ms 900000, shaping_attempts_per_request 8.
