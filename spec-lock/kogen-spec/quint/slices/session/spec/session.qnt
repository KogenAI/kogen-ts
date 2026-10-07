// Conversation cache key. Sources: spec §4.9.1 and §4.9.2 (v1.3-draft).
// Thread identity depends on run, stage, attempt, rung, and epoch.
// Cache affinity may use run scope or an evidenced shared adapter scope.
// Static prefix identity is stable within each provider/model/adapter/prompt namespace.
// The v2/v1 labels below are model markers, not mandated digest bytes.
// Attempt defaults to builder. Rung defaults to the attempt. Epoch defaults to initial.
// Turns, retries, and same-session repairs keep that material. The model is not part of it.
// previous_response_id is never sent. A checkpoint epoch exists only for the continuation
// prefix. Lite's session_id is the v1 material, not this key. The observation is the
// material; the adapter checks that the real hash changes exactly when the material does.
module session {
  type BindA = { stage: str, attempt: str, rung: str }
  type NameA = { name: str }
  type OkA = { ok: bool }
  type State = {
    version: str,
    stage: str,
    attempt: str,
    rung: str,
    epoch: str,
    epochClass: str,
    model: str,
    runName: str,
    priorRunName: str,
    sharedAffinity: bool, prefixes: (str, str, str, str) -> str,
    affinityChanged: bool,
    previous: bool,
    keyChanged: bool,
    lite: str,
    last: str,
  }
  type Event =
    | Init
    | Bind(BindA)
    | Turn
    | Repair
    | Model(NameA)
    | Stage(NameA)
    | Attempt(NameA)
    | Rung(NameA)
    | Epoch(NameA)
    | Accept(OkA)
    | Previous
    | Lite
    | NewRun(NameA)
    | AffinityScope({ shared: bool })
    | Prefix({ provider: str, model: str, adapter: str, prompt: str, bytes: str })
  type Obs = {
    version: str, stage: str, attempt: str, rung: str, epoch: str, epochClass: str,
    model: str, runName: str, affinityChanged: bool, previous: bool, keyChanged: bool,
    lite: str, last: str, sharedAffinity: bool, prefixes: (str, str, str, str) -> str,
  }

  pure val INITIAL: State = {
    version: "", stage: "", attempt: "", rung: "", epoch: "", epochClass: "", model: "",
    sharedAffinity: false, prefixes: Map(),
    previous: false, keyChanged: false, lite: "", last: "ok", runName: "run-1", priorRunName: "run-1", affinityChanged: false,
  }

  pure def err(s: State, code: str): State = { ...s, last: code }
  pure def bound(s: State): bool = s.version == "v2"
  pure def knownStage(n: str): bool = n == "develop" or n == "plan"
  pure def knownAttempt(n: str): bool =
    n == "" or n == "builder" or n == "fresh-1" or n == "fresh-2" or n == "escalation"
  pure def knownRung(n: str): bool =
    n == "" or n == "builder" or n == "1" or n == "2" or n == "fresh-1"
  pure def realAttempt(n: str): bool =
    n == "builder" or n == "fresh-1" or n == "fresh-2" or n == "escalation"

  pure def bind(s: State, a: BindA): State =
    if (not(knownStage(a.stage)) or not(knownAttempt(a.attempt)) or not(knownRung(a.rung))) err(s, "bad_bind")
    else
      val attempt = if (a.attempt == "") "builder" else a.attempt
      val rung = if (a.rung == "") attempt else a.rung
      val same = s.stage == a.stage and s.attempt == attempt and s.rung == rung and s.epoch == "initial"
      {
        ...s, version: "v2", stage: a.stage, attempt: attempt, rung: rung, epoch: "initial",
        epochClass: "initial", keyChanged: bound(s) and not(same), affinityChanged: false, last: "ok",
      }

  pure def touch(s: State): State =
    if (not(bound(s))) err(s, "not_bound") else { ...s, keyChanged: false, affinityChanged: false, last: "ok" }

