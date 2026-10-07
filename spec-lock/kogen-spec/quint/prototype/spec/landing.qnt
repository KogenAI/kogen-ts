// Kogen core slice: project claim, landing CAS and crash recovery.
// Executable neutral spec. Sources: kogen-core-spec §2.5.4 (refs), §2.8.2 (rn.json
// Landing recorded before the base moves), §2.11 (status derivation, queue order).
// §3.12/§3.13 (recovery, drain) are not written yet; their behaviour here is a proposal.
//
// Shape: a pure transition function apply(State, Event) -> State and a pure
// observation observe(State) -> Obs. Implementations in any language implement the
// same two functions behind an adapter (see ../PROTOCOL.md). Every source of
// nondeterminism (run ids, commit times, gate verdicts, crash points, interleaving
// with other pushers) is an explicit Event, so a scenario fully determines a run.
//
// Quint has no string ordering, so slugs come from a fixed universe listed in
// lexicographic order; rank in SLUG_ORDER stands in for string comparison.
module landing {
  // ---------- universe (only these strings appear in scenarios) ----------
  pure val SLUG_ORDER: List[str] = ["alpha", "bravo", "charlie"]
  pure val RUN_IDS: Set[str] = Set("r1", "r2", "r3", "r4", "r5", "r6")
  pure val EXTERNAL_IDS: Set[str] = Set("x1", "x2", "r1")  // r1 overlaps RUN_IDS on purpose: id collisions
  pure val TIMES: Set[int] = Set(1, 2, 3)

  // ---------- types ----------
  type Commit = { id: str, slug: str }               // slug "" = not a Kogen commit
  type Approval = { time: int, id: int }             // id = identity of the approval commit
  type Run = {
    slug: str, approval: int, started: int,
    status: str,       // running | landed | failed | parked
    reason: str,       // "" | gate_red | base_moved | interrupted | reconciled
    parent: str,       // expected parent: base tip when the Build started
    landing: bool,     // rn.json Landing recorded (must precede the base CAS)
    alive: bool,       // owner process alive
    interrupted: bool, // got SIGTERM (event `interrupted` appended)
  }
  // The Build in flight. phase "" = no Build. Each phase boundary is a crash point.
  type Proc = { rid: str, phase: str } // building | built | recorded | pushed | based | cleaned

  type State = {
    base: List[Commit],
    approvals: str -> Approval,
    nextApproval: int,
    nextStart: int,
    claim: str,                // refs/kogen/claim ("" = absent)
    incoming: Set[str],        // refs/kogen/incoming/<run>
    parked: Set[str],          // refs/kogen/parked/<run>
    runs: str -> Run,
    proc: Proc,
    last: str,                 // outcome of the last event: ok | <error code>
  }

  type Event =
    | Init
    | Approve({ slug: str, time: int })  // kogen intent approve
    | Start(str)                          // queue start: recovery, then claim + start next Build with this run id
    | Gate(bool)                          // the Build's gate verdict (stands in for model + checks)
    | Step                                // advance landing by one atomic step
    | Crash                               // SIGKILL of the owner between two atomic steps
    | Interrupt                           // SIGTERM: like Crash, but the run records `interrupted`
    | PushExternal(str)                   // someone else fast-forwards the base
    | Recover                             // crash recovery (status / queue start run it)

  type RunView = { slug: str, status: str, reason: str }
  type Obs = {
    last: str,
    status: str -> str,      // derived status per approved slug (§2.11)
    queue: List[str],
    base: List[str],         // commit ids, oldest first
    claim: str,
    incoming: Set[str],
    parked: Set[str],
    runs: str -> RunView,
    proc: Proc,
  }

  // ---------- helpers ----------
  pure val NO_PROC: Proc = { rid: "", phase: "" }
  pure val INITIAL: State = {
    base: [{ id: "root", slug: "" }], approvals: Map(), nextApproval: 1, nextStart: 1,
    claim: "", incoming: Set(), parked: Set(), runs: Map(), proc: NO_PROC, last: "ok",
  }

  pure def tip(s: State): str = s.base[s.base.length() - 1].id
  pure def onBase(s: State, id: str): bool = s.base.indices().exists(i => s.base[i].id == id)
  pure def slugLanded(s: State, slug: str): bool = s.base.indices().exists(i => s.base[i].slug == slug)
  pure def rank(slug: str): int = SLUG_ORDER.indices().fold(-1, (acc, i) => if (SLUG_ORDER[i] == slug) i else acc)
  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def setRun(s: State, id: str, r: Run): State = { ...s, runs: s.runs.put(id, r) }

  // latest run of a slug = greatest start sequence; "" if none
  pure def latestRun(s: State, slug: str): str =
    s.runs.keys().fold("", (best, r) =>
      if (s.runs.get(r).slug == slug and (best == "" or s.runs.get(r).started > s.runs.get(best).started)) r
      else best)

