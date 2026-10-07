// Provider stream policy. Sources: spec §4.5, §4.9.4, §4.9.6 (v1.2, read 2026-10-06).
// One model request. Deadlines arrive already classified: first byte and the 20 min cap are
// timeout, 90 s of silence is stall, an upstream cut with no items is transport, and a cut
// after items with no completed frame is malformed. The delay recorded here is the backoff
// ceiling. The wall is not reduced by a wait. A retry that cannot pay that ceiling is not
// made. A refreshable login failure refreshes once; usage_limit never refreshes. A later
// login failure pauses a Build 5 min at a time up to 24 h and that request ends. Shaping
// does not pause. The spec names
// continuation_failed and not its process exit; this model uses exit 1.
module stream {
  pure val PAUSE_MS = 300000
  pure val PAUSE_CAP_MS = 86400000
  pure val WAITS: Set[int] = Set(0, 300000, 86100000, 86400000)

  type OpenA = { role: str, model: str, fallbackOn: bool, refreshable: bool, bounded: bool, wall: int, mode: str }
  type ResultA = { kind: str, items: bool }
  type KindA = { kind: str }
  type WaitA = { ms: int }
  type State = {
    phase: str,
    mode: str,
    role: str,
    model: str,
    fallbackOn: bool,
    refreshable: bool,
    bounded: bool,
    wall: int,
    attempt: int,
    overloads: int,
    refreshed: bool,
    waited: int,
    decision: str,
    delay: int,
    reason: str,
    continued: bool,
    queued: bool,
    exit: int,
    checkpoint: str,
    continuations: int,
    last: str,
    failed: bool,
  }
  type Event =
    | Init
    | Open(OpenA)
    | Result(ResultA)
    | Checkpoint(KindA)
    | SetWaited(WaitA)
  type Obs = State

  pure val INITIAL: State = {
    phase: "idle", mode: "", role: "", model: "", fallbackOn: false, refreshable: true, bounded: false, wall: 0,
    attempt: 0, overloads: 0, refreshed: false, waited: 0, decision: "", delay: 0, reason: "",
    continued: false, queued: false, exit: 0, checkpoint: "", continuations: 0, last: "ok",
    failed: false,
  }

  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def knownRole(r: str): bool = r == "builder" or r == "planner"
  pure def knownModel(m: str): bool = m == "luna" or m == "sol" or m == "grok"
  pure def knownMode(m: str): bool = m == "build" or m == "shape"

  pure def ceiling(n: int): int =
    if (n <= 1) 2000
    else if (n == 2) 4000
    else if (n == 3) 8000
    else if (n == 4) 16000
    else if (n == 5) 32000
    else 60000

  pure def reasonOf(k: str): str =
    if (k == "timeout") "provider/timeout"
    else if (k == "stall") "provider/stall"
    else if (k == "transport") "provider/transport"
    else if (k == "overload") "provider/overload"
    else if (k == "malformed") "provider/malformed"
    else if (k == "usage_limit") "provider/usage_limit"
    else if (k == "login") "provider/login"
    else ""

  // first_byte and the 20 min total are timeouts. A cut after items is malformed.
  pure def klass(kind: str, items: bool): str =
    if (kind == "ok") "ok"
    else if (kind == "first_byte" or kind == "total") "timeout"
    else if (kind == "stall") "stall"
    else if (kind == "cut") if (items) "malformed" else "transport"
    else if (kind == "overload" or kind == "malformed" or kind == "transport" or kind == "timeout") kind
    else if (kind == "usage_limit" or kind == "login" or kind == "incomplete") kind
    else ""

  pure def continuable(k: str): bool =
    k == "timeout" or k == "stall" or k == "transport" or k == "malformed"

  pure def halt(s: State, reason: str, code: int): State = {
    ...s, phase: "stopped", decision: "stop", delay: 0, reason: reason, continued: false,
    exit: code, queued: true, last: "ok",
  }

  pure def open(s: State, a: OpenA): State =
    if (s.phase == "open") err(s, "bad_open")
    else if (not(knownRole(a.role)) or not(knownModel(a.model)) or not(knownMode(a.mode))) err(s, "bad_open")
    else {
      ...s, phase: "open", mode: a.mode, role: a.role, model: a.model,
      fallbackOn: a.fallbackOn and a.model != "grok", refreshable: a.refreshable,
      bounded: a.bounded, wall: a.wall, attempt: 1, overloads: 0, refreshed: false,
      decision: "", delay: 0, reason: "", continued: false, checkpoint: "", queued: true,
      exit: 0, last: "ok", failed: false,
    }

