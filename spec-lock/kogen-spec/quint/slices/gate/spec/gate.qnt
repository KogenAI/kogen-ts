// Gate: base-relative excuses, the acceptance ledger, verdicts, and the selector.
// Sources: spec §2.4.1, §3.7, §3.8 (v1.3-draft).
module gate {
  type Item = { kind: str, passed: bool, demoted: bool }
  type Cand = { passed: int, blocking: int, diff: int }
  type Snap = { status: str, hasIds: bool, subset: bool, sameExit: bool }
  type State = {
    base: str -> str,
    excused: str -> bool,
    nowStatus: str -> str,
    nowSnap: str -> Snap,
    items: str -> Item,
    offers: str -> Cand,
    ledger: str,
    verdict: str,
    landable: bool,
    winner: str,
    policy: str,
    last: str,
  }
  type Event =
    | Init
    | Baseline({ name: str, status: str })
    | Now({ name: str, status: str, hasIds: bool, subset: bool, sameExit: bool })
    | Rows({ id: str, kind: str, report: str, runnerDown: bool, exit0: bool, mutated: bool, failed: int, rows: int })
    | Demote({ id: str, verdict: str })
    | Score({ policy: str })
    | Offer({ rung: str, passed: int, blocking: int, diff: int })
    | Pick

  type Obs = {
    last: str, ledger: str, verdict: str, landable: bool, winner: str, policy: str,
    excused: str -> bool, items: str -> Item,
  }

  pure val INITIAL: State = {
    base: Map(), excused: Map(), nowStatus: Map(), nowSnap: Map(), items: Map(), offers: Map(),
    ledger: "", verdict: "", landable: false, winner: "", policy: "green", last: "ok",
  }

  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def knownCheck(name: str): bool = name == "c1" or name == "c2"
  pure def knownItem(id: str): bool = id == "A1" or id == "A2"
  pure def knownRung(rung: str): bool = rung == "1" or rung == "2" or rung == "3"

  pure def excuse(s: State, name: str, status: str, hasIds: bool, subset: bool, sameExit: bool): bool =
    if (not(s.base.keys().contains(name))) false
    else
      val b = s.base.get(name)
      b != "green" and b == status and ((hasIds and subset) or (not(hasIds) and sameExit))

  pure def invalidate(s: State): State = { ...s, verdict: "", landable: false }

  pure def remember(s: State, name: str): State =
    if (not(s.nowSnap.keys().contains(name))) s
    else
      val n = s.nowSnap.get(name)
      { ...s, excused: s.excused.put(name, excuse(s, name, n.status, n.hasIds, n.subset, n.sameExit)) }

  pure def baseline(s: State, name: str, status: str): State =
    if (not(knownCheck(name))) err(s, "unknown_check")
    else if (not(Set("green", "red", "unavailable", "timeout", "mutating").contains(status))) err(s, "bad_status")
    else remember(invalidate({ ...s, base: s.base.put(name, status), last: "ok" }), name)

  pure def now(s: State, name: str, status: str, hasIds: bool, subset: bool, sameExit: bool): State =
    if (not(knownCheck(name))) err(s, "unknown_check")
    else if (not(Set("green", "red", "unavailable", "timeout", "mutating").contains(status))) err(s, "bad_status")
    else
      val snap = { status: status, hasIds: hasIds, subset: subset, sameExit: sameExit }
      val updated = invalidate({ ...s, nowStatus: s.nowStatus.put(name, status),
        nowSnap: s.nowSnap.put(name, snap), last: "ok" })
      { ...updated, excused: updated.excused.put(name, excuse(updated, name, status, hasIds, subset, sameExit)) }