  // §2.11, first match wins, then the `interrupted` post-pass
  pure def derive(s: State, slug: str): str =
    val latest = latestRun(s, slug)
    val current = latest != "" and s.runs.get(latest).approval == s.approvals.get(slug).id
    val base =
      if (slugLanded(s, slug)) "landed"
      else if (s.claim != "" and s.claim == latest) "building"
      else if (current and s.runs.get(latest).status == "parked") "parked"
      else if (current and s.runs.get(latest).status == "failed") "failed"
      else "approved"
    val r = s.runs.get(latest)
    val isInterrupted = current and (
      (r.status == "running" and r.interrupted and not(r.alive)) or
      (r.status == "failed" and r.reason == "interrupted"))
    if (Set("approved", "building", "failed").contains(base) and isInterrupted) "interrupted" else base

  // queue = approved slugs by (approval time, slug); selection sort over a set
  pure def before(s: State, a: str, b: str): bool =
    val ta = s.approvals.get(a).time
    val tb = s.approvals.get(b).time
    ta < tb or (ta == tb and rank(a) < rank(b))
  pure def queue(s: State): List[str] =
    val waiting = s.approvals.keys().filter(k => derive(s, k) == "approved")
    waiting.fold([], (acc, _) =>
      val rest = waiting.filter(k => not(acc.indices().exists(i => acc[i] == k)))
      val nxt = rest.fold("", (m, k) => if (m == "" or before(s, k, m)) k else m)
      acc.append(nxt))

  // ---------- recovery (proposal for §3.12) ----------
  // A dead owner's running run is `landed/reconciled` when its Landing was recorded and
  // its candidate commit is on the base; otherwise `failed/interrupted`. Its incoming
  // ref and the claim it owns are removed.
  pure def recover(s: State): State =
    val dead = s.runs.keys().filter(r => s.runs.get(r).status == "running" and not(s.runs.get(r).alive))
    dead.fold(s, (acc, r) =>
      val rn = acc.runs.get(r)
      val landed = rn.landing and onBase(acc, r)
      val fixed = if (landed) { ...rn, status: "landed", reason: "reconciled" }
                  else { ...rn, status: "failed", reason: "interrupted" }
      { ...acc, runs: acc.runs.put(r, fixed), incoming: acc.incoming.exclude(Set(r)),
        claim: if (acc.claim == r) "" else acc.claim })

  // ---------- transition function ----------
  pure def approve(s: State, slug: str, time: int): State =
    if (rank(slug) < 0) err(s, "unknown_slug")
    else if (slugLanded(s, slug)) err(s, "already_landed")
    else if (s.approvals.keys().contains(slug) and derive(s, slug) == "building") err(s, "intent_building")
    else { ...s, approvals: s.approvals.put(slug, { time: time, id: s.nextApproval }),
           nextApproval: s.nextApproval + 1, last: "ok" }

  pure def start(s: State, id: str): State =
    if (s.proc.phase != "") err(s, "queue_running")
    else if (s.runs.keys().contains(id) or onBase(s, id)) err(s, "run_id_reused")
    else
      val r = recover(s)
      val q = queue(r)
      if (q.length() == 0) { ...r, last: "nothing_to_build" }
      else if (r.claim != "") { ...r, last: "claim_held" }
      else
        val slug = q[0]
        val rn = { slug: slug, approval: r.approvals.get(slug).id, started: r.nextStart,
                    status: "running", reason: "", parent: tip(r), landing: false,
                    alive: true, interrupted: false }
        { ...setRun(r, id, rn), nextStart: r.nextStart + 1, claim: id,
          proc: { rid: id, phase: "building" }, last: "ok" }

  pure def gate(s: State, pass: bool): State =
    if (s.proc.phase != "building") err(s, "not_building")
    else
      val id = s.proc.rid
      if (pass) { ...s, proc: { rid: id, phase: "built" }, last: "ok" }
      else { ...setRun(s, id, { ...s.runs.get(id), status: "failed", reason: "gate_red" }),
             claim: "", proc: NO_PROC, last: "ok" }

  pure def advance(s: State): State =
    val id = s.proc.rid
    val rn = s.runs.get(id)
    val ph = s.proc.phase
    if (ph == "built")          // 1. record Landing in rn.json BEFORE anything moves
      { ...setRun(s, id, { ...rn, landing: true }), proc: { rid: id, phase: "recorded" }, last: "ok" }
    else if (ph == "recorded")  // 2. push refs/kogen/incoming/<run> (must not exist)
      { ...s, incoming: s.incoming.union(Set(id)), proc: { rid: id, phase: "pushed" }, last: "ok" }
    else if (ph == "pushed")    // 3. CAS fast-forward of the base from the expected parent
      if (tip(s) == rn.parent)
        { ...s, base: s.base.append({ id: id, slug: rn.slug }), proc: { rid: id, phase: "based" }, last: "ok" }
      else                      //    base moved: park the candidate, release everything
        { ...setRun(s, id, { ...rn, status: "parked", reason: "base_moved" }),
          parked: s.parked.union(Set(id)), incoming: s.incoming.exclude(Set(id)),
          claim: "", proc: NO_PROC, last: "ok" }
    else if (ph == "based")     // 4. CAS-delete the incoming ref
      { ...s, incoming: s.incoming.exclude(Set(id)), proc: { rid: id, phase: "cleaned" }, last: "ok" }
    else if (ph == "cleaned")   // 5. finish: run landed, claim released
      { ...setRun(s, id, { ...rn, status: "landed" }), claim: "", proc: NO_PROC, last: "ok" }
    else err(s, "nothing_to_step")

