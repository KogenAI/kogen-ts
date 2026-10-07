// Landing CAS, rebase and re-gate. Sources: spec §2.8, §3.9 (v1.2, read 2026-10-06).
// The Landing record is written before the base can move. A lock or a lost CAS
// retries at 1s, 2s, 4s, then the Build rebases and re-gates. not_fast_forward
// and tree_mismatch stop as controller errors. Deleting the incoming ref may
// fail without failing the Build. A moved base parks only when the rebase is
// impossible or the landing allowance is spent.
module rebase {
  type State = {
    phase: str,       // idle | recorded | retrying | incoming | based | moved | repairing | landed | parked | stopped
    recorded: bool,
    headOk: bool,
    incoming: bool,
    onBase: bool,
    claim: bool,
    tries: int,       // transient failures already taken, 0..3
    repairs: int,
    delay: int,
    warning: bool,
    cleanup: bool,
    status: str,      // "" | running | landed | parked | stopped
    reason: str,
    line: str,
    exit: int,
    last: str,
  }
  type Event =
    | Init
    | Record
    | Lock
    | Head({ kind: str })          // ok | not_fast_forward | tree_mismatch
    | Push
    | Cas({ won: bool })
    | Worktree({ dirty: bool })
    | Drop({ ok: bool })
    | Again
    | Rebase({ kind: str })        // green | conflict | red | impossible
    | Repair({ kind: str })        // green | red | spent

  type Obs = {
    last: str, line: str, exit: int, phase: str, status: str, reason: str,
    recorded: bool, incoming: bool, onBase: bool, claim: bool, tries: int,
    repairs: int, delay: int, warning: bool, cleanup: bool,
  }

  pure val INITIAL: State = {
    phase: "idle", recorded: false, headOk: false, incoming: false, onBase: false,
    claim: false, tries: 0, repairs: 0, delay: 0, warning: false, cleanup: false,
    status: "", reason: "", line: "", exit: 0, last: "ok",
  }

  pure def err(s: State, code: str): State = { ...s, last: code, line: code }

  pure def delayOf(tries: int): int =
    if (tries <= 0) 1000 else if (tries == 1) 2000 else 4000

  // Three waits, then the moved-base path. The incoming ref is dropped so the
  // next push can recreate it.
  pure def transient(s: State): State =
    if (s.tries >= 3)
      { ...s, phase: "moved", incoming: false, headOk: false, onBase: false,
        delay: 0, last: "ok", line: "rebase_required" }
    else
      { ...s, phase: "retrying", incoming: false, headOk: false, tries: s.tries + 1,
        delay: delayOf(s.tries), last: "ok", line: "landing_retry" }

  pure def stopController(s: State, reason: str): State =
    { ...s, phase: "stopped", status: "stopped", reason: reason, claim: false,
      incoming: false, headOk: false, delay: 0, last: "ok", line: "stopped", exit: 70 }

  pure def park(s: State): State =
    { ...s, phase: "parked", status: "parked", reason: "not_landable", claim: false,
      incoming: false, onBase: false, headOk: false, delay: 0,
      last: "ok", line: "parked", exit: 1 }

  pure def open(s: State): bool = s.phase == "recorded" or s.phase == "incoming"

  pure def record(s: State): State =
    if (s.phase != "idle") err(s, "not_idle")
    else
      { ...INITIAL, phase: "recorded", recorded: true, claim: true, status: "running",
        last: "ok", line: "landing_prepared" }

  pure def lock(s: State): State =
    if (not(open(s))) err(s, "not_open") else transient(s)

  pure def checkHead(s: State, kind: str): State =
    if (s.phase != "recorded") err(s, "not_recorded")
    else if (kind == "ok") { ...s, headOk: true, last: "ok", line: "head_ok" }
    else if (kind == "not_fast_forward") stopController(s, "controller/not_fast_forward")
    else if (kind == "tree_mismatch") stopController(s, "controller/tree_mismatch")
    else err(s, "bad_head")

  pure def push(s: State): State =
    if (s.phase != "recorded" or not(s.headOk)) err(s, "not_ready")
    else { ...s, phase: "incoming", incoming: true, last: "ok", line: "pushed" }

  pure def cas(s: State, won: bool): State =
    if (s.phase != "incoming") err(s, "not_incoming")
    else if (won)
      { ...s, phase: "based", onBase: true, last: "ok", line: "cas" }
    else transient(s)

  pure def worktree(s: State, dirty: bool): State =
    if (s.phase != "based") err(s, "not_based")
    else if (dirty) { ...s, warning: true, last: "ok", line: "landing_warning" }
    else { ...s, last: "ok", line: "worktree_clean" }

  pure def drop(s: State, ok: bool): State =
    if (s.phase != "based") err(s, "not_based")
    else if (ok)
      { ...s, phase: "landed", status: "landed", reason: "", claim: false, incoming: false,
        delay: 0, last: "ok", line: "landed", exit: 0 }
    else
      // The Build has landed. A failed delete is a cleanup event, not a failure.
      { ...s, phase: "landed", status: "landed", reason: "", claim: false, incoming: true,
        cleanup: true, delay: 0, last: "ok", line: "cleanup_failure", exit: 0 }

