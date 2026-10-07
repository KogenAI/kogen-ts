// Intent lifecycle: shape, hash-bound approval CAS, remove.
// Sources: spec §1.7.1, §1.7.3, §2.5.1, §3.2.5 (v1.1).
// The check pipeline inside `intent approve` stays in slices/approve.
// Git, hashing and the lost-CAS race arrive as event fields.
module intent {
  pure val SLUGS: List[str] = ["alpha", "bravo"]

  type Ref = { n: int, hash: str }
  type State = {
    life: str -> str,     // shaped | approved | building | failed | parked | interrupted | landed
    refs: str -> Ref,     // refs/kogen/intents/<slug>
    activeBuilds: Set[str],
    forceRequired: Set[str],
    danglingRefs: Set[str],
    landedSources: Set[str], // files currently present on the shared base ref
    shown: str,
    casTries: int,
    did: str,
    last: str,
    exit: int,
    priorRefs: str -> Ref,
    priorLife: str -> str,
    priorActiveBuilds: Set[str],
    priorForceRequired: Set[str],
    priorDanglingRefs: Set[str],
    priorLandedSources: Set[str],
  }
  type Event =
    | Init
    | Shape({ slug: str, result: str })          // valid | failed | empty | provider
    | Approve({ slug: str, mode: str, hash: str, prefixOk: bool, race: str })
    | Remove({ slug: str, force: bool })
    | Adopt({ slug: str, status: str })          // the queue reporting a Build outcome

  type Obs = {
    last: str, exit: int, did: str, shown: str, casTries: int,
    life: str -> str, refs: str -> Ref,
  }

  pure val INITIAL: State = {
    life: Map(), refs: Map(), shown: "", casTries: 0, did: "", last: "ok", exit: 0,
    activeBuilds: Set(), forceRequired: Set(), danglingRefs: Set(), landedSources: Set(),
    priorRefs: Map(), priorLife: Map(), priorActiveBuilds: Set(), priorForceRequired: Set(),
    priorDanglingRefs: Set(), priorLandedSources: Set(),
  }

  pure def rank(slug: str): int =
    SLUGS.indices().fold(-1, (acc, i) => if (SLUGS[i] == slug) i else acc)

  pure def exitOf(code: str): int =
    if (code == "ok" or code == "needs_decision")
      if (code == "needs_decision") 5 else 0
    else if (Set("candidate/repair_limit", "intent/hash_mismatch").contains(code)) 1
    else if (Set("intent/not_found", "intent/request_unavailable", "intent/remove_blocked",
                 "intent/remove_requires_force", "unknown_slug").contains(code)) 2
    else if (code == "provider/overload") 4
    else 70

  pure def stop(s: State, code: str): State =
    { ...s, last: code, exit: exitOf(code), did: "", shown: "" }

  pure def has(s: State, slug: str): bool = s.life.keys().contains(slug)
  pure def lifeOf(s: State, slug: str): str = if (has(s, slug)) s.life.get(slug) else ""
  pure def dropLife(s: State, slug: str): str -> str =
    s.life.keys().filter(k => k != slug).mapBy(k => s.life.get(k))
  pure def dropRef(s: State, slug: str): str -> Ref =
    s.refs.keys().filter(k => k != slug).mapBy(k => s.refs.get(k))
  pure def refsWithout(refs: str -> Ref, slug: str): str -> Ref =
    refs.keys().filter(k => k != slug).mapBy(k => refs.get(k))
  pure def lifeWithout(life: str -> str, slug: str): str -> str =
    life.keys().filter(k => k != slug).mapBy(k => life.get(k))
  pure def withoutSlug(values: Set[str], slug: str): Set[str] = values.filter(k => k != slug)

  pure def bound(life: str): bool =
    Set("approved", "building", "failed", "parked", "interrupted", "landed").contains(life)

  pure def shape(s: State, slug: str, result: str): State =
    if (rank(slug) < 0) stop(s, "unknown_slug")
    else if (result == "empty") stop(s, "intent/request_unavailable")
    else if (result == "provider") stop(s, "provider/overload")
    else if (result == "failed") { ...stop(s, "candidate/repair_limit"), did: "shape_failed" }
    else if (result != "valid") stop(s, "unknown_result")
    else if (bound(lifeOf(s, slug)))
      // shaping never writes or clears an approval
      { ...s, last: "ok", exit: 0, did: "shaped", shown: "", casTries: s.casTries }
    else
      { ...s, life: s.life.put(slug, "shaped"), last: "ok", exit: 0, did: "shaped", shown: "" }