  pure def succeed(s: State): State = {
    ...s, phase: "idle", decision: "success", delay: 0, reason: "", continued: false, exit: 0, last: "ok",
  }

  pure def unfinished(s: State): State = {
    ...s, phase: "idle", decision: "incomplete", delay: 0, reason: "", continued: false, exit: 0, last: "ok",
  }

  // One forced refresh, then 5 min pauses. Exactly 24 h of pauses is still allowed.
  pure def credential(s: State, k: str): State =
    if (k == "login" and not(s.refreshable)) halt(s, reasonOf(k), 4)
    else if (k == "login" and not(s.refreshed)) {
      ...s, refreshed: true, decision: "refresh", delay: 0, reason: reasonOf(k), continued: false,
      phase: "open", exit: 0, last: "ok",
    } else if (s.mode == "shape" or s.waited + PAUSE_MS > PAUSE_CAP_MS) halt(s, reasonOf(k), 4)
    else {
      ...s, waited: s.waited + PAUSE_MS, decision: "pause", delay: PAUSE_MS, reason: reasonOf(k),
      continued: false, phase: "idle", exit: 0, last: "ok",
    }

  pure def retryOf(s: State, k: str, items: bool): State =
    val streak = if (k == "overload") s.overloads + 1 else 0
    val switching = (streak >= 2) and s.fallbackOn and (s.role == "builder") and (s.model != "sol")
    val budgetClass = (k == "timeout") or (k == "stall") or (k == "transport") or ((k == "overload") and not(s.fallbackOn))
    val left = (s.bounded and budgetClass) or (s.attempt < 4)
    val delay = if (switching) 0 else ceiling(s.attempt)
    val tooLong = s.bounded and (s.wall <= delay)
    val cont = items and continuable(k) and not(switching)
    if (not(left) or tooLong) halt(s, reasonOf(k), 4)
    else if (switching) {
      ...s, phase: "open", model: "sol", overloads: 0, attempt: s.attempt + 1, decision: "switch",
      delay: 0, reason: reasonOf(k), continued: false, exit: 0, last: "ok",
    } else {
      ...s, phase: "open", overloads: streak, attempt: s.attempt + 1, decision: "retry",
      delay: delay, reason: reasonOf(k), continued: cont, exit: 0, last: "ok",
    }

  pure def result(s: State, a: ResultA): State =
    if (s.phase != "open") err(s, "not_open")
    else
      val k = klass(a.kind, a.items)
      if (k == "") err(s, "bad_result")
      else if (k == "ok") succeed(s)
      else if (k == "incomplete") unfinished(s)
      else if (k == "usage_limit" or k == "login") credential(s, k)
      else retryOf(s, k, a.items)

  pure def check(s: State, a: KindA): State =
    if (s.phase != "open") err(s, "not_open")
    else if (a.kind == "valid") {
      ...s, phase: "idle", decision: "checkpoint", checkpoint: "accepted",
      continuations: s.continuations + 1, delay: 0, reason: "", continued: false, exit: 0, last: "ok",
    } else if (a.kind == "invalid" or a.kind == "oversized")
      { ...halt(s, "continuation_failed", 1), checkpoint: "failed" }
    else err(s, "bad_checkpoint")

