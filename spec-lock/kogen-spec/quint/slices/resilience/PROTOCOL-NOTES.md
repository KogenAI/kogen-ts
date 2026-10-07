# Adapter protocol notes: resilience slice (xspec/1)

Pure core: `apply(State, Event) -> State`, `observe(State) -> Obs`. No clocks: all time values are event parameters or decisions in the observation. Integers are milliseconds.

## Events (`{"tag":..,"value":..}`; unit events have no value)
- `Stage {name:str, mode:"build"|"shaping", model:str, fallback:str, owned:bool}`: starts a stage; resets everything (journal, budget, model switch). Refused with `request_in_flight` while phase is sending/refreshing.
- `Request` (unit): begins one request. Needs phase idle. Resets attempts, retries, consec, refresh flag, outage_ms, usage_ms; phase becomes sending.
- `Attempt {result, retry_after_ms:int, elapsed_ms:int, first_byte_ms:int, max_gap_ms:int}`: result is one of `ok, login, usage_limit, overload, timeout, malformed, transport` (already classified); `retry_after_ms < 0` = absent. Deadline miss (first_byte_ms>120000 or max_gap_ms>120000 or elapsed_ms>600000) overrides result with timeout.
- `Refresh bool`: outcome of the forced token refresh requested by a `refresh` decision.

## Observation
```
{"last":"ok","phase":"no_stage|idle|sending|refreshing|stopped","mode":"build","stage":"build",
 "model":"luna","switched":false,"attempts":0,"retries":0,"consec":0,
 "budget_ms":0,"outage_ms":0,"usage_ms":0,"exit":0,
 "decision":{"kind":"","delay_ms":0,"model":"","reason":""},
 "journal":[{"event":"provider_retry","stage":"build","rung":1,"reason":"transport","ms":2000,"from_model":"","to_model":""}]}
```
- `last`: `ok` or a refusal code: `no_stage, request_in_flight, stopped, not_sending, unknown_class, not_refreshing`. A refusal changes nothing but `last`.
- `decision.kind`: `""` (after Stage/Request), `success`, `retry` (resend after `delay_ms`; also 0 after refresh), `switch` (resend on `model` after `delay_ms`), `wait` (usage_limit, `delay_ms` wait with budget paused), `refresh` (do a forced refresh, then send Refresh), `stop` (`reason` = `provider/<class>`, exit 4). `decision.model` is the model for the next send (on stop: current model; scenarios do not check it); `reason` is the error class for non-success, `""` on success.
- Counters: `attempts` (this request), `retries` (ladder retries this request), `consec` (consecutive overload/timeout streak, 0..2), `budget_ms` (Build mode only: sum of elapsed_ms), `outage_ms` (elapsed of attempts + backoff delays since last success; reset on success and Request), `usage_ms` (usage_limit wait total).
- `journal` is the ordered stage journal. Every record has all seven fields, unused ones `""`/0:
  - `provider_retry`: stage, rung (1-based retry number), reason (class), ms (delay).
  - `provider_switch`: stage, from_model, to_model.
  - `provider_wait`: stage `""`, reason (class or `usage_limit`), ms. Only in build mode (budget_paused is implicitly true).
  - Order within one decision: provider_retry, provider_switch, provider_wait.
- Backoff delay for the n-th retry (n from 0) = [2000,4000,8000,16000,32000,60000][min(n,5)].