  pure def approve(s: State, a: { slug: str, mode: str, hash: str, prefixOk: bool, race: str }): State =
    if (rank(a.slug) < 0) stop(s, "unknown_slug")
    else if (not(has(s, a.slug))) stop(s, "intent/not_found")
    else if (a.mode == "card")
      { ...s, last: "needs_decision", exit: 5, did: "card", shown: a.hash, casTries: 0 }
    else if (a.mode != "commit") stop(s, "unknown_mode")
    else if (not(a.prefixOk))
      { ...stop(s, "intent/hash_mismatch"), shown: a.hash, casTries: 0 }
    else if (a.race == "twice")
      {
        ...stop(s, "controller/approval_cas_lost"),
        life: if (s.refs.keys().contains(a.slug)) s.life.put(a.slug, "approved") else s.life,
        danglingRefs: if (s.refs.keys().contains(a.slug)) s.danglingRefs
                      else s.danglingRefs.union(Set(a.slug)),
        casTries: 2,
      }
    else if (a.race != "none" and a.race != "once") stop(s, "unknown_race")
    else
      val prev = if (s.refs.keys().contains(a.slug)) s.refs.get(a.slug).n else 0
      val keep = lifeOf(s, a.slug)
      val life = if (keep == "landed" or keep == "failed" or keep == "parked" or keep == "interrupted")
                   "approved" else if (keep == "shaped") "approved" else "approved"
      { ...s, life: s.life.put(a.slug, life),
        refs: s.refs.put(a.slug, { n: prev + 1, hash: a.hash }),
        danglingRefs: withoutSlug(s.danglingRefs, a.slug),
        last: "ok", exit: 0, did: "approved", shown: a.hash,
        casTries: if (a.race == "once") 2 else 1 }

  pure def needsForce(life: str): bool =
    Set("approved", "failed", "parked", "interrupted").contains(life)

  pure def remove(s: State, slug: str, force: bool): State =
    if (rank(slug) < 0) stop(s, "unknown_slug")
    else if (not(has(s, slug))) stop(s, "intent/not_found")
    else if (s.activeBuilds.contains(slug)) stop(s, "intent/remove_blocked")
    else if (not(force) and not(s.landedSources.contains(slug)) and lifeOf(s, slug) != "landed" and
             (needsForce(lifeOf(s, slug)) or s.forceRequired.contains(slug) or s.danglingRefs.contains(slug)))
      stop(s, "intent/remove_requires_force")
    else
      { ...s, life: dropLife(s, slug), refs: dropRef(s, slug),
        danglingRefs: withoutSlug(s.danglingRefs, slug),
        last: "ok", exit: 0, did: "removed", shown: "", casTries: 0 }

