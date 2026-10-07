// Status. Sources: spec §2.11 and §1.7.5 (v1.2, read 2026-10-06).
// First same: landed, building, failed or parked, approved (a stopped run stays queued),
// blocked, draft. Interrupted overrides approved, building, and failed when the latest run
// of this approval is a dead interrupted owner, or failed with reason interrupted. Landed
// wins first. The queue is approved Intents by descending priority, then approval time,
// then slug. Elapsed buckets use the run's started_at. The JSON object in the spec has no
// detail field. Sections omit empties, in the spec order, and landed keeps five newest.
module status {
  type Card = {
    slug: str, status: str, priority: int, at: int, blocks: str, sched: str,
    started: int, index: int,
    trailer: bool, claimed: bool, runStatus: str, event: str, alive: bool,
    approved: bool, reason: str, same: bool, fromRaw: bool,
  }
  type Item = { slug: str, priority: int, at: int }
  type State = {
    alpha: Card, bravo: Card, charlie: Card,
    running: bool, now: int, older: int, fromRaw: bool,
    exit: int, jsonDetail: bool, last: str, watchSlug: str, agentsBusy: int,
  }
  type RowA = {
    slug: str, status: str, priority: int, at: int, blocks: str, sched: str,
    started: int, index: int,
  }
  type RawA = {
    slug: str, trailer: bool, claimed: bool, runStatus: str, event: str, alive: bool,
    approved: bool, reason: str, same: bool, blocks: str, priority: int, at: int,
  }
  type Event =
    | Init
    | Row(RowA)
    | Raw(RawA)
    | Derive
    | Now({ t: int })
    | Older({ n: int })
    | Queue({ running: bool })
    | Agents({ busy: int })
    | Watch({ slug: str })
    | Json
  type Obs = {
    last: str, alpha: str, bravo: str, charlie: str,
    queue: List[str], whyA: str, whyB: str, whyC: str,
    sections: List[str], earlier: int, elapsed: str, queueLine: str,
    next: str, nextPriority: int, nextDependencies: str,
    landedShown: int, watchSlug: str, watchStatus: str, watchPosition: int, watchQueueSize: int,
    exit: int, jsonDetail: bool,
  }

  pure val BLANK: Card = {
    slug: "", status: "", priority: 0, at: 0, blocks: "", sched: "", started: 0, index: 0,
    trailer: false, claimed: false, runStatus: "", event: "", alive: true,
    approved: false, reason: "", same: true, fromRaw: false,
  }
  pure val INITIAL: State = {
    alpha: BLANK, bravo: BLANK, charlie: BLANK,
    running: false, now: 0, older: 0, fromRaw: false, exit: 0, jsonDetail: false, last: "ok",
    watchSlug: "", agentsBusy: 0,
  }

  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def known(slug: str): bool = slug == "alpha" or slug == "bravo" or slug == "charlie"
  pure def rank(slug: str): int = if (slug == "alpha") 0 else if (slug == "bravo") 1 else 2
  pure def knownStatus(n: str): bool =
    n == "approved" or n == "building" or n == "failed" or n == "parked" or n == "draft" or n == "landed" or n == "interrupted"

  pure def life(c: Card): str =
    if (c.trailer) "landed"
    else if (c.claimed and c.runStatus == "running") "building"
    else if (c.approved and c.same and c.runStatus == "parked") "parked"
    else if (c.approved and c.same and c.runStatus == "failed") "failed"
    else if (c.approved) "approved"
    else "draft"

  pure def interrupt(c: Card, status: str): str =
    if (status != "approved" and status != "building" and status != "failed") status
    else if (not(c.same)) status
    else if (c.runStatus == "running" and c.event == "interrupted" and not(c.alive)) "interrupted"
    else if (c.runStatus == "failed" and c.reason == "interrupted") "interrupted"
    else status

  pure def selfCycle(slug: str): str =
    if (slug == "alpha") "dependency cycle: alpha -> alpha"
    else if (slug == "bravo") "dependency cycle: bravo -> bravo"
    else "dependency cycle: charlie -> charlie"

