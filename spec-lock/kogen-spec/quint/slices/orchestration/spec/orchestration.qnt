// Build orchestration B0–B10, the rung repair loop, and the ladder entry.
// Sources: spec §3.0, §3.1, §3.4, §3.5 (v1.2).
// Model output, the gate, and git arrive as event fields. A started Build reaches B10.
module orchestration {
  type State = {
    phase: str,
    status: str,
    reason: str,
    rung: int,
    maxR: int,
    entry: int,
    witness: bool,
    hard: bool,
    planned: bool,
    claim: bool,
    budget: bool,
    setupFails: int,
    repairs: int,
    granted: int,
    prev: int,
    bare: int,
    snapshots: int,
    landable: bool,
    parkedRef: bool,
    journal: List[str],
    last: str,
    exit: int,
  }
  type BeginA = { valid: bool, branchOk: bool, claimFree: bool, witness: bool, hard: bool, maxR: int }
  type Event =
    | Init
    | Begin(BeginA)
    | Probe({ confined: bool })
    | Witness({ green: bool })
    | Plan
    | Setup({ ok: bool })
    | BaseAccept({ runner: bool })
    | Verify({ red: bool, landable: bool, counted: bool, count: int })
    | Repair({ lower: bool })
    | Pair({ first: str, second: str })
    | Audit({ nowLandable: bool })
    | Budget
    | Land({ how: str })
    | Stop({ why: str })

  type Obs = {
    last: str, exit: int, phase: str, status: str, reason: str,
    rung: int, entry: int, claim: bool, planned: bool, landable: bool, parkedRef: bool,
    repairs: int, granted: int, snapshots: int, journal: List[str],
  }

  pure val INITIAL: State = {
    phase: "idle", status: "", reason: "", rung: 0, maxR: 3, entry: 1,
    witness: false, hard: false, planned: false, claim: false, budget: true,
    setupFails: 0, repairs: 0, granted: 0, prev: -1, bare: 0,
    snapshots: 0, landable: false, parkedRef: false,
    journal: [], last: "ok", exit: 0,
  }

  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def add(s: State, name: str): List[str] = s.journal.append(name)
  pure def count(j: List[str], name: str): int =
    j.foldl(0, (a, x) => if (x == name) a + 1 else a)

  pure def stopped(s: State, reason: str, exit: int): State =
    { ...s, phase: "done", status: "stopped", reason: reason, claim: false, landable: false,
      parkedRef: false, last: "ok", exit: exit, journal: s.journal.append("finished") }

  pure def chooseBest(s: State): State =
    { ...s, phase: "done", status: "failed", reason: "best_candidate", claim: false,
      parkedRef: s.snapshots > 0, landable: false, last: "ok", exit: 1,
      journal: s.journal.append("selection").append("finished") }

  pure def advance(s: State): State =
    val nxt = s.rung + 1
    if (s.budget and nxt <= s.maxR)
      { ...s, rung: nxt, phase: "setup", repairs: 6, granted: 6, setupFails: 0,
        prev: -1, bare: 0, landable: false, journal: s.journal.append("rung_started"), last: "ok" }
    else chooseBest(s)

  pure def finishRung(s: State, landable: bool, why: str): State =
    val s1 = { ...s, landable: landable, reason: why, snapshots: s.snapshots + 1,
               journal: s.journal.append("verification").append("rung_finished"), last: "ok" }
    if (landable) { ...s1, phase: "b9" } else { ...s1, phase: "b6" }

  pure def begin(s: State, a: BeginA): State =
    if (s.phase != "idle" and s.phase != "done") err(s, "busy")
    else if (a.maxR < 1 or a.maxR > 3) err(s, "bad_max_rungs")
    else if (not(a.valid))
      { ...INITIAL, phase: "done", status: "stopped", reason: "controller/approval_invalid", exit: 70 }
    else if (not(a.branchOk))
      { ...INITIAL, phase: "done", status: "skipped", reason: "environment/approval_branch_mismatch", exit: 0 }
    else if (not(a.claimFree))
      { ...INITIAL, phase: "done", status: "stopped", reason: "environment/build_already_claimed", exit: 3 }
    else
      { ...INITIAL, phase: "b1", status: "running", claim: true, budget: true,
        witness: a.witness, hard: a.hard, maxR: a.maxR, journal: ["started"] }

  pure def probe(s: State, confined: bool): State =
    if (s.phase != "b1") err(s, "not_b1")
    else
      { ...s, phase: "b2", last: "ok",
        journal: if (confined) s.journal else s.journal.append("sandbox_unavailable") }

  pure def witness(s: State, green: bool): State =
    if (s.phase != "b2" or not(s.witness)) err(s, "not_witness")
    else if (green)
      { ...s, phase: "b9", landable: true, reason: "witness", last: "ok",
        journal: s.journal.append("verification") }
    else
      { ...s, phase: "b4", last: "ok", journal: s.journal.append("verification") }

