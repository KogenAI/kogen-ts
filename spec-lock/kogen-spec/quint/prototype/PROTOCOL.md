# Adapter protocol (xspec/1)

An implementation plugs in through one executable, the **adapter**, that the harness
starts once and talks to over stdin/stdout, one JSON object per line (UTF-8, `\n`).
The adapter wraps the implementation's pure core: `apply(State, Event) -> State` and
`observe(State) -> Obs`. No files, clocks, randomness or network: every input arrives
as an event.

## Requests → responses
| Request | Response |
|---|---|
| `{"op":"reset"}` | the observation of the initial state |
| `{"op":"apply","event":E}` | the observation after applying `E` |

The adapter answers every request with exactly one line and exits 0 at EOF.
Anything it prints to stderr is shown on failure and otherwise ignored.

## Events `E` (tagged; unit events have no `value`)
`{"tag":"Approve","value":{"slug":"alpha","time":1}}` · `{"tag":"Start","value":"r1"}` ·
`{"tag":"Gate","value":true}` · `{"tag":"Step"}` · `{"tag":"Crash"}` · `{"tag":"Interrupt"}` ·
`{"tag":"PushExternal","value":"x1"}` · `{"tag":"Recover"}`

## Observation (compared for exact equality after canonicalisation)
```json
{"last":"ok",
 "status":{"alpha":"landed"},
 "queue":["bravo"],
 "base":["root","r1"],
 "claim":"",
 "incoming":[], "parked":[],
 "runs":{"r1":{"slug":"alpha","status":"landed","reason":""}},
 "proc":{"rid":"","phase":""}}
```
- Absent strings are `""`, never `null`. Sets (`incoming`, `parked`) are arrays; the harness
  sorts them, so order does not matter. `queue` and `base` are ordered lists.
- Object key order does not matter. Integers are plain JSON numbers.
- Semantics of every field and every event are defined by `spec/landing.qnt`. The spec's
  string universe (`SLUG_ORDER`, …) is a modelling device: implementations MUST compare slugs
  as ordinary strings (byte order) and accept any slug.