  pure def pairCycle(slug: str, other: str): str =
    if (slug == "alpha" and other == "bravo") "dependency cycle: alpha -> bravo -> alpha"
    else if (slug == "bravo" and other == "alpha") "dependency cycle: bravo -> alpha -> bravo"
    else if (slug == "alpha" and other == "charlie") "dependency cycle: alpha -> charlie -> alpha"
    else if (slug == "charlie" and other == "alpha") "dependency cycle: charlie -> alpha -> charlie"
    else if (slug == "bravo" and other == "charlie") "dependency cycle: bravo -> charlie -> bravo"
    else "dependency cycle: charlie -> bravo -> charlie"

  pure def tri(slug: str, dir: str): str =
    if (dir == "fwd" and slug == "alpha") "dependency cycle: alpha -> bravo -> charlie -> alpha"
    else if (dir == "fwd" and slug == "bravo") "dependency cycle: bravo -> charlie -> alpha -> bravo"
    else if (dir == "fwd") "dependency cycle: charlie -> alpha -> bravo -> charlie"
    else if (slug == "alpha") "dependency cycle: alpha -> charlie -> bravo -> alpha"
    else if (slug == "charlie") "dependency cycle: charlie -> bravo -> alpha -> charlie"
    else "dependency cycle: bravo -> alpha -> charlie -> bravo"

  pure def waiting(slug: str): str =
    if (slug == "alpha") "waiting for delivered dependencies: alpha"
    else if (slug == "bravo") "waiting for delivered dependencies: bravo"
    else "waiting for delivered dependencies: charlie"

  pure def unknown(slug: str): str =
    if (slug == "ghost") "unknown dependencies: ghost"
    else if (slug == "alpha") "unknown dependencies: alpha"
    else if (slug == "bravo") "unknown dependencies: bravo"
    else "unknown dependencies: charlie"

  pure def card(s: State, slug: str): Card =
    if (slug == "alpha") s.alpha else if (slug == "bravo") s.bravo else s.charlie

  pure def blocksOf(s: State, slug: str): str =
    if (not(known(slug))) "" else card(s, slug).blocks

  pure def present(s: State, slug: str): bool = known(slug) and card(s, slug).status != ""

  pure def cycle(s: State, c: Card): str =
    if (c.blocks == c.slug) selfCycle(c.slug)
    else if (blocksOf(s, c.blocks) == c.slug) pairCycle(c.slug, c.blocks)
    else if (c.slug == "alpha" and c.blocks == "bravo" and s.bravo.blocks == "charlie" and s.charlie.blocks == "alpha") tri("alpha", "fwd")
    else if (c.slug == "bravo" and c.blocks == "charlie" and s.charlie.blocks == "alpha" and s.alpha.blocks == "bravo") tri("bravo", "fwd")
    else if (c.slug == "charlie" and c.blocks == "alpha" and s.alpha.blocks == "bravo" and s.bravo.blocks == "charlie") tri("charlie", "fwd")
    else if (c.slug == "alpha" and c.blocks == "charlie" and s.charlie.blocks == "bravo" and s.bravo.blocks == "alpha") tri("alpha", "rev")
    else if (c.slug == "charlie" and c.blocks == "bravo" and s.bravo.blocks == "alpha" and s.alpha.blocks == "charlie") tri("charlie", "rev")
    else if (c.slug == "bravo" and c.blocks == "alpha" and s.alpha.blocks == "charlie" and s.charlie.blocks == "bravo") tri("bravo", "rev")
    else ""

  pure def why(s: State, c: Card): str =
    if (c.status != "approved" and c.status != "blocked") ""
    else if (c.sched != "") c.sched
    else if (c.blocks == "" ) ""
    else if (c.blocks == "BAD") "invalid dependencies: BAD"
    else if (not(present(s, c.blocks)) and c.blocks != c.slug) unknown(if (known(c.blocks)) c.blocks else "ghost")
    else
      val loop = cycle(s, c)
      if (loop != "") loop
      else if (card(s, c.blocks).status == "landed") ""
      else waiting(c.blocks)

  pure def finish(c: Card, w: str): Card =
    if (c.status != "approved" and c.status != "blocked") { ...c, sched: c.sched }
    else if (w == "") { ...c, status: "approved" }
    else { ...c, status: "blocked" }

  // why() reads status, so prepare in two passes: reasons from the pre-blocked view, then status.
  pure def view(s: State): State =
    val wa = why(s, s.alpha)
    val wb = why(s, s.bravo)
    val wc = why(s, s.charlie)
    { ...s, alpha: finish(s.alpha, wa), bravo: finish(s.bravo, wb), charlie: finish(s.charlie, wc) }

