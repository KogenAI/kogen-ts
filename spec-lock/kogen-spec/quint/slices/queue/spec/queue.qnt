// Queue lock and drain. Sources: spec §1.7.4 and §3.11 (v1.2).
// One drain at a time. Order is descending priority, approval time, then slug.
// A second start while the owner is alive is a no-op.
// A dead owner is taken over. Stop finishes the current Build, then ends the drain.
module queue {
  pure val SLUGS: List[str] = ["alpha", "bravo", "charlie"]

  type State = {
    held: bool,
    alive: bool,
    stop: bool,
    phase: str,                 // idle | building
    current: str,
    waiting: str -> { time: int, priority: int }, // current approval order key
    attempted: Set[str],
    built: int,
    landed: int,
    exit: int,
    last: str,
    line: str,
    priorWaiting: str -> { time: int, priority: int },
    priorCurrent: str,
  }
  type Event =
    | Init
    | Enqueue({ slug: str, time: int, priority: int })
    | Start
    | Die
    | Halt                         // queue stop
    | Outcome({ kind: str })       // landed | failed | failed_provider | parked | stopped_environment | stopped_provider | stopped_controller | skipped
    | Release

  type Obs = {
    last: str, line: str, exit: int, held: bool, alive: bool, stop: bool,
    phase: str, current: str, queue: List[str], built: int, landed: int,
  }

  pure val INITIAL: State = {
    held: false, alive: false, stop: false, phase: "idle", current: "",
    waiting: Map(), attempted: Set(), built: 0, landed: 0, exit: 0, last: "ok", line: "",
    priorWaiting: Map(), priorCurrent: "",
  }

  pure def rank(slug: str): int =
    SLUGS.indices().fold(-1, (acc, i) => if (SLUGS[i] == slug) i else acc)

  pure def err(s: State, code: str): State = { ...s, last: code, line: code }

  pure def drop(s: State, slug: str): str -> { time: int, priority: int } =
    s.waiting.keys().filter(k => k != slug).mapBy(k => s.waiting.get(k))

  pure def before(s: State, a: str, b: str): bool =
    val ka = s.waiting.get(a)
    val kb = s.waiting.get(b)
    ka.priority > kb.priority or (ka.priority == kb.priority and
      (ka.time < kb.time or (ka.time == kb.time and rank(a) < rank(b))))

  // oldest queued approval not yet attempted in this drain, and not the one in flight
  pure def nextSlug(s: State): str =
    s.waiting.keys().filter(k => not(s.attempted.contains(k))).fold("", (m, k) =>
      if (m == "" or before(s, k, m)) k else m)

  pure def ordered(s: State): List[str] =
    val waiting = s.waiting.keys().filter(k => not(s.attempted.contains(k)))
    waiting.fold([], (acc, _) =>
      val rest = waiting.filter(k => not(acc.indices().exists(i => acc[i] == k)))
      val nxt = rest.fold("", (m, k) => if (m == "" or before(s, k, m)) k else m)
      if (nxt == "") acc else acc.append(nxt))

  pure def finishDrain(s: State, line: str, exit: int): State =
    { ...s, held: false, alive: false, stop: false, phase: "idle", current: "",
      attempted: Set(), last: "ok", line: line, exit: exit }

  pure def counts(s: State): str =
    if (s.built == 0) "nothing_to_build" else "done"

  pure def countsExit(s: State): int =
    if (s.built == 0 or s.landed == s.built) 0 else 1

  pure def launch(s: State): State =
    if (s.stop) finishDrain(s, "stopped_on_request", 0)
    else
      val n = nextSlug(s)
      if (n == "") finishDrain(s, counts(s), countsExit(s))
      else
        { ...s, phase: "building", current: n, attempted: s.attempted.union(Set(n)),
          last: "ok", line: "building", exit: 0 }

  pure def enqueue(s: State, slug: str, time: int, priority: int): State =
    if (rank(slug) < 0) err(s, "unknown_slug")
    else { ...s, waiting: s.waiting.put(slug, { time: time, priority: priority }), last: "ok", line: "enqueued" }

