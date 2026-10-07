// Crash recovery. Sources: spec §2.5.3, §3.10, §2.11 (v1.3-draft).
// A dead owner is a running Build whose pid is gone, or whose pid is alive with a
// different start time. That second case is `alive: false` here. A candidate commit
// on the base becomes landed/reconciled. Otherwise the run fails as interrupted when
// its last event is interrupted, and crashed otherwise. The owned
// claim is released after the outcome is recorded; incoming cleanup waits for
// durable preservation. Failure retains the workspace. Crashed/interrupted Intents
// stay out of the queue until re-approved. A live owner is left alone.
module recovery {
  type Run = {
    status: str,
    alive: bool,
    onBase: bool,
    lastEvent: str,
    incoming: bool,
    queued: bool,
    reason: str,
    work: bool, preserved: bool, preserveOk: bool, cleanupPending: bool,
  }
  type State = {
    runs: str -> Run,
    priorRuns: str -> Run,
    claim: str,
    line: str,
    last: str,
  }
  type Fact = {
    id: str, status: str, alive: bool, onBase: bool, lastEvent: str,
    incoming: bool, queued: bool, claim: bool, reason: str,
    work: bool, preserved: bool, preserveOk: bool,
  }
  type Event =
    | Init
    | Put(Fact)
    | PreservationResult({ id: str, ok: bool })
    | Recover
    | Reapprove({ id: str })

  type Obs = { last: str, line: str, claim: str, runs: str -> Run }

  pure val IDS: List[str] = ["r1", "r2"]
  pure val INITIAL: State = { runs: Map(), priorRuns: Map(), claim: "", line: "", last: "ok" }

  pure def err(s: State, code: str): State = { ...s, last: code, line: code }
  pure def known(id: str): bool = id == "r1" or id == "r2"
  pure def knownStatus(status: str): bool =
    Set("running", "landed", "failed", "parked", "stopped", "approved").contains(status)

  pure def queuedOk(status: str, reason: str, queued: bool): bool =
    if (not(queued)) true
    else status == "approved" or status == "stopped"

  pure def store(s: State, a: Fact): State =
    if (not(known(a.id))) err(s, "unknown_run")
    else if (not(knownStatus(a.status))) err(s, "bad_status")
    else if (a.incoming and a.status != "running") err(s, "bad_run")
    else if (a.status == "landed" and not(a.onBase)) err(s, "bad_run")
    else if (a.claim and a.status != "running") err(s, "bad_run")
    else if (a.claim and s.claim != "" and s.claim != a.id) err(s, "claim_held")
    else if (not(queuedOk(a.status, a.reason, a.queued))) err(s, "bad_run")
    else if (a.queued and a.status == "failed" and (a.reason == "crashed" or a.reason == "interrupted"))
      err(s, "bad_run")
    else
      val row = {
        status: a.status, alive: a.alive, onBase: a.onBase, lastEvent: a.lastEvent,
        incoming: a.incoming, queued: a.queued, reason: a.reason,
        work: a.work, preserved: a.preserved, preserveOk: a.preserveOk, cleanupPending: false,
      }
      val held = if (a.claim) a.id else if (s.claim == a.id) "" else s.claim
      { ...s, runs: s.runs.put(a.id, row), claim: held, last: "ok", line: "stored" }

  pure def finish(s: State, id: str, status: str, reason: str): State =
    val r = s.runs.get(id)
    // Preservation success is an abstract durable publication result. Never
    // remove a workspace or incoming ref if it is the sole remaining copy.
    val preserved = r.preserved or (r.work and r.preserveOk)
    val pending = r.work and not(preserved)
    val row = { ...r, status: status, reason: reason, queued: false,
      preserved: preserved, work: pending, cleanupPending: pending,
      incoming: if (pending) r.incoming else false }
    { ...s, runs: s.runs.put(id, row), claim: if (s.claim == id) "" else s.claim, line: if (pending) "cleanup_failure" else reason, last: "ok" }

  pure def one(s: State, id: str): State =
    if (not(s.runs.keys().contains(id))) s
    else
      val r = s.runs.get(id)
      if (r.cleanupPending) finish(s, id, r.status, r.reason)
      else if (r.status != "running" or r.alive) s
      else if (r.onBase) finish(s, id, "landed", "reconciled")
      else if (r.lastEvent == "interrupted") finish(s, id, "failed", "interrupted")
      else finish(s, id, "failed", "crashed")

  pure def recover(s: State): State =
    val after = IDS.foldl(s, (acc, id) => one(acc, id))
    if (after.runs.keys().exists(id => after.runs.get(id).cleanupPending))
      { ...after, last: "ok", line: "cleanup_failure" }
    else if (after.runs == s.runs and after.claim == s.claim) { ...s, last: "ok", line: "unchanged" }
    else after