  pure def before(x: Item, y: Item): bool =
    if (x.priority != y.priority) x.priority > y.priority
    else if (x.at != y.at) x.at < y.at
    else rank(x.slug) < rank(y.slug)

  pure def enqueue(xs: List[Item], slug: str, c: Card): List[Item] =
    if (c.status != "approved") xs else xs.append({ slug: slug, priority: c.priority, at: c.at })

  pure def order2(x: Item, y: Item): List[str] =
    if (before(x, y)) [x.slug, y.slug] else [y.slug, x.slug]

  pure def order3(x: Item, y: Item, z: Item): List[str] =
    if (before(x, y) and before(x, z)) concat([x.slug], order2(y, z))
    else if (before(y, z)) concat([y.slug], order2(x, z))
    else concat([z.slug], order2(x, y))

  pure def queueOf(s: State): List[str] =
    val xs = enqueue(enqueue(enqueue([], "alpha", s.alpha), "bravo", s.bravo), "charlie", s.charlie)
    if (length(xs) == 0) []
    else if (length(xs) == 1) [head(xs).slug]
    else if (length(xs) == 2) order2(head(xs), head(tail(xs)))
    else order3(head(xs), head(tail(xs)), head(tail(tail(xs))))

  pure def count(s: State, status: str): int =
    (if (s.alpha.status == status) 1 else 0) +
    (if (s.bravo.status == status) 1 else 0) +
    (if (s.charlie.status == status) 1 else 0)

  pure def sections(s: State, queued: int): List[str] =
    val b = if (count(s, "building") > 0) ["Building"] else []
    val q = if (queued > 0) b.append("Queued") else b
    val k = if (count(s, "blocked") > 0) q.append("Blocked") else q
    val f = if (count(s, "failed") > 0) k.append("Failed") else k
    val p = if (count(s, "parked") > 0) f.append("Parked") else f
    val i = if (count(s, "interrupted") > 0) p.append("Interrupted") else p
    val d = if (count(s, "draft") > 0) i.append("Drafts") else i
    if (count(s, "landed") + s.older > 0) d.append("Landed") else d

  pure def bucket(s: State, c: Card): str =
    if (c.status != "building" or c.started == 0) ""
    else
      val d = s.now - c.started
      if (d < 60) "s" else if (d < 3600) "m" else "h"

  pure def elapsed(s: State): str =
    if (s.alpha.status == "building") bucket(s, s.alpha)
    else if (s.bravo.status == "building") bucket(s, s.bravo)
    else bucket(s, s.charlie)

  pure def queueLine(s: State, queued: int): str =
    if (s.running) "running" else if (queued > 0) "waiting" else "stopped"

  pure def nextSlug(s: State): str =
    val q = queueOf(view(s))
    if (length(q) == 0) "" else head(q)

  pure def nextPriority(s: State): int =
    val slug = nextSlug(s)
    if (slug == "") 0 else card(view(s), slug).priority

  pure def nextDependencies(s: State): str =
    val slug = nextSlug(s)
    if (slug == "") ""
    else if (card(view(s), slug).blocks == "") "no_dependencies"
    else "dependencies_delivered"

  pure def landedShown(s: State): int =
    val n = count(s, "landed") + s.older
    if (n > 5) 5 else n

  pure def queuePosition(xs: List[str], slug: str): int =
    xs.indices().fold(-1, (found, i) => if (xs[i] == slug) i else found)

  pure def watchStatus(s: State): str =
    if (s.watchSlug == "") ""
    else if (s.exit == 2) "not_found"
    else if (card(view(s), s.watchSlug).status == "approved") "queued"
    else card(view(s), s.watchSlug).status

  pure def earlierOf(s: State): int =
    val t = count(s, "landed") + s.older
    if (t > 5) t - 5 else 0

  pure def buildingN(s: State): int = count(s, "building")

  pure def watch(s: State, slug: str): int =
    if (slug != "" and (not(known(slug)) or card(s, slug).status == "")) 2
    else if (slug == "") if (not(s.running) and buildingN(s) == 0 and s.agentsBusy == 0) 0 else -1
    else if (card(s, slug).status == "landed") 0
    else 1

  pure def putCard(s: State, slug: str, c: Card): State =
    if (slug == "alpha") { ...s, alpha: c } else if (slug == "bravo") { ...s, bravo: c } else { ...s, charlie: c }