  pure def start(s: State): State =
    if (s.held and s.alive) { ...s, last: "ok", line: "already_running", exit: 0 }
    else
      // acquiring clears queue.stop and this drain's attempt set
      launch({ ...s, held: true, alive: true, stop: false, attempted: Set(),
               built: 0, landed: 0, phase: "idle", current: "" })

  pure def die(s: State): State =
    if (not(s.held)) err(s, "no_process")
    else { ...s, alive: false, last: "ok", line: "owner_dead" }

  pure def halt(s: State): State =
    if (not(s.held) or not(s.alive)) { ...s, last: "ok", line: "not_running", exit: 0 }
    else { ...s, stop: true, last: "ok", line: "stopping" }

  pure def release(s: State): State =
    if (not(s.held) or not(s.alive)) err(s, "not_owner")
    else if (s.phase == "building") err(s, "build_in_flight")
    else finishDrain(s, "released", 0)

  pure def outcome(s: State, kind: str): State =
    if (s.phase != "building" or not(s.alive)) err(s, "not_building")
    else if (kind == "skipped")
      launch({ ...s, waiting: drop(s, s.current), current: "", phase: "idle" })
    else if (kind == "landed" or kind == "failed" or kind == "failed_provider" or kind == "parked")
      val built = s.built + 1
      val landed = s.landed + (if (kind == "landed") 1 else 0)
      launch({ ...s, waiting: drop(s, s.current), current: "", phase: "idle",
               built: built, landed: landed })
    else if (kind == "stopped_environment" or kind == "stopped_provider" or kind == "stopped_controller")
      val exit = if (kind == "stopped_environment") 3 else if (kind == "stopped_provider") 4 else 70
      finishDrain({ ...s, built: s.built + 1 }, "stopped_because", exit)
    else err(s, "unknown_outcome")

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Enqueue(g) => enqueue(s, g.slug, g.time, g.priority)
    | Start => start(s)
    | Die => die(s)
    | Halt => halt(s)
    | Outcome(g) => outcome(s, g.kind)
    | Release => release(s)
  }

  pure def observe(s: State): Obs = {
    last: s.last, line: s.line, exit: s.exit, held: s.held, alive: s.alive, stop: s.stop,
    phase: s.phase, current: s.current, queue: ordered(s), built: s.built, landed: s.landed,
  }

  pure def safe(s: State): bool = and {
    s.phase == "building" implies and {
      s.held, s.current != "", s.attempted.contains(s.current), s.waiting.keys().contains(s.current),
    },
    not(s.held) implies and { s.phase == "idle", s.current == "", not(s.alive) },
    s.landed <= s.built,
    s.landed >= 0 and s.built >= 0,
    // A provider stop releases the drain but retains its current approval for a retry.
    s.line == "stopped_because" implies and { not(s.held), s.exit == 3 or s.exit == 4 or s.exit == 70 },
    s.line == "stopped_because" and s.exit == 4 implies and {
      s.priorCurrent != "",
      s.waiting == s.priorWaiting,
      s.waiting.keys().contains(s.priorCurrent),
    },
    s.line == "already_running" implies and { s.held, s.alive },
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = { ...n, priorWaiting: st.waiting, priorCurrent: st.current }, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  action step = any {
    all {
      nondet slug = Set("alpha", "bravo", "charlie").oneOf()
      nondet time = Set(1, 2, 3).oneOf()
      nondet priority = Set(-1, 0, 1).oneOf()
      fire(Enqueue({ slug: slug, time: time, priority: priority }))
    },
    fire(Start),
    fire(Die),
    fire(Halt),
    fire(Release),
    all {
      nondet kind = Set("landed", "failed", "failed_provider", "parked", "stopped_environment", "stopped_provider", "stopped_controller", "skipped").oneOf()
      fire(Outcome({ kind: kind }))
    },
    all { st.phase == "building", fire(Outcome({ kind: "landed" })) },
    all { not(st.held), fire(Start) },
  }

  val invariant = safe(st)
}
