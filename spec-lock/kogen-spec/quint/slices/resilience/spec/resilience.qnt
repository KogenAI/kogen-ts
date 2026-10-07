// Kogen provider slice: resilience policy for model requests within one stage.
// Sources: PROSE.md (core spec 4.4 error classes, 4.5 deadlines, retries, waits, fallback).
// Pure apply(State, Event) -> State and observe(State) -> Obs. Time and the network are
// events: each attempt arrives as an Attempt with its classified result and measured
// timings; delays are *decisions* the caller sleeps for, not time the core measures.
// Many rules are guesses where the prose is silent; see AMBIGUITIES.md.
module resilience {
  // ---------- constants (provider group of data/constants.json, unscaled) ----------
  pure val FIRST_BYTE_MS = 120000
  pure val IDLE_GAP_MS = 120000
  pure val REQUEST_TOTAL_MS = 600000
  pure val BACKOFF_MS: List[int] = [2000, 4000, 8000, 16000, 32000, 60000]
  pure val SWITCH_AFTER = 3
  pure val OUTAGE_WINDOW_MS = 1800000
  pure val USAGE_MAX_WAIT_MS = 21600000
  pure val USAGE_DEFAULT_WAIT_MS = 900000
  pure val SHAPING_ATTEMPTS = 8
  pure val CLASSES: Set[str] = Set("ok", "login", "usage_limit", "overload", "timeout", "malformed", "transport")

  // ---------- types ----------
  type Dec = { kind: str, delay_ms: int, model: str, reason: str }  // kind: "" | success | retry | switch | wait | refresh | stop
  type J = { event: str, stage: str, rung: int, reason: str, ms: int, from_model: str, to_model: str }
  type Att = { result: str, retry_after_ms: int, elapsed_ms: int, first_byte_ms: int, max_gap_ms: int }
  type State = {
    phase: str,      // no_stage | idle | sending | refreshing | stopped
    mode: str,       // build | shaping
    stage: str, owned: bool, model: str, fallback: str, switched: bool,
    attempts: int, retries: int, consec: int, refreshed: bool,
    budget_ms: int, outage_ms: int, usage_ms: int, exit: int,
    dec: Dec, journal: List[J], last: str,
  }
  type Event =
    | Init
    | Stage({ name: str, mode: str, model: str, fallback: str, owned: bool })  // start a stage (resets everything)
    | Request                // begin one model request in the stage
    | Attempt(Att)           // outcome of one send; retry_after_ms < 0 = absent
    | Refresh(bool)          // outcome of the forced token refresh

  type Obs = {
    last: str, phase: str, mode: str, stage: str, model: str, switched: bool,
    attempts: int, retries: int, consec: int, budget_ms: int, outage_ms: int, usage_ms: int,
    exit: int, decision: Dec, journal: List[J],
  }

  // ---------- helpers ----------
  pure val NO_DEC: Dec = { kind: "", delay_ms: 0, model: "", reason: "" }
  pure val INITIAL: State = {
    phase: "no_stage", mode: "build", stage: "", owned: true, model: "", fallback: "", switched: false,
    attempts: 0, retries: 0, consec: 0, refreshed: false,
    budget_ms: 0, outage_ms: 0, usage_ms: 0, exit: 0, dec: NO_DEC, journal: [], last: "ok",
  }
  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def backoff(n: int): int = BACKOFF_MS[if (n > 5) 5 else n]
  pure def jent(event: str, stage: str, rung: int, reason: str, ms: int, f: str, t: str): J =
    { event: event, stage: stage, rung: rung, reason: reason, ms: ms, from_model: f, to_model: t }
  pure def stopReason(res: str): str =
    if (res == "login") "provider/login"
    else if (res == "usage_limit") "provider/usage_limit"
    else if (res == "overload") "provider/overload"
    else if (res == "timeout") "provider/timeout"
    else if (res == "malformed") "provider/malformed"
    else "provider/transport"

