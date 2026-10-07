// Bounded setup-output cache lifecycle. Key is the spec's cache identity tuple; the hash
// representation is deliberately abstract because Quint's core library has no SHA-256.
// Sources: spec §2.9 (v1.2, read 2026-10-06).
module setup_cache {
  pure val BASES: Set[str] = Set("a", "b", "c", "d")
  pure val VARIANTS: Set[str] = Set("", "env1", "env2")
  pure val INPUTS: Set[str] = Set("", "one", "two")

  type Key = { base: str, variant: str, tracked: bool, input: str }
  type Entry = { key: Key, payload: str }
  type RunA = {
    base: str, variant: str, tracked: bool, input: str,
    enabled: bool, stable: bool, ok: bool, payload: str,
  }
  type MutateA = { payload: str }
  type State = {
    entries: List[Entry],
    work: str,
    present: bool,
    reused: bool,
    setupRuns: int,
    last: str,
  }
  type Event = Init | Run(RunA) | Mutate(MutateA)
  type Obs = {
    entryCount: int, work: str, present: bool, reused: bool, setupRuns: int, last: str,
  }

  pure val EMPTY_KEY: Key = { base: "", variant: "", tracked: false, input: "" }
  pure val EMPTY_ENTRY: Entry = { key: EMPTY_KEY, payload: "" }
  pure val INITIAL: State = {
    entries: [], work: "", present: false, reused: false, setupRuns: 0, last: "ok",
  }

  pure def sameKey(left: Key, right: Key): bool = and {
    left.base == right.base,
    left.variant == right.variant,
    left.tracked == right.tracked,
    left.input == right.input,
  }

  // Declared setup inputs replace base_tree in the key; otherwise base_tree participates.
  pure def keyOf(a: RunA): Key = {
    base: if (a.tracked) "" else a.base,
    variant: a.variant,
    tracked: a.tracked,
    input: if (a.tracked) a.input else "",
  }

  pure def hasKey(entries: List[Entry], key: Key): bool =
    entries.foldl(false, (found, entry) => found or sameKey(entry.key, key))

  pure def findEntry(entries: List[Entry], key: Key): Entry =
    entries.foldl(EMPTY_ENTRY, (found, entry) => if (sameKey(entry.key, key)) entry else found)

  pure def withoutKey(entries: List[Entry], key: Key): List[Entry] =
    entries.foldl([], (kept, entry) => if (sameKey(entry.key, key)) kept else kept.append(entry))

  // Entries are in least-recently-used to most-recently-used order.
  pure def trim(entries: List[Entry]): List[Entry] =
    if (length(entries) <= 3) entries else tail(entries)

  pure def err(s: State, code: str): State = { ...s, last: code }

  pure def transition(s: State, a: RunA): State =
    if (not(BASES.contains(a.base)) or not(VARIANTS.contains(a.variant)) or not(INPUTS.contains(a.input)))
      err(s, "bad_key_input")
    else
      val key = keyOf(a)
      if (a.enabled and hasKey(s.entries, key))
        val cached = findEntry(s.entries, key)
        val touched = withoutKey(s.entries, key).append(cached)
        { ...s, entries: touched, work: cached.payload, present: true, reused: true, last: "hit" }
      else if (not(a.ok))
        { ...s, work: "", present: false, reused: false, setupRuns: s.setupRuns + 1, last: "failed" }
      else
        val nextEntries =
          if (a.enabled and a.stable)
            trim(withoutKey(s.entries, key).append({ key: key, payload: a.payload }))
          else s.entries
        { ...s, entries: nextEntries, work: a.payload, present: true, reused: false,
          setupRuns: s.setupRuns + 1, last: "miss" }

  pure def mutate(s: State, a: MutateA): State =
    if (not(s.present)) err(s, "no_output")
    else { ...s, work: a.payload, last: "ok" }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Run(a) => transition(s, a)
    | Mutate(a) => mutate(s, a)
  }

  pure def observe(s: State): Obs = {
    entryCount: length(s.entries), work: s.work, present: s.present,
    reused: s.reused, setupRuns: s.setupRuns, last: s.last,
  }

  pure def safe(s: State): bool = and {
    length(s.entries) <= 3,
    s.entries.indices().forall(i => s.entries.indices().forall(j => i == j or not(sameKey(s.entries[i].key, s.entries[j].key)))),
    s.reused implies s.present,
    s.last == "hit" implies s.reused,
    s.last == "failed" implies (not(s.reused) and not(s.present)),
    s.setupRuns >= 0,
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure def runEvent(base: str, varName: str, tracked: bool, input: str, cacheOn: bool, stable: bool, ok: bool, payload: str): Event =
    Run({ base: base, variant: varName, tracked: tracked, input: input,
          enabled: cacheOn, stable: stable, ok: ok, payload: payload })

  action step = any {
    all { fire(runEvent("a", "", false, "", true, true, true, "seed-a")) },
    all { fire(runEvent("b", "env1", false, "", true, true, true, "seed-b")) },
    all { fire(runEvent("a", "", true, "one", true, true, true, "input-one")) },
    all { fire(runEvent("c", "env2", true, "two", true, false, true, "unstable")) },
    all { fire(runEvent("d", "", false, "", true, true, false, "failed")) },
    all { fire(runEvent("a", "", false, "", false, true, true, "uncached")) },
    all { fire(Mutate({ payload: "candidate-edit" })) },
  }

  val invariant = safe(st)
}