  pure def reapprove(s: State, id: str): State =
    if (not(known(id)) or not(s.runs.keys().contains(id))) err(s, "unknown_run")
    else
      val r = s.runs.get(id)
      if (r.cleanupPending) err(s, "cleanup_pending")
      else if (r.status == "landed") err(s, "already_landed")
      else if (r.status == "failed" and (r.reason == "crashed" or r.reason == "interrupted"))
        { ...s, runs: s.runs.put(id, { ...r, status: "approved", queued: true, reason: "" }),
          last: "ok", line: "reapproved" }
      else err(s, "not_recoverable")

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Put(a) => store(s, a)
    | PreservationResult(a) =>
      if (not(s.runs.keys().contains(a.id))) err(s, "unknown_run")
      else { ...s, runs: s.runs.put(a.id, { ...s.runs.get(a.id), preserveOk: a.ok }) }
    | Recover => recover(s)
    | Reapprove(a) => reapprove(s, a.id)
  }

  pure def observe(s: State): Obs = { last: s.last, line: s.line, claim: s.claim, runs: s.runs }

  pure def oneOk(s: State, id: str): bool =
    val r = s.runs.get(id)
    and {
      r.status == "landed" implies and { r.onBase, (not(r.incoming) or r.cleanupPending), not(r.queued) },
      (r.reason == "crashed" or r.reason == "interrupted") implies and { r.status == "failed", not(r.queued) },
      r.incoming implies (r.status == "running" or r.cleanupPending),
      r.cleanupPending implies and { r.work, not(r.preserved), not(r.queued) },
      (r.reason == "crashed" or r.reason == "interrupted" or r.reason == "reconciled")
        implies (r.cleanupPending or not(r.work)),
      r.queued implies (r.status == "approved" or r.status == "stopped"),
    }

  pure def safe(s: State): bool = and {
    s.runs.keys().forall(id => oneOk(s, id)),
    s.claim != "" implies and {
      s.runs.keys().contains(s.claim),
      s.runs.get(s.claim).status == "running",
    },
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = { ...n, priorRuns: st.runs }, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  action step = any {
    all {
      nondet id = Set("r1", "r2").oneOf()
      nondet preserveOk = Set(true, false).oneOf()
      nondet alive = Set(true, false).oneOf()
      nondet onBase = Set(true, false).oneOf()
      nondet lastEvent = Set("interrupted", "other").oneOf()
      fire(Put({
        id: id, status: "running", alive: alive, onBase: onBase, lastEvent: lastEvent,
        incoming: true, queued: false, claim: st.claim == "" or st.claim == id, reason: "",
        work: true, preserved: false, preserveOk: preserveOk,
      }))
    },
    all {
      st.claim == "",
      fire(Put({
        id: "r1", status: "running", alive: false, onBase: true, lastEvent: "other",
        incoming: true, queued: false, claim: true, reason: "", work: true, preserved: false, preserveOk: true,
      }))
    },
    all {
      nondet id = Set("r1", "r2").oneOf()
      fire(Reapprove({ id: id }))
    },
    all { nondet id = Set("r1", "r2").oneOf()
      nondet ok = Set(true, false).oneOf()
      fire(PreservationResult({ id: id, ok: ok })) },
    fire(Recover),
    fire(Recover),
    fire(Put({
      id: "r2", status: "running", alive: true, onBase: false, lastEvent: "other",
      incoming: false, queued: false, claim: false, reason: "", work: true, preserved: false, preserveOk: true,
    })),
  }

  run preserveBeforeCleanupTest = {
    val a = { id: "r1", status: "running", alive: false, onBase: false, lastEvent: "other",
      incoming: true, queued: false, claim: true, reason: "", work: true,
      preserved: false, preserveOk: false }
    val failed = recover(store(INITIAL, a))
    val r = failed.runs.get("r1")
    val retry = recover(apply(failed, PreservationResult({ id: "r1", ok: true })))
    val done = retry.runs.get("r1")
    init.expect(and { r.status == "failed", r.work, r.incoming, r.cleanupPending,
      not(r.preserved), failed.claim == "", recover(failed).line == "cleanup_failure", done.preserved, not(done.work),
      not(done.incoming), not(done.cleanupPending), done.reason == "crashed",
      recover(retry).runs == retry.runs })
  }

  run landedPreservationTest = {
    val a = { id: "r1", status: "running", alive: false, onBase: true, lastEvent: "other",
      incoming: true, queued: false, claim: true, reason: "", work: true,
      preserved: false, preserveOk: true }
    val done = recover(store(INITIAL, a)).runs.get("r1")
    init.expect(and { done.status == "landed", done.preserved, not(done.work),
      not(done.cleanupPending), done.reason == "reconciled" })
  }

  val invariant = safe(st) and match ev {
    | Recover => st.priorRuns.keys().forall(id =>
        st.priorRuns.get(id).work implies
          (st.runs.get(id).work or st.runs.get(id).preserved))
    | _ => true
  }
}