  pure def plan(s: State): State =
    if (s.planned) err(s, "already_planned")
    else if (s.phase != "b4" and not(s.phase == "b2" and not(s.witness))) err(s, "not_plan")
    else
      val parallel = s.hard and s.maxR >= 2
      { ...s, planned: true, entry: 1, rung: 1, repairs: 6, granted: 6, prev: -1, bare: 0,
        setupFails: 0, last: "ok",
        phase: if (parallel) "pair" else "setup",
        journal: s.journal.append("plan").append(if (parallel) "parallel_started" else "rung_started") }

  pure def setup(s: State, ok: bool): State =
    if (s.phase != "setup") err(s, "not_setup")
    else if (ok)
      { ...s, phase: if (s.rung == s.entry) "base" else "dev", setupFails: 0, last: "ok" }
    else
      val fails = s.setupFails + 1
      if (fails >= 2) stopped({ ...s, setupFails: fails }, "environment/setup_failed", 3)
      else { ...s, setupFails: fails, last: "ok" }

  pure def baseAccept(s: State, runner: bool): State =
    if (s.phase != "base") err(s, "not_base")
    else if (not(runner)) stopped(s, "environment/tool_missing", 3)
    else { ...s, phase: "dev", last: "ok", journal: s.journal.append("base_acceptance") }

  pure def verify(s: State, red: bool, landable: bool, counted: bool, count: int): State =
    if (s.phase != "dev") err(s, "not_dev")
    else if (count < 0) err(s, "bad_count")
    else if (not(red)) finishRung(s, landable, if (landable) "green" else "unverified")
    else if (not(counted) and s.bare >= 1) finishRung(s, false, "no_progress")
    else if (counted and s.prev >= 0 and count >= s.prev) finishRung(s, false, "no_progress")
    else if (s.repairs == 0) finishRung(s, false, "repair_cap")
    else
      { ...s, phase: "repair", last: "ok",
        prev: if (counted) count else s.prev,
        bare: if (counted) s.bare else s.bare + 1,
        journal: s.journal.append("verification") }

  pure def repair(s: State, lower: bool): State =
    if (s.phase != "repair") err(s, "not_repair")
    else
      { ...s, phase: "dev", repairs: s.repairs - if (lower) 1 else 1, last: "ok",
        journal: s.journal.append("repair") }

  pure def pair(s: State, first: str, second: str): State =
    if (s.phase != "pair") err(s, "not_pair")
    else if ((first != "green" and first != "red") or (second != "green" and second != "red")) err(s, "bad_pair")
    else if (first == "green" or second == "green")
      { ...s, rung: if (first == "green") 1 else 2, phase: "b9", landable: true, reason: "green",
        snapshots: s.snapshots + 2, last: "ok", journal: s.journal.append("rung_finished") }
    else
      val carried = { ...s, snapshots: s.snapshots + 2, repairs: 6, granted: 6, prev: -1, bare: 0,
                      setupFails: 0, landable: false, last: "ok" }
      if (s.budget and s.maxR >= 3)
        { ...carried, rung: 3, phase: "setup", journal: s.journal.append("rung_started") }
      else chooseBest(carried)

  pure def audit(s: State, nowLandable: bool): State =
    if (s.phase != "b6") err(s, "not_audit")
    else
      val s1 = { ...s, landable: nowLandable, last: "ok", journal: s.journal.append("audit") }
      if (nowLandable) { ...s1, phase: "b9" } else advance(s1)

  pure def budget(s: State): State =
    if (not(Set("setup", "base", "dev", "repair", "b6", "b4", "b2", "pair").contains(s.phase))) err(s, "not_budget")
    else advance({ ...s, budget: false })

  pure def land(s: State, how: str): State =
    if (s.phase != "b9") err(s, "not_landing")
    else if (how == "landed")
      { ...s, phase: "done", status: "landed", reason: "", claim: false, parkedRef: false,
        last: "ok", exit: 0,
        journal: s.journal.append("commit_result").append("landing_prepared").append("finished") }
    else if (how == "parked")
      { ...s, phase: "done", status: "parked", reason: "base_moved", claim: false, parkedRef: true,
        last: "ok", exit: 1,
        journal: s.journal.append("commit_result").append("landing_prepared").append("finished") }
    else if (how == "controller")
      stopped(s, "controller/not_fast_forward", 70)
    else err(s, "bad_land")