  pure def row(s: State, a: RowA): State =
    if (not(known(a.slug))) err(s, "bad_slug")
    else if (not(knownStatus(a.status))) err(s, "bad_status")
    else if (a.blocks != "" and a.blocks != "BAD" and a.blocks != "ghost" and not(known(a.blocks))) err(s, "bad_blocks")
    else
      val prev = card(s, a.slug)
      val c = {
        ...prev, slug: a.slug, status: a.status, priority: a.priority, at: a.at, blocks: a.blocks, sched: a.sched,
        started: a.started, index: a.index, fromRaw: false,
      }
      view({ ...putCard(s, a.slug, c), fromRaw: false, last: "ok" })

  pure def staged(prev: Card, a: RawA): Card = {
    ...prev, slug: a.slug, trailer: a.trailer, claimed: a.claimed, runStatus: a.runStatus, event: a.event, alive: a.alive,
    approved: a.approved, reason: a.reason, same: a.same, blocks: a.blocks, priority: a.priority, at: a.at,
    status: "draft", fromRaw: true,
  }

  pure def derived(prev: Card, a: RawA): Card =
    val base = staged(prev, a)
    { ...base, status: interrupt(base, life(base)) }

  pure def raw(s: State, a: RawA): State =
    if (not(known(a.slug))) err(s, "bad_slug")
    else if (a.blocks != "" and a.blocks != "BAD" and a.blocks != "ghost" and not(known(a.blocks))) err(s, "bad_blocks")
    else { ...putCard(s, a.slug, derived(card(s, a.slug), a)), fromRaw: true, last: "ok" }