  pure def rows(s: State, a: { id: str, kind: str, report: str, runnerDown: bool, exit0: bool, mutated: bool, failed: int, rows: int }): State =
    val s0 = invalidate(s)
    if (not(knownItem(a.id)) or (a.kind != "change" and a.kind != "keep")) err(s, "bad_item")
    else if (a.mutated)
      { ...s0, ledger: "tree_mutated", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: false, demoted: false }) }
    else if (a.report == "missing" and a.runnerDown)
      { ...s0, ledger: "tool_missing", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: false, demoted: false }) }
    else if (a.report == "empty" and not(a.exit0))
      { ...s0, ledger: "acceptance_compile_failed", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: false, demoted: false }) }
    else if (a.report == "empty")
      { ...s0, ledger: "no_tagged_tests", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: false, demoted: false }) }
    else if (a.report == "malformed")
      { ...s0, ledger: "ledger_invalid", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: false, demoted: false }) }
    else if (a.report != "ok") err(s, "bad_report")
    else
      val pass = a.rows >= 1 and a.failed == 0
      { ...s0, ledger: if (pass) "pass" else "fail", last: "ok",
        items: s0.items.put(a.id, { kind: a.kind, passed: pass, demoted: false }) }

  pure def demote(s: State, id: str, verdict: str): State =
    if (not(s.items.keys().contains(id))) err(s, "unknown_item")
    else if (verdict != "valid" and verdict != "over_strict" and verdict != "contradicts" and verdict != "garbled")
      err(s, "bad_verdict")
    // Current profile is observational: even an over_strict reply preserves
    // verification, items, offers and winner. No calibration is admitted.
    else { ...s, last: "ok" }


  pure def checksGreen(s: State): bool =
    s.nowStatus.keys().forall(k => s.nowStatus.get(k) == "green" or (s.excused.keys().contains(k) and s.excused.get(k)))

  pure def undemotedPass(s: State): bool =
    s.items.keys().forall(k => s.items.get(k).demoted or s.items.get(k).passed)

  pure def demotedFail(s: State): bool =
    s.items.keys().exists(k => s.items.get(k).demoted and not(s.items.get(k).passed))

  pure def changePass(s: State): bool =
    s.items.keys().exists(k =>
      s.items.get(k).kind == "change" and not(s.items.get(k).demoted) and s.items.get(k).passed)

  pure def score(s: State, policy: str): State =
    if (policy != "green" and policy != "green-or-advisory") err(s, "bad_policy")
    else
      val empty = s.nowStatus.keys().size() == 0 and s.items.keys().size() == 0
      val verdict =
        if (empty) "none"
        else if (checksGreen(s) and undemotedPass(s) and s.items.keys().size() > 0)
          if (demotedFail(s)) "green-with-advisory-tests" else "green"
        else "unverified"
      val allowed = verdict == "green" or (verdict == "green-with-advisory-tests" and policy == "green-or-advisory")
      { ...s, policy: policy, verdict: verdict, landable: allowed and changePass(s), last: "ok" }

  pure def offer(s: State, rung: str, passed: int, blocking: int, diff: int): State =
    if (not(knownRung(rung)) or passed < 0 or blocking < 0 or diff < 0) err(s, "bad_offer")
    else { ...s, offers: s.offers.put(rung, { passed: passed, blocking: blocking, diff: diff }), last: "ok" }

  pure def better(s: State, a: str, b: str): bool =
    val oa = s.offers.get(a)
    val ob = s.offers.get(b)
    val ra = if (a == "1") 1 else if (a == "2") 2 else 3
    val rb = if (b == "1") 1 else if (b == "2") 2 else 3
    oa.passed > ob.passed
      or (oa.passed == ob.passed and oa.blocking < ob.blocking)
      or (oa.passed == ob.passed and oa.blocking == ob.blocking and oa.diff < ob.diff)
      or (oa.passed == ob.passed and oa.blocking == ob.blocking and oa.diff == ob.diff and ra < rb)

  pure def pick(s: State): State =
    if (s.offers.keys().size() == 0) err(s, "no_candidate")
    else
      val winner = s.offers.keys().fold("", (m, k) => if (m == "" or better(s, k, m)) k else m)
      { ...s, winner: winner, last: "ok" }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Baseline(a) => baseline(s, a.name, a.status)
    | Now(a) => now(s, a.name, a.status, a.hasIds, a.subset, a.sameExit)
    | Rows(a) => rows(s, a)
    | Demote(a) => demote(s, a.id, a.verdict)
    | Score(a) => score(s, a.policy)
    | Offer(a) => offer(s, a.rung, a.passed, a.blocking, a.diff)
    | Pick => pick(s)
  }

  pure def observe(s: State): Obs = {
    last: s.last, ledger: s.ledger, verdict: s.verdict, landable: s.landable,
    winner: s.winner, policy: s.policy, excused: s.excused, items: s.items,
  }

  pure def safe(s: State): bool = and {
    s.items.keys().forall(k => not(s.items.get(k).demoted)),
    s.excused.keys().forall(k =>
      s.excused.get(k) implies and {
        s.base.keys().contains(k),
        s.base.get(k) != "green",
        s.nowStatus.keys().contains(k),
        s.base.get(k) == s.nowStatus.get(k),
      }),
    s.verdict == "green" or s.verdict == "green-with-advisory-tests" implies checksGreen(s),
    s.landable implies (s.verdict == "green" or s.verdict == "green-with-advisory-tests"),
    s.landable implies changePass(s),
    s.policy == "green" implies not(s.landable and s.verdict == "green-with-advisory-tests"),
    s.winner != "" implies s.offers.keys().contains(s.winner),
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
    all {
      nondet name = Set("c1", "c2").oneOf()
      nondet status = Set("green", "red", "unavailable").oneOf()
      fire(Baseline({ name: name, status: status }))
    },
    all {
      nondet name = Set("c1", "c2").oneOf()
      nondet status = Set("green", "red", "unavailable").oneOf()
      nondet subset = Set(true, false).oneOf()
      fire(Now({ name: name, status: status, hasIds: true, subset: subset, sameExit: true }))
    },
    all {
      nondet id = Set("A1", "A2").oneOf()
      nondet kind = Set("change", "keep").oneOf()
      nondet report = Set("ok", "empty", "malformed", "missing").oneOf()
      fire(Rows({ id: id, kind: kind, report: report, runnerDown: false, exit0: true, mutated: false, failed: 0, rows: 1 }))
    },
    all {
      nondet id = Set("A1", "A2").oneOf()
      nondet verdict = Set("valid", "over_strict", "contradicts", "garbled").oneOf()
      fire(Demote({ id: id, verdict: verdict }))
    },
    all { nondet policy = Set("green", "green-or-advisory").oneOf()  fire(Score({ policy: policy })) },
    all {
      nondet rung = Set("1", "2", "3").oneOf()
      nondet passed = Set(0, 1, 2).oneOf()
      fire(Offer({ rung: rung, passed: passed, blocking: 0, diff: passed }))
    },
    fire(Pick),
  }

  run observationalTest = {
    val s1 = rows(INITIAL, { id: "A1", kind: "change", report: "ok", runnerDown: false,
      exit0: true, mutated: false, failed: 0, rows: 1 })
    val s2 = rows(s1, { id: "A2", kind: "change", report: "ok", runnerDown: false,
      exit0: true, mutated: false, failed: 1, rows: 1 })
    val before = pick(offer(score(s2, "green-or-advisory"), "1", 1, 1, 3))
    val after = demote(before, "A2", "over_strict")
    init.expect(and { not(after.landable), after.items == before.items,
      after.verdict == before.verdict, after.offers == before.offers,
      after.winner == before.winner, score(after, "green-or-advisory").landable == false })
  }

  val invariant = safe(st)
}