  pure def adopt(s: State, slug: str, status: str): State =
    if (not(Set("building", "failed", "parked", "interrupted", "landed").contains(status)))
      stop(s, "bad_adopt")
    else if (lifeOf(s, slug) != "approved" and not(lifeOf(s, slug) == "building" and status != "building"))
      stop(s, "bad_adopt")
    else
      {
        ...s,
        life: s.life.put(slug, status),
        landedSources: if (status == "landed") s.life.keys() else s.landedSources,
        activeBuilds: if (status == "building") s.activeBuilds.union(Set(slug))
                      else withoutSlug(s.activeBuilds, slug),
        forceRequired: if (Set("failed", "parked", "interrupted").contains(status))
                         s.forceRequired.union(Set(slug)) else s.forceRequired,
        last: "ok", exit: 0, did: "adopted", shown: "",
      }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Shape(g) => shape(s, g.slug, g.result)
    | Approve(a) => approve(s, a)
    | Remove(r) => remove(s, r.slug, r.force)
    | Adopt(g) => adopt(s, g.slug, g.status)
  }

  pure def observe(s: State): Obs = {
    last: s.last, exit: s.exit, did: s.did, shown: s.shown, casTries: s.casTries,
    life: s.life, refs: s.refs,
  }

  pure def safe(s: State, e: Event): bool = and {
    s.exit == exitOf(s.last),
    s.casTries >= 0 and s.casTries <= 2,
    s.refs.keys().forall(k => and {
      s.refs.get(k).n >= 1,
      s.refs.get(k).hash != "",
      has(s, k),
      bound(lifeOf(s, k)),
    }),
    s.life.keys().forall(k =>
      if (lifeOf(s, k) == "shaped") not(s.refs.keys().contains(k))
      else if (bound(lifeOf(s, k))) s.refs.keys().contains(k)
      else false),
    // Production run stores and refs have effects that can outlive the visible
    // approval: a CAS competitor may leave a ref without an approval document,
    // and an active claim still blocks removal after reapproval. These ghost
    // histories make those effects explicit while the public observation stays
    // limited to the CLI-visible lifecycle and valid approval documents.
    match e {
      | Approve(a) =>
        and {
          s.activeBuilds == s.priorActiveBuilds,
          s.forceRequired == s.priorForceRequired,
          s.landedSources == s.priorLandedSources,
          s.did != "approved" implies s.refs == s.priorRefs,
          s.did != "approved" and s.last == "controller/approval_cas_lost" and
            s.priorRefs.keys().contains(a.slug) implies
              s.life == s.priorLife.put(a.slug, "approved"),
          s.did != "approved" and not(s.last == "controller/approval_cas_lost" and
            s.priorRefs.keys().contains(a.slug)) implies s.life == s.priorLife,
          s.did == "approved" implies s.life.get(a.slug) == "approved",
          lifeWithout(s.life, a.slug) == lifeWithout(s.priorLife, a.slug),
          s.danglingRefs == if (s.did == "approved") withoutSlug(s.priorDanglingRefs, a.slug)
                            else if (s.last == "controller/approval_cas_lost" and
                                     not(s.priorRefs.keys().contains(a.slug)))
                              s.priorDanglingRefs.union(Set(a.slug))
                            else s.priorDanglingRefs,
          s.did == "approved" implies (
            s.refs.keys().contains(a.slug) and s.refs.get(a.slug).hash == a.hash and
            s.refs.get(a.slug).n == (if (s.priorRefs.keys().contains(a.slug)) s.priorRefs.get(a.slug).n else 0) + 1 and
            refsWithout(s.refs, a.slug) == refsWithout(s.priorRefs, a.slug)
          ),
        }
      | Shape(a) =>
        and {
          s.refs == s.priorRefs,
          s.activeBuilds == s.priorActiveBuilds,
          s.forceRequired == s.priorForceRequired,
          s.landedSources == s.priorLandedSources,
          s.danglingRefs == s.priorDanglingRefs,
          if (s.did == "shaped" and
              not(s.priorLife.keys().contains(a.slug) and bound(s.priorLife.get(a.slug))))
            s.life == s.priorLife.put(a.slug, "shaped")
          else s.life == s.priorLife,
        }
      | Remove(a) =>
        and {
          s.activeBuilds == s.priorActiveBuilds,
          s.forceRequired == s.priorForceRequired,
          s.landedSources == s.priorLandedSources,
          if (s.did == "removed")
            and {
              s.life == lifeWithout(s.priorLife, a.slug),
              s.refs == refsWithout(s.priorRefs, a.slug),
              s.danglingRefs == withoutSlug(s.priorDanglingRefs, a.slug),
            }
          else and {
            s.life == s.priorLife,
            s.refs == s.priorRefs,
            s.danglingRefs == s.priorDanglingRefs,
          },
        }
      | Adopt(a) =>
        and {
          s.refs == s.priorRefs,
          s.danglingRefs == s.priorDanglingRefs,
          if (s.did == "adopted")
            and {
              s.life == s.priorLife.put(a.slug, a.status),
              s.landedSources == if (a.status == "landed") s.priorLife.keys() else s.priorLandedSources,
              s.activeBuilds == if (a.status == "building") s.priorActiveBuilds.union(Set(a.slug))
                                else withoutSlug(s.priorActiveBuilds, a.slug),
              s.forceRequired == if (Set("failed", "parked", "interrupted").contains(a.status))
                                   s.priorForceRequired.union(Set(a.slug)) else s.priorForceRequired,
            }
          else and {
            s.life == s.priorLife,
            s.landedSources == s.priorLandedSources,
            s.activeBuilds == s.priorActiveBuilds,
            s.forceRequired == s.priorForceRequired,
          },
        }
      | _ => true
    },
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = {
      ...n,
      priorRefs: st.refs,
      priorLife: st.life,
      priorActiveBuilds: st.activeBuilds,
      priorForceRequired: st.forceRequired,
      priorDanglingRefs: st.danglingRefs,
      priorLandedSources: st.landedSources,
    }, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  action step = any {
    all {
      nondet slug = Set("alpha", "bravo", "nope").oneOf()
      nondet result = Set("valid", "failed", "empty", "provider").oneOf()
      fire(Shape({ slug: slug, result: result }))
    },
    all {
      nondet slug = Set("alpha", "bravo").oneOf()
      nondet mode = Set("card", "commit").oneOf()
      nondet prefixOk = Set(true, false).oneOf()
      nondet race = Set("none", "once", "twice").oneOf()
      fire(Approve({ slug: slug, mode: mode, hash: "abcd1234", prefixOk: prefixOk, race: race }))
    },
    all {
      nondet slug = Set("alpha", "bravo").oneOf()
      nondet force = Set(true, false).oneOf()
      fire(Remove({ slug: slug, force: force }))
    },
    all {
      nondet slug = Set("alpha", "bravo").oneOf()
      nondet status = Set("building", "failed", "parked", "interrupted", "landed").oneOf()
      fire(Adopt({ slug: slug, status: status }))
    },
  }

  val invariant = safe(st, ev)
}