  pure def derive(s: State): State =
    if (not(s.fromRaw)) { ...s, last: "ok" }
    else
      val a = if (s.alpha.fromRaw) { ...s.alpha, status: interrupt(s.alpha, life(s.alpha)) } else s.alpha
      val b = if (s.bravo.fromRaw) { ...s.bravo, status: interrupt(s.bravo, life(s.bravo)) } else s.bravo
      val c = if (s.charlie.fromRaw) { ...s.charlie, status: interrupt(s.charlie, life(s.charlie)) } else s.charlie
      view({ ...s, alpha: a, bravo: b, charlie: c, fromRaw: true, last: "ok" })

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Row(a) => row(s, a)
    | Raw(a) => view(raw(s, a))
    | Derive => derive(s)
    | Now(a) => { ...s, now: a.t, last: "ok" }
    | Older(a) => if (a.n < 0) err(s, "bad_older") else { ...s, older: a.n, last: "ok" }
    | Queue(a) => { ...s, running: a.running, last: "ok" }
    | Agents(a) => if (a.busy < 0) err(s, "bad_agents") else { ...s, agentsBusy: a.busy, last: "ok" }
    | Watch(a) => { ...view(s), watchSlug: a.slug, exit: watch(view(s), a.slug), last: "ok" }
    | Json => { ...s, jsonDetail: false, last: "ok" }
  }

  pure def observe(s: State): Obs =
    val shown = view(s)
    val q = queueOf(shown)
    {
      last: s.last, alpha: shown.alpha.status, bravo: shown.bravo.status, charlie: shown.charlie.status,
      queue: q, whyA: why(s, s.alpha), whyB: why(s, s.bravo), whyC: why(s, s.charlie),
      sections: sections(shown, length(q)), earlier: earlierOf(shown), elapsed: elapsed(shown),
      queueLine: queueLine(shown, length(q)), next: nextSlug(shown),
      nextPriority: nextPriority(shown), nextDependencies: nextDependencies(shown),
      landedShown: landedShown(shown), watchSlug: s.watchSlug, watchStatus: watchStatus(s),
      watchPosition: queuePosition(q, s.watchSlug), watchQueueSize: length(q),
      exit: s.exit, jsonDetail: s.jsonDetail,
    }

  // observe() prepares again. why() must see the pre-prepare statuses, which are s, not shown.
  // Shown statuses are post-prepare. Sections use shown. Good.
  // BUG: observe calls view(s) but s may already be post-view from apply. view is idempotent
  // on approved/blocked. why(s) uses s's stored statuses. After apply, stored statuses are
  // already finished, so why() still computes from blocks. Good.

  pure def idx(title: str): int =
    if (title == "Building") 0 else if (title == "Queued") 1 else if (title == "Blocked") 2
    else if (title == "Failed") 3 else if (title == "Parked") 4 else if (title == "Interrupted") 5
    else if (title == "Drafts") 6 else 7

  pure def ordered(xs: List[str]): bool =
    xs.foldl({ ok: true, prev: -1 }, (a, x) => { ok: a.ok and a.prev < idx(x), prev: idx(x) }).ok

  pure def inQueue(q: List[str], slug: str): bool = q.foldl(false, (a, x) => a or x == slug)

  pure def safe(s: State): bool =
    val o = observe(s)
    and {
      s.jsonDetail == false,
      s.exit == -1 or s.exit == 0 or s.exit == 1 or s.exit == 2,
      s.older >= 0,
      s.agentsBusy >= 0,
      o.earlier >= 0,
      o.landedShown >= 0 and o.landedShown <= 5,
      o.watchPosition >= -1,
      o.watchStatus == "" or o.watchStatus == "not_found" or o.watchStatus == "queued" or
        knownStatus(o.watchStatus) or o.watchStatus == "blocked",
      o.watchStatus == "not_found" implies s.exit == 2,
      o.elapsed == "" or o.elapsed == "s" or o.elapsed == "m" or o.elapsed == "h",
      ordered(o.sections),
      o.queue.foldl(true, (a, slug) => a and card(view(s), slug).status == "approved"),
      not(inQueue(o.queue, "alpha") and view(s).alpha.status == "blocked"),
      not(inQueue(o.queue, "bravo") and view(s).bravo.status == "blocked"),
      not(inQueue(o.queue, "charlie") and view(s).charlie.status == "blocked"),
      s.fromRaw and s.alpha.trailer implies o.alpha == "landed",
      s.fromRaw and s.bravo.trailer implies o.bravo == "landed",
      s.fromRaw and s.charlie.trailer implies o.charlie == "landed",
      o.queueLine == "running" implies s.running,
      length(o.queue) == 0 implies o.queueLine != "waiting",
    }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure def rowEv(slug: str, status: str, priority: int, at: int, blocks: str): Event =
    Row({ slug: slug, status: status, priority: priority, at: at, blocks: blocks, sched: "", started: 0, index: 0 })

  action step = any {
    all { not(st.fromRaw), fire(rowEv("alpha", "approved", 1, 1, "")) },
    all { not(st.fromRaw), fire(rowEv("bravo", "approved", 2, 1, "alpha")) },
    all { not(st.fromRaw), fire(rowEv("charlie", "draft", 0, 0, "")) },
    all { not(st.fromRaw), fire(rowEv("alpha", "building", 0, 0, "")) },
    all { not(st.fromRaw), fire(rowEv("alpha", "failed", 0, 0, "")) },
    all { not(st.fromRaw), fire(rowEv("bravo", "parked", 0, 0, "")) },
    all { not(st.fromRaw), fire(rowEv("charlie", "interrupted", 0, 0, "")) },
    all { not(st.fromRaw), fire(rowEv("charlie", "approved", 0, 0, "BAD")) },
    all { not(st.fromRaw), fire(rowEv("bravo", "landed", 0, 0, "")) },
    all { not(st.fromRaw), fire(Row({ slug: "alpha", status: "building", priority: 0, at: 0, blocks: "", sched: "", started: 70, index: 0 })) },
    fire(Raw({ slug: "alpha", trailer: true, claimed: true, runStatus: "running", event: "interrupted", alive: false, approved: true, reason: "", same: true, blocks: "", priority: 1, at: 1 })),
    fire(Raw({ slug: "bravo", trailer: false, claimed: true, runStatus: "running", event: "interrupted", alive: false, approved: true, reason: "", same: true, blocks: "", priority: 0, at: 0 })),
    fire(Raw({ slug: "charlie", trailer: false, claimed: true, runStatus: "failed", event: "other", alive: false, approved: true, reason: "interrupted", same: true, blocks: "", priority: 0, at: 0 })),
    fire(Derive),
    fire(Now({ t: 100 })),
    fire(Now({ t: 3670 })),
    fire(Older({ n: 6 })),
    fire(Queue({ running: true })),
    fire(Queue({ running: false })),
    fire(Agents({ busy: 0 })),
    fire(Agents({ busy: 1 })),
    fire(Watch({ slug: "" })),
    fire(Watch({ slug: "alpha" })),
    fire(Watch({ slug: "missing" })),
    fire(Json),
    fire(Init),
  }

  val invariant = safe(st)
}