  // The Build (or the drain, for shaping) ends; the caller exits 4.
  pure def stop(s: State, res: str): State =
    { ...s, phase: "stopped", exit: 4, dec: { kind: "stop", delay_ms: 0, model: s.model, reason: stopReason(res) } }

  // ---------- policy ----------
  pure def transient(s: State, res: str): State =
    if (s.mode == "build" and s.outage_ms > OUTAGE_WINDOW_MS) stop(s, res)
    else
      val counted = (res == "overload" or res == "timeout") and not(s.switched)
      val cnt = if (counted) s.consec + 1 else 0
      val sw = counted and cnt >= SWITCH_AFTER
      val delay = backoff(s.retries)
      val m2 = if (sw) s.fallback else s.model
      val j1 = s.journal.append(jent("provider_retry", s.stage, s.retries + 1, res, delay, "", ""))
      val j2 = if (sw) j1.append(jent("provider_switch", s.stage, 0, "", 0, s.model, s.fallback)) else j1
      val j3 = if (s.mode == "build") j2.append(jent("provider_wait", "", 0, res, delay, "", "")) else j2
      { ...s, phase: "sending", retries: s.retries + 1, consec: if (sw) 0 else cnt,
        model: m2, switched: s.switched or sw, outage_ms: s.outage_ms + delay, journal: j3,
        dec: { kind: if (sw) "switch" else "retry", delay_ms: delay, model: m2, reason: res } }

  pure def usageLimit(s: State, retryAfter: int): State =
    if (s.usage_ms >= USAGE_MAX_WAIT_MS) stop(s, "usage_limit")
    else
      val w = if (retryAfter < 0) USAGE_DEFAULT_WAIT_MS else retryAfter
      val j = if (s.mode == "build") s.journal.append(jent("provider_wait", "", 0, "usage_limit", w, "", "")) else s.journal
      { ...s, phase: "sending", consec: 0, usage_ms: s.usage_ms + w, journal: j,
        dec: { kind: "wait", delay_ms: w, model: s.model, reason: "usage_limit" } }

  pure def login(s: State): State =
    if (not(s.owned) or s.refreshed) stop(s, "login")
    else { ...s, phase: "refreshing", refreshed: true,
           dec: { kind: "refresh", delay_ms: 0, model: s.model, reason: "login" } }

  pure def attempt(s: State, a: Att): State =
    if (s.phase != "sending") err(s, "not_sending")
    else if (not(CLASSES.contains(a.result))) err(s, "unknown_class")
    else
      val missed = a.first_byte_ms > FIRST_BYTE_MS or a.max_gap_ms > IDLE_GAP_MS or a.elapsed_ms > REQUEST_TOTAL_MS
      val res = if (missed) "timeout" else a.result
      val n = { ...s, attempts: s.attempts + 1, last: "ok",
                budget_ms: if (s.mode == "build") s.budget_ms + a.elapsed_ms else s.budget_ms,
                outage_ms: s.outage_ms + a.elapsed_ms }
      if (res == "ok")
        { ...n, phase: "idle", outage_ms: 0, usage_ms: 0,
          dec: { kind: "success", delay_ms: 0, model: n.model, reason: "" } }
      else if (n.mode == "shaping" and n.attempts >= SHAPING_ATTEMPTS) stop(n, res)
      else if (res == "login") login(n)
      else if (res == "usage_limit") usageLimit(n, a.retry_after_ms)
      else transient(n, res)