  pure def again(s: State): State =
    if (s.phase != "retrying") err(s, "not_retrying")
    else { ...s, phase: "recorded", last: "ok", line: "retry" }

  pure def rebase(s: State, kind: str): State =
    if (s.phase != "moved") err(s, "not_moved")
    else if (kind == "green")
      { ...s, phase: "recorded", tries: 0, headOk: false, incoming: false, onBase: false,
        delay: 0, last: "ok", line: "rebase_green" }
    else if (kind == "impossible") park(s)
    else if (kind == "conflict" or kind == "red")
      { ...s, phase: "repairing", last: "ok", line: "repairing" }
    else err(s, "bad_rebase")

  pure def repair(s: State, kind: str): State =
    if (s.phase != "repairing") err(s, "not_repairing")
    else if (kind == "green")
      { ...s, phase: "recorded", tries: 0, headOk: false, repairs: s.repairs + 1,
        last: "ok", line: "repaired" }
    else if (kind == "red")
      { ...s, repairs: s.repairs + 1, last: "ok", line: "repairing" }
    else if (kind == "spent") park(s)
    else err(s, "bad_repair")

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Record => record(s)
    | Lock => lock(s)
    | Head(a) => checkHead(s, a.kind)
    | Push => push(s)
    | Cas(a) => cas(s, a.won)
    | Worktree(a) => worktree(s, a.dirty)
    | Drop(a) => drop(s, a.ok)
    | Again => again(s)
    | Rebase(a) => rebase(s, a.kind)
    | Repair(a) => repair(s, a.kind)
  }

  pure def observe(s: State): Obs = {
    last: s.last, line: s.line, exit: s.exit, phase: s.phase, status: s.status,
    reason: s.reason, recorded: s.recorded, incoming: s.incoming, onBase: s.onBase,
    claim: s.claim, tries: s.tries, repairs: s.repairs, delay: s.delay,
    warning: s.warning, cleanup: s.cleanup,
  }

  pure def safe(s: State): bool = and {
    s.onBase implies s.recorded,
    (s.phase == "based" or s.phase == "landed") implies (s.onBase and s.recorded),
    s.status == "landed" implies and { s.onBase, s.recorded, not(s.claim), s.exit == 0 },
    s.status == "running" iff s.claim,
    s.status == "parked" implies and { not(s.claim), not(s.onBase), not(s.incoming), s.exit == 1 },
    s.status == "stopped" implies and {
      not(s.claim), not(s.incoming), not(s.onBase), s.exit == 70, s.status != "failed",
    },
    s.phase == "incoming" implies s.incoming,
    s.cleanup implies and { s.status == "landed", s.incoming },
    s.incoming implies s.recorded,
    s.tries >= 0 and s.tries <= 3,
    s.repairs >= 0,
    // a landing CAS never precedes its Landing record
    s.onBase implies s.recorded,
    s.status != "failed",
    s.line == "landing_prepared" implies and { s.recorded, not(s.onBase), s.claim },
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  action step = any {
    all { st.phase == "idle", fire(Record) },
    all { st.phase == "recorded", fire(Head({ kind: "ok" })) },
    all { st.phase == "recorded" and st.headOk, fire(Push) },
    all { st.phase == "incoming", fire(Cas({ won: true })) },
    all { st.phase == "incoming", fire(Cas({ won: false })) },
    all { st.phase == "based", fire(Worktree({ dirty: false })) },
    all { st.phase == "based", fire(Worktree({ dirty: true })) },
    all { st.phase == "based", fire(Drop({ ok: true })) },
    all { st.phase == "based", fire(Drop({ ok: false })) },
    all { st.phase == "retrying", fire(Again) },
    all { open(st), fire(Lock) },
    all { open(st), fire(Lock) },
    all { st.phase == "moved", fire(Rebase({ kind: "green" })) },
    all { st.phase == "moved", fire(Rebase({ kind: "impossible" })) },
    all { st.phase == "moved", fire(Rebase({ kind: "conflict" })) },
    all { st.phase == "repairing", fire(Repair({ kind: "green" })) },
    all { st.phase == "repairing", fire(Repair({ kind: "red" })) },
    all { st.phase == "repairing", fire(Repair({ kind: "spent" })) },
    all { st.phase == "recorded", fire(Head({ kind: "not_fast_forward" })) },
    all { st.phase == "recorded", fire(Head({ kind: "tree_mismatch" })) },
    fire(Record),
    fire(Lock),
    fire(Push),
    fire(Again),
    fire(Cas({ won: false })),
    fire(Rebase({ kind: "green" })),
    fire(Repair({ kind: "spent" })),
  }

  val invariant = safe(st)
}