  pure def stop(s: State, why: str): State =
    if (s.phase == "idle" or s.phase == "done") err(s, "not_running")
    else if (why == "provider") stopped(s, "provider/overload", 4)
    else if (why == "environment") stopped(s, "environment/setup_failed", 3)
    else if (why == "controller") stopped(s, "controller/internal_error", 70)
    else err(s, "bad_stop")

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Begin(a) => begin(s, a)
    | Probe(a) => probe(s, a.confined)
    | Witness(a) => witness(s, a.green)
    | Plan => plan(s)
    | Setup(a) => setup(s, a.ok)
    | BaseAccept(a) => baseAccept(s, a.runner)
    | Verify(a) => verify(s, a.red, a.landable, a.counted, a.count)
    | Repair(a) => repair(s, a.lower)
    | Pair(a) => pair(s, a.first, a.second)
    | Audit(a) => audit(s, a.nowLandable)
    | Budget => budget(s)
    | Land(a) => land(s, a.how)
    | Stop(a) => stop(s, a.why)
  }

  pure def observe(s: State): Obs = {
    last: s.last, exit: s.exit, phase: s.phase, status: s.status, reason: s.reason,
    rung: s.rung, entry: s.entry, claim: s.claim, planned: s.planned,
    landable: s.landable, parkedRef: s.parkedRef, repairs: s.repairs, granted: s.granted,
    snapshots: s.snapshots, journal: s.journal,
  }

  pure def safe(s: State): bool = and {
    s.claim iff (s.status == "running"),
    s.parkedRef implies (s.status == "failed" or s.status == "parked"),
    s.status == "landed" implies and { not(s.parkedRef), not(s.claim), s.exit == 0 },
    s.status == "stopped" implies and { not(s.claim), s.exit == 3 or s.exit == 4 or s.exit == 70 },
    count(s.journal, "plan") <= 1,
    count(s.journal, "started") <= 1,
    s.rung >= 0 and s.rung <= s.maxR,
    s.repairs >= 0 and s.repairs <= 6,
    s.granted >= 0 and s.granted <= 6,
    s.prev >= -1,
    s.bare >= 0 and s.bare <= 2,
    s.planned implies count(s.journal, "plan") == 1,
    s.phase == "done" implies s.status != "running",
    // a provider stop does not fail the Intent
    s.reason == "provider/overload" implies s.status == "stopped",
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure val EASY: Event = Begin({ valid: true, branchOk: true, claimFree: true, witness: false, hard: false, maxR: 3 })
  action step = any {
    fire(EASY),
    all {
      nondet valid = Set(true, false).oneOf()
      nondet branchOk = Set(true, false).oneOf()
      nondet claimFree = Set(true, false).oneOf()
      nondet witness = Set(true, false).oneOf()
      nondet hard = Set(true, false).oneOf()
      nondet maxR = Set(1, 2, 3).oneOf()
      fire(Begin({ valid: valid, branchOk: branchOk, claimFree: claimFree, witness: witness, hard: hard, maxR: maxR }))
    },
    all { nondet confined = Set(true, false).oneOf()  fire(Probe({ confined: confined })) },
    all { nondet green = Set(true, false).oneOf()  fire(Witness({ green: green })) },
    fire(Plan),
    all { nondet ok = Set(true, false).oneOf()  fire(Setup({ ok: ok })) },
    all { nondet runner = Set(true, false).oneOf()  fire(BaseAccept({ runner: runner })) },
    all {
      nondet red = Set(true, false).oneOf()
      nondet landable = Set(true, false).oneOf()
      nondet counted = Set(true, false).oneOf()
      nondet count = Set(0, 1, 2, 3, 4, 5, 6).oneOf()
      fire(Verify({ red: red, landable: landable, counted: counted, count: count }))
    },
    all { nondet lower = Set(true, false).oneOf()  fire(Repair({ lower: lower })) },
    all {
      nondet first = Set("green", "red").oneOf()
      nondet second = Set("green", "red").oneOf()
      fire(Pair({ first: first, second: second }))
    },
    all { nondet nowLandable = Set(true, false).oneOf()  fire(Audit({ nowLandable: nowLandable })) },
    fire(Budget),
    all { nondet how = Set("landed", "parked", "controller").oneOf()  fire(Land({ how: how })) },
    all { nondet why = Set("provider", "environment", "controller").oneOf()  fire(Stop({ why: why })) },
    all { st.phase == "b1", fire(Probe({ confined: true })) },
    all { st.phase == "b2" and not(st.witness), fire(Plan) },
    all { st.phase == "setup", fire(Setup({ ok: true })) },
    all { st.phase == "base", fire(BaseAccept({ runner: true })) },
    all { st.phase == "dev", fire(Verify({ red: false, landable: true, counted: true, count: 0 })) },
    all { st.phase == "pair", fire(Pair({ first: "red", second: "red" })) },
    all { st.phase == "b9", fire(Land({ how: "landed" })) },
  }

  val invariant = safe(st)
}