  pure def refresh(s: State, ok: bool): State =
    if (s.phase != "refreshing") err(s, "not_refreshing")
    else if (ok) { ...s, phase: "sending", last: "ok", dec: { kind: "retry", delay_ms: 0, model: s.model, reason: "login" } }
    else stop({ ...s, last: "ok" }, "login")

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Stage(g) =>
        if (s.phase == "sending" or s.phase == "refreshing") err(s, "request_in_flight")
        else { ...INITIAL, phase: "idle", mode: g.mode, stage: g.name, owned: g.owned, model: g.model, fallback: g.fallback }
    | Request =>
        if (s.phase == "no_stage") err(s, "no_stage")
        else if (s.phase == "stopped") err(s, "stopped")
        else if (s.phase != "idle") err(s, "request_in_flight")
        else { ...s, phase: "sending", attempts: 0, retries: 0, consec: 0, refreshed: false,
               outage_ms: 0, usage_ms: 0, dec: NO_DEC, last: "ok" }
    | Attempt(a) => attempt(s, a)
    | Refresh(ok) => refresh(s, ok)
  }

  pure def observe(s: State): Obs = {
    last: s.last, phase: s.phase, mode: s.mode, stage: s.stage, model: s.model, switched: s.switched,
    attempts: s.attempts, retries: s.retries, consec: s.consec, budget_ms: s.budget_ms,
    outage_ms: s.outage_ms, usage_ms: s.usage_ms, exit: s.exit, decision: s.dec, journal: s.journal,
  }

  // ---------- safety properties ----------
  pure def count(s: State, ev: str): int = s.journal.foldl(0, (a, j) => if (j.event == ev) a + 1 else a)
  pure def safe(s: State): bool = and {
    s.phase == "stopped" iff (s.exit == 4),
    s.phase == "stopped" implies (s.dec.kind == "stop" and s.dec.reason.in(Set("provider/login", "provider/usage_limit", "provider/overload", "provider/timeout", "provider/malformed", "provider/transport"))),
    s.consec <= SWITCH_AFTER - 1,
    count(s, "provider_switch") <= 1,
    s.switched iff (count(s, "provider_switch") == 1),
    s.switched implies s.model == s.fallback,
    s.mode == "shaping" implies (s.budget_ms == 0 and s.attempts <= SHAPING_ATTEMPTS and count(s, "provider_wait") == 0),
    s.dec.kind == "retry" implies (s.dec.delay_ms == 0 or BACKOFF_MS.indices().exists(i => BACKOFF_MS[i] == s.dec.delay_ms)),
    s.usage_ms >= 0 and s.budget_ms >= 0,
    count(s, "provider_retry") >= s.retries,
  }

  // ---------- state machine for simulation ----------
  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure def att(r: str, ra: int, el: int, fb: int, gap: int): Att =
    { result: r, retry_after_ms: ra, elapsed_ms: el, first_byte_ms: fb, max_gap_ms: gap }
  pure val ATTEMPTS: Set[Event] =
    tuples(CLASSES, Set(-1, 5000, 21600000), Set(att("", 0, 1000, 500, 0), att("", 0, 500000, 500, 0), att("", 0, 130000, 120001, 0), att("", 0, 700000, 500, 130000)))
      .map(((r, ra, t)) => Attempt({ ...t, result: r, retry_after_ms: ra }))
  pure val STAGES: Set[Event] =
    tuples(Set("build", "shaping"), Set(true, false), Set(("luna", "sol"), ("sol", "luna")))
      .map(((m, o, p)) => Stage({ name: "build", mode: m, model: p._1, fallback: p._2, owned: o }))
  pure val OTHERS: Set[Event] = Set(Request, Refresh(true), Refresh(false))
  action step = any {
    nondet e = ATTEMPTS.union(STAGES).union(OTHERS).oneOf()  fire(e),
    all { st.phase == "sending", nondet e = ATTEMPTS.oneOf()  fire(e) },
    all { st.phase == "idle", fire(Request) },
    all { st.phase == "refreshing", nondet e = Set(Refresh(true), Refresh(false)).oneOf()  fire(e) },
    all { st.phase == "stopped" or st.phase == "no_stage", nondet e = STAGES.oneOf()  fire(e) },
  }

  val invariant = safe(st)
}