  pure def chooseModel(s: State, a: NameA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (a.name != "luna" and a.name != "sol") err(s, "bad_model")
    else { ...s, model: a.name, keyChanged: false, affinityChanged: false, last: "ok" }

  pure def setStage(s: State, a: NameA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (not(knownStage(a.name))) err(s, "bad_bind")
    else { ...s, stage: a.name, keyChanged: s.stage != a.name, affinityChanged: false, last: "ok" }

  pure def setAttempt(s: State, a: NameA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (not(realAttempt(a.name))) err(s, "bad_bind")
    else { ...s, attempt: a.name, keyChanged: s.attempt != a.name, affinityChanged: false, last: "ok" }

  pure def setRung(s: State, a: NameA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (a.name != "1" and a.name != "2" and a.name != "builder" and a.name != "fresh-1") err(s, "bad_bind")
    else { ...s, rung: a.name, keyChanged: s.rung != a.name, affinityChanged: false, last: "ok" }

  pure def setEpoch(s: State, a: NameA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (a.name == "mutation-advice") {
      ...s, epoch: "mutation-advice", epochClass: "mutation-advice",
      keyChanged: s.epoch != "mutation-advice", affinityChanged: false, last: "ok",
    } else if (a.name == "summarizer") {
      ...s, epoch: "checkpoint-1", epochClass: "checkpoint",
      keyChanged: s.epoch != "checkpoint-1", affinityChanged: false, last: "ok",
    } else err(s, "bad_epoch")

  // The digest stands for the hash of the checkpoint item. Only the prefix qualifies.
  pure def accept(s: State, a: OkA): State =
    if (not(bound(s))) err(s, "not_bound")
    else if (not(a.ok)) err(s, "no_epoch")
    else {
      ...s, epoch: "digest", epochClass: "checkpoint", keyChanged: s.epoch != "digest", affinityChanged: false, last: "ok",
    }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Bind(a) => bind(s, a)
    | Turn => touch(s)
    | Repair => touch(s)
    | Model(a) => chooseModel(s, a)
    | Stage(a) => setStage(s, a)
    | Attempt(a) => setAttempt(s, a)
    | Rung(a) => setRung(s, a)
    | Epoch(a) => setEpoch(s, a)
    | Accept(a) => accept(s, a)
    | Previous => err(s, "never_sent")
    | Lite =>
      if (not(bound(s))) err(s, "not_bound")
      else { ...s, lite: "v1", keyChanged: false, affinityChanged: false, last: "ok" }
    | NewRun(a) =>
      if (a.name == "" or a.name == s.runName) err(s, "bad_run")
      else { ...INITIAL, runName: a.name, affinityChanged: not(s.sharedAffinity),
        sharedAffinity: s.sharedAffinity, prefixes: s.prefixes, keyChanged: false, last: "ok" }
    | AffinityScope(a) =>
      if (bound(s)) err(s, "already_bound")
      else { ...s, sharedAffinity: a.shared, affinityChanged: false, last: "ok" }
    | Prefix(a) =>
      val ns = (a.provider, a.model, a.adapter, a.prompt)
      if (a.bytes == "" or a.provider == "" or a.model == "" or a.adapter == "" or a.prompt == "") err(s, "bad_prefix")
      else if (s.prefixes.keys().contains(ns) and s.prefixes.get(ns) != a.bytes) err(s, "static_prefix_changed")
      else { ...s, prefixes: s.prefixes.put(ns, a.bytes), last: "ok" }
  }

  pure def observe(s: State): Obs = {
    version: s.version, stage: s.stage, attempt: s.attempt, rung: s.rung, epoch: s.epoch,
    epochClass: s.epochClass, model: s.model, runName: s.runName,
    affinityChanged: s.affinityChanged, previous: s.previous, keyChanged: s.keyChanged,
    lite: s.lite, last: s.last, sharedAffinity: s.sharedAffinity, prefixes: s.prefixes,
  }

  pure def safe(s: State, e: Event): bool = and {
    s.previous == false,
    s.version == "" or s.version == "v2",
    s.lite == "" or s.lite == "v1",
    s.version == "v2" implies (
      s.stage != "" and s.attempt != "" and s.rung != "" and s.epoch != "" and s.epochClass != ""
    ),
    s.version == "" implies (s.stage == "" and s.attempt == "" and s.rung == "" and not(s.keyChanged)),
    s.epoch == "initial" implies s.epochClass == "initial",
    s.epoch == "mutation-advice" implies s.epochClass == "mutation-advice",
    (s.epoch == "checkpoint-1" or s.epoch == "digest") implies s.epochClass == "checkpoint",
    s.epochClass == "" or s.epochClass == "initial" or s.epochClass == "mutation-advice" or s.epochClass == "checkpoint",
    s.model == "" or s.model == "luna" or s.model == "sol",
    s.keyChanged implies s.version == "v2",
    s.runName != "",
    match e {
      | NewRun(_) => s.last != "ok" or
          (s.affinityChanged == not(s.sharedAffinity) and s.version == "" and s.runName != s.priorRunName)
      | _ => true
    },
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = { ...n, priorRunName: st.runName }, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  action step = any {
    all { st.version == "", fire(Bind({ stage: "develop", attempt: "", rung: "" })) },
    all { st.version == "", fire(Bind({ stage: "plan", attempt: "fresh-1", rung: "" })) },
    all { st.version == "v2", fire(Turn) },
    all { st.version == "v2", fire(Repair) },
    all { st.version == "v2", fire(Repair) },
    all { st.version == "v2", fire(Model({ name: "sol" })) },
    all { st.version == "v2", fire(Model({ name: "luna" })) },
    all { st.version == "v2", fire(Rung({ name: "2" })) },
    all { st.version == "v2", fire(Attempt({ name: "fresh-1" })) },
    all { st.version == "v2", fire(Attempt({ name: "escalation" })) },
    all { st.version == "v2", fire(Stage({ name: "plan" })) },
    all { st.version == "v2", fire(Stage({ name: "develop" })) },
    all { st.version == "v2", fire(Epoch({ name: "mutation-advice" })) },
    all { st.version == "v2", fire(Epoch({ name: "summarizer" })) },
    all { st.version == "v2", fire(Accept({ ok: true })) },
    all { st.version == "v2", fire(Accept({ ok: true })) },
    all { st.version == "v2", fire(Accept({ ok: false })) },
    fire(AffinityScope({ shared: true })),
    fire(Prefix({ provider: "chatgpt", model: "sol", adapter: "a1", prompt: "p1", bytes: "static" })),
    fire(Prefix({ provider: "chatgpt", model: "sol", adapter: "a1", prompt: "p1", bytes: "run-specific" })),
    fire(Previous),
    fire(Lite),
    all { st.runName == "run-1", fire(NewRun({ name: "run-2" })) },
    all { st.runName != "run-1", fire(NewRun({ name: "run-1" })) },
    fire(Turn),
    fire(Init),
  }

  run crossSessionPrefixTest = {
    val p = Prefix({ provider: "chatgpt", model: "sol", adapter: "a1", prompt: "p1", bytes: "static" })
    val first = apply(apply(INITIAL, AffinityScope({ shared: true })), p)
    val second = apply(first, NewRun({ name: "run-2" }))
    val same = apply(second, p)
    val bad = apply(same, Prefix({ provider: "chatgpt", model: "sol", adapter: "a1", prompt: "p1", bytes: "timestamp" }))
    init.expect(and { second.runName != first.runName, not(second.affinityChanged),
      same.last == "ok", bad.last == "static_prefix_changed", bad.prefixes == same.prefixes })
  }

  val invariant = safe(st, ev)
}