  pure def kill(s: State, sigterm: bool): State =
    if (s.proc.phase == "") err(s, "no_process")
    else
      val id = s.proc.rid
      { ...setRun(s, id, { ...s.runs.get(id), alive: false, interrupted: sigterm }),
        proc: NO_PROC, last: "ok" }

  pure def pushExternal(s: State, id: str): State =
    if (onBase(s, id) or s.runs.keys().contains(id)) err(s, "commit_exists")
    else { ...s, base: s.base.append({ id: id, slug: "" }), last: "ok" }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Approve(a) => approve(s, a.slug, a.time)
    | Start(id) => start(s, id)
    | Gate(pass) => gate(s, pass)
    | Step => advance(s)
    | Crash => kill(s, false)
    | Interrupt => kill(s, true)
    | PushExternal(id) => pushExternal(s, id)
    | Recover => { ...recover(s), last: "ok" }
  }

  pure def observe(s: State): Obs = {
    last: s.last,
    status: s.approvals.keys().mapBy(k => derive(s, k)),
    queue: queue(s),
    base: s.base.foldl([], (acc, c) => acc.append(c.id)),
    claim: s.claim, incoming: s.incoming, parked: s.parked,
    runs: s.runs.keys().mapBy(r => { slug: s.runs.get(r).slug, status: s.runs.get(r).status,
                                     reason: s.runs.get(r).reason }),
    proc: s.proc,
  }

  // ---------- safety properties (checked on every step of every trace) ----------
  pure def safe(s: State): bool = and {
    // S1 a slug lands at most once
    s.base.indices().forall(i => s.base.indices().forall(j =>
      (i != j and s.base[i].slug != "") implies s.base[i].slug != s.base[j].slug)),
    // S2 every Kogen commit was a CAS from its run's expected parent
    s.base.indices().forall(i => (i > 0 and s.base[i].slug != "") implies
      s.base[i - 1].id == s.runs.get(s.base[i].id).parent),
    // S3 a landed run's commit is on the base
    s.runs.keys().forall(r => s.runs.get(r).status == "landed" implies onBase(s, r)),
    // S4 the claim belongs to a running run
    s.claim != "" implies s.runs.get(s.claim).status == "running",
    // S5 at most one live owner, and it is the Build in flight
    s.runs.keys().forall(r => (s.runs.get(r).status == "running" and s.runs.get(r).alive) implies s.proc.rid == r),
    // S6 incoming refs only for running runs
    s.incoming.forall(r => s.runs.get(r).status == "running"),
    // S7 the base CAS never happens before the Landing record
    s.runs.keys().forall(r => onBase(s, r) implies s.runs.get(r).landing),
  }

  // ---------- state machine for simulation / model checking ----------
  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  // Event universe for simulation. `any` picks uniformly among ENABLED branches, so the
  // guarded branches steer Builds forward (to land, park or crash late) while the first
  // branch keeps every event, refusals included, in play.
  pure val LIFECYCLE: Set[Event] =
    tuples(SLUG_ORDER.indices().map(i => SLUG_ORDER[i]), TIMES).map(((sl, t)) => Approve({ slug: sl, time: t }))
      .union(RUN_IDS.map(r => Start(r)))
  pure val FAULTS: Set[Event] =
    EXTERNAL_IDS.map(x => PushExternal(x)).union(Set(Gate(false), Crash, Interrupt, Recover))
  pure val EVENTS: Set[Event] = LIFECYCLE.union(FAULTS).union(Set(Gate(true), Step))
  action step = any {
    nondet e = EVENTS.oneOf()  fire(e),
    nondet e = LIFECYCLE.oneOf()  fire(e),
    nondet e = FAULTS.oneOf()  fire(e),
    all { st.proc.phase == "building", fire(Gate(true)) },
    all { Set("built", "recorded", "pushed", "based", "cleaned").contains(st.proc.phase), fire(Step) },
  }

  val safety = safe(st)
  // Recovery post-condition: no dead running runs; only the live Build may hold an incoming ref
  val recovered = ev == Recover implies and {
    st.runs.keys().forall(r => not(st.runs.get(r).status == "running" and not(st.runs.get(r).alive))),
    st.incoming.forall(r => r == st.proc.rid),
  }
  val invariant = safety and recovered
}