  pure def waited(s: State, a: WaitA): State =
    if (not(WAITS.contains(a.ms))) err(s, "bad_wait")
    else { ...s, waited: a.ms, last: "ok" }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Open(a) => open(s, a)
    | Result(a) => result(s, a)
    | Checkpoint(a) => check(s, a)
    | SetWaited(a) => waited(s, a)
  }

  pure def observe(s: State): Obs = s

  pure def providerReason(r: str): bool =
    r == "provider/timeout" or r == "provider/stall" or r == "provider/transport" or r == "provider/overload"
    or r == "provider/malformed" or r == "provider/usage_limit" or r == "provider/login"

  // A provider stop leaves the Intent queued and does not fail it.
  pure def safe(s: State): bool = and {
    s.failed == false,
    s.phase == "idle" or s.phase == "open" or s.phase == "stopped",
    s.phase == "stopped" implies (s.queued and not(s.failed)),
    s.phase == "open" implies s.queued,
    s.exit == 4 implies (s.phase == "stopped" and s.queued and providerReason(s.reason)),
    s.exit == 1 implies (s.phase == "stopped" and s.reason == "continuation_failed" and s.checkpoint == "failed"),
    s.decision == "switch" implies (s.delay == 0 and s.model == "sol" and s.role == "builder" and s.overloads == 0),
    s.decision == "retry" implies s.delay > 0,
    s.continued implies (s.decision == "retry" and continuableReason(s.reason)),
    s.decision == "pause" implies (s.delay == PAUSE_MS and s.mode == "build" and s.phase == "idle" and s.waited <= PAUSE_CAP_MS),
    s.decision == "refresh" implies (s.delay == 0 and s.refreshed),
    s.waited >= 0 and s.waited <= PAUSE_CAP_MS,
    s.attempt >= 0 and s.overloads >= 0 and s.continuations >= 0,
    s.checkpoint == "accepted" implies s.continuations >= 1,
    not(s.queued) implies (s.phase == "idle" and s.exit == 0),
  }

  pure def continuableReason(r: str): bool =
    r == "provider/timeout" or r == "provider/stall" or r == "provider/transport" or r == "provider/malformed"

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure def opened(role: str, model: str, fallbackOn: bool, refreshable: bool, bounded: bool, wall: int, mode: str): Event =
    Open({ role: role, model: model, fallbackOn: fallbackOn, refreshable: refreshable, bounded: bounded, wall: wall, mode: mode })

  action step = any {
    all { st.phase != "open", fire(opened("builder", "luna", true, true, true, 100000, "build")) },
    all { st.phase != "open", fire(opened("builder", "luna", true, true, false, 0, "build")) },
    all { st.phase != "open", fire(opened("builder", "luna", false, true, true, 10000000, "build")) },
    all { st.phase != "open", fire(opened("planner", "luna", true, true, true, 100000, "build")) },
    all { st.phase != "open", fire(opened("builder", "sol", true, true, true, 100000, "build")) },
    all { st.phase != "open", fire(opened("builder", "grok", true, true, true, 100000, "build")) },
    all { st.phase != "open", fire(opened("builder", "luna", true, true, true, 1000, "build")) },
    all { st.phase != "open", fire(opened("builder", "luna", true, true, true, 3000, "shape")) },
    all { st.phase != "open", fire(opened("builder", "luna", true, true, true, 100000, "shape")) },
    all { st.phase == "open", fire(Result({ kind: "ok", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "overload", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "overload", items: false })) },
    all { st.phase == "open" and st.overloads >= 1, fire(Result({ kind: "overload", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "timeout", items: true })) },
    all { st.phase == "open" and st.bounded and st.attempt >= 4, fire(Result({ kind: "timeout", items: true })) },
    all { st.phase == "open", fire(Result({ kind: "stall", items: true })) },
    all { st.phase == "open", fire(Result({ kind: "cut", items: true })) },
    all { st.phase == "open", fire(Result({ kind: "cut", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "malformed", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "transport", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "usage_limit", items: false })) },
    all { st.phase == "open" and st.refreshed, fire(Result({ kind: "usage_limit", items: false })) },
    all { st.phase == "open" and st.refreshed and st.mode == "shape", fire(Result({ kind: "login", items: false })) },
    all { st.phase == "open", fire(Result({ kind: "incomplete", items: true })) },
    all { st.phase == "open", fire(Result({ kind: "first_byte", items: false })) },
    all { st.phase == "open", fire(Checkpoint({ kind: "valid" })) },
    all { st.phase == "open", fire(Checkpoint({ kind: "invalid" })) },
    all { st.phase == "open", fire(Checkpoint({ kind: "oversized" })) },
    all { st.phase == "open" and st.refreshed, fire(SetWaited({ ms: 86100000 })) },
    all { st.phase == "open" and st.refreshed, fire(SetWaited({ ms: 86400000 })) },
    fire(SetWaited({ ms: 0 })),
    fire(Result({ kind: "nope", items: false })),
    fire(Open({ role: "nope", model: "luna", fallbackOn: true, refreshable: true, bounded: true, wall: 1, mode: "build" })),
    fire(Init),
  }

  val invariant = safe(st)
}
