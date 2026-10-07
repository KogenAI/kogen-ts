// Kogen slice: `kogen intent approve <slug> [<hash>] [--by <name>]`.
// Executable neutral spec from PROSE.md. Pure apply(State, Event) -> State and
// observe(State) -> Obs. What Quint cannot compute (SHA-256, git, running checks,
// reading files) arrives as fields of the Approve event. One event = one CLI call.
module approve {
  type Approval = { n: int, sha: str, by: str, commit: str, base: str, feas: str }
  type State = {
    approvals: str -> Approval,   // current approval per slug (n counts approval commits written)
    caches: (str, str) -> str,           // production keeps one baseline result per key
    lastCache: (str, str),               // key whose baseline rows were used by the last call
    checkRuns: int,               // times the configured checks were really run (cache misses)
    last: str,                    // outcome code of the last call
    exit: int,
    sha8: str, approver: str, feas: str,   // card / message fields of the last call ("" when none)
    bwarn: bool, lwarn: bool,     // red-baseline warning / lint style warnings shown
    ran: bool,                    // this call ran the configured checks
    priorApprovals: str -> Approval,
    priorCaches: (str, str) -> str,
    priorCacheRuns: int,
    priorLastCache: (str, str),
  }

  type Event =
    | Init
    | Approve({
        slug: str,
        given: str,        // the <hash> argument; "" = absent
        prefixOk: bool,    // given is a prefix of the real approval hash (adapter computes)
        stableBeforeCas: bool, newSha8: str, // second read before ref CAS; new prefix on change
        sha: str, sha8: str,   // real approval hash (SHA-256 hex) and its first 8 chars
        by: str, byBad: bool,  // --by value ("" absent); byBad = given but blank or multi-line
        ident: str,        // `git var GIT_AUTHOR_IDENT` as "Name <email>"; "" = unavailable
        parseErr: bool, lintErr: bool, lintWarn: bool,
        missing: bool,     // acceptance source file does not exist
        setup: str,        // "ok" | "failed"
        baseTree: str, cacheKey: str,     // context identity (setup, checks, env/toolchain, adapter); tree binds separately
        baseline: str,     // what running the configured checks would give: green|red|unavailable|timeout|mutating
        acceptance: str,   // acceptance check result: green | red | timeout | tool_missing
        witnessMode: bool, feas: str,   // feas: PROVEN | PROVEN with concerns | UNPROVEN | not checked
        commit: str, baseSha: str,      // new approval commit8 and resolved base sha (opaque)
      })

  type Obs = {
    last: str, exit: int, sha8: str, approver: str, feas: str,
    bwarn: bool, lwarn: bool, ran: bool, checkRuns: int, cache: (str, str),
    approvals: str -> Approval,
  }

  pure val INITIAL: State = {
    approvals: Map(), caches: Map(), lastCache: ("", ""), checkRuns: 0, last: "ok", exit: 0,
    sha8: "", approver: "", feas: "", bwarn: false, lwarn: false, ran: false,
    priorApprovals: Map(),
    priorCaches: Map(), priorCacheRuns: 0, priorLastCache: ("", ""),
  }

  pure def exitOf(code: str): int =
    if (code == "ok") 0
    else if (code == "needs_decision") 5
    else if (Set("intent/parse", "intent/lint", "intent/hash_mismatch", "intent/unproven",
                 "check/acceptance_check_failed").contains(code)) 1
    else if (Set("usage", "intent/acceptance_missing",
                 "intent/approval_identity_unavailable", "intent/approval_by_invalid").contains(code)) 2
    else 3   // environment/tool_missing, environment/setup_failed

  // refusal: nothing printed except the error; `ran` says whether checks ran before it
  pure def stop(s: State, code: str, ran: bool): State =
    { ...s, last: code, exit: exitOf(code), ran: ran, sha8: "", approver: "", feas: "",
      bwarn: false, lwarn: false }

  pure def approve(s: State, a: { slug: str, given: str, prefixOk: bool, stableBeforeCas: bool, newSha8: str, sha: str, sha8: str,
        by: str, byBad: bool, ident: str, parseErr: bool, lintErr: bool, lintWarn: bool,
        missing: bool, setup: str, baseTree: str, cacheKey: str, baseline: str, acceptance: str,
        witnessMode: bool, feas: str, commit: str, baseSha: str }): State =
    val hashed = a.given != ""
    val approver = if (a.by != "") a.by else a.ident
    val proven = a.feas == "PROVEN" or a.feas == "PROVEN with concerns"
    if (a.byBad) stop(s, "intent/approval_by_invalid", false)
    // with a hash, the hash is computed first (needs both files), mismatch runs nothing
    else if (hashed and a.missing) stop(s, "intent/acceptance_missing", false)
    else if (hashed and not(a.prefixOk)) { ...stop(s, "intent/hash_mismatch", false), sha8: a.sha8 }
    else if (a.parseErr) stop(s, "intent/parse", false)
    else if (a.lintErr) stop(s, "intent/lint", false)
    else if (a.missing) stop(s, "intent/acceptance_missing", false)
    else if (approver == "") stop(s, "intent/approval_identity_unavailable", false)
    else
      // Context identity is supplied by the I/O adapter; checked tree is bound
      // independently so narrowed setup_inputs cannot reuse a stale baseline.
      val hit = s.caches.keys().contains((a.baseTree, a.cacheKey))
      if (not(hit) and a.setup != "ok") stop(s, "environment/setup_failed", false)
      else
      val bstatus = if (hit) s.caches.get((a.baseTree, a.cacheKey)) else a.baseline
      val ran = not(hit)
      val s1 = { ...s,
                 caches: if (hit) s.caches else s.caches.put((a.baseTree, a.cacheKey), bstatus),
                 lastCache: (a.baseTree, a.cacheKey),
                 checkRuns: s.checkRuns + (if (hit) 0 else 1) }
      if (a.acceptance == "tool_missing") stop(s1, "environment/tool_missing", ran)
      else if (a.acceptance != "green") stop(s1, "check/acceptance_check_failed", ran)
      else if (not(hashed))
        { ...s1, last: "needs_decision", exit: 5, sha8: a.sha8, approver: approver, feas: a.feas,
          bwarn: bstatus == "red", lwarn: a.lintWarn, ran: ran }
      else if (not(a.stableBeforeCas)) { ...stop(s1, "intent/hash_mismatch", ran), sha8: a.newSha8 }
      else if (a.witnessMode and not(proven)) stop(s1, "intent/unproven", ran)
      else
        val prev = if (s1.approvals.keys().contains(a.slug)) s1.approvals.get(a.slug).n else 0
        { ...s1, last: "ok", exit: 0, sha8: a.sha8, approver: approver, feas: a.feas,
          bwarn: bstatus == "red", lwarn: a.lintWarn, ran: ran,
          approvals: s1.approvals.put(a.slug, { n: prev + 1, sha: a.sha, by: approver,
                       commit: a.commit, base: a.baseSha, feas: a.feas }) }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Approve(a) => approve(s, a)
  }

  pure def observe(s: State): Obs = {
    last: s.last, exit: s.exit, sha8: s.sha8, approver: s.approver, feas: s.feas,
    bwarn: s.bwarn, lwarn: s.lwarn, ran: s.ran, checkRuns: s.checkRuns, cache: s.lastCache,
    approvals: s.approvals,
  }

  pure def safeApprovalUpdate(s: State, a: {
    slug: str, given: str, prefixOk: bool, stableBeforeCas: bool, newSha8: str, sha: str, sha8: str,
    by: str, byBad: bool, ident: str, parseErr: bool, lintErr: bool, lintWarn: bool,
    missing: bool, setup: str, baseTree: str, cacheKey: str, baseline: str, acceptance: str,
    witnessMode: bool, feas: str, commit: str, baseSha: str
  }): bool =
    if (s.last != "ok" or a.given == "") s.approvals == s.priorApprovals
    else
      s.approvals.keys().contains(a.slug) and
      s.approvals.get(a.slug).n == (if (s.priorApprovals.keys().contains(a.slug)) s.priorApprovals.get(a.slug).n else 0) + 1 and
      s.approvals.get(a.slug).sha == a.sha and
      s.approvals.get(a.slug).commit == a.commit and
      s.approvals.get(a.slug).base == a.baseSha and
      s.approvals.keys().filter(k => k != a.slug).mapBy(k => s.approvals.get(k)) ==
      s.priorApprovals.keys().filter(k => k != a.slug).mapBy(k => s.priorApprovals.get(k))

  pure def safeCacheUpdate(s: State, a: {
    slug: str, given: str, prefixOk: bool, stableBeforeCas: bool, newSha8: str, sha: str, sha8: str,
    by: str, byBad: bool, ident: str, parseErr: bool, lintErr: bool, lintWarn: bool,
    missing: bool, setup: str, baseTree: str, cacheKey: str, baseline: str, acceptance: str,
    witnessMode: bool, feas: str, commit: str, baseSha: str
  }): bool = and {
    s.checkRuns == s.caches.keys().size(),
    if (a.byBad or (a.given != "" and a.missing) or
        (a.given != "" and not(a.prefixOk)) or a.parseErr or a.lintErr or a.missing or
        (a.by == "" and a.ident == ""))
      s.caches == s.priorCaches and s.checkRuns == s.priorCacheRuns and s.lastCache == s.priorLastCache
    else if (s.priorCaches.keys().contains((a.baseTree, a.cacheKey)))
      s.caches == s.priorCaches and s.checkRuns == s.priorCacheRuns and s.lastCache == (a.baseTree, a.cacheKey)
    else if (a.setup == "ok")
      s.caches == s.priorCaches.put((a.baseTree, a.cacheKey), s.caches.get((a.baseTree, a.cacheKey))) and
         s.checkRuns == s.priorCacheRuns + 1 and s.lastCache == (a.baseTree, a.cacheKey)
    else s.caches == s.priorCaches and s.checkRuns == s.priorCacheRuns and s.lastCache == s.priorLastCache,
  }

  // ---------- state machine ----------
  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = { ...n, priorApprovals: st.approvals, priorCaches: st.caches,
                  priorCacheRuns: st.checkRuns, priorLastCache: st.lastCache }, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  // Simulation draws each field from a small universe; `any` also keeps a "mostly valid" branch.
  action step = {
    nondet slug = Set("alpha", "bravo").oneOf()
    nondet given = Set("", "", "abcd1234", "ffff0000").oneOf()
    nondet by = Set("", "", "ci-bot").oneOf()
    nondet ident = Set("", "A <a@x>").oneOf()
    nondet baseTree = Set("tree-a", "tree-b").oneOf()
    nondet cacheKey = Set("k1", "k2").oneOf()
    nondet baseline = Set("green", "red", "unavailable").oneOf()
    nondet acceptance = Set("green", "green", "green", "red", "timeout", "tool_missing").oneOf()
    nondet feas = Set("PROVEN", "PROVEN with concerns", "UNPROVEN", "not checked").oneOf()
    nondet flags = Set(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15).oneOf()
    nondet commit = Set("c1", "c2", "c3").oneOf()
    val rare = flags == 15
    fire(Approve({
      slug: slug, given: given, prefixOk: given == "abcd1234", sha: "abcd1234ee", sha8: "abcd1234",
      by: by, byBad: rare and by == "", ident: ident, stableBeforeCas: flags != 10,
      newSha8: "bbbb2222",
      parseErr: flags == 14, lintErr: flags == 13, lintWarn: flags % 2 == 1,
      missing: flags == 12, setup: if (flags == 11) "failed" else "ok",
      baseTree: baseTree, cacheKey: cacheKey, baseline: baseline, acceptance: acceptance,
      witnessMode: flags >= 8 and flags <= 10,
      feas: if (flags >= 8 and flags <= 10) feas else "not checked",
      commit: commit, baseSha: "b0",
    }))
  }

  // ---------- safety properties ----------
  pure def safe(s: State, e: Event): bool = and {
    s.exit == exitOf(s.last),
    s.approvals.keys().forall(k => s.approvals.get(k).n >= 1 and s.approvals.get(k).commit != ""),
    s.ran implies s.checkRuns >= 1,
    s.last == "intent/parse" implies not(s.ran),
    s.last == "needs_decision" implies (s.sha8 != "" and s.approver != ""),
    // a card needs no hash; an approval needs one
    match e {
      | Init => true
      | Approve(a) =>
        and {
          safeApprovalUpdate(s, a),
          safeCacheUpdate(s, a),
          s.last == "needs_decision" implies a.given == "",
          (s.last == "intent/hash_mismatch" and not(a.prefixOk)) implies not(s.ran),
          s.last == "ok" implies (a.given != "" and a.prefixOk and a.stableBeforeCas and a.acceptance == "green"
                                  and not(a.parseErr) and not(a.lintErr)),
          s.last == "ok" implies (a.witnessMode implies (a.feas == "PROVEN" or a.feas == "PROVEN with concerns")),
        }
    },
  }
  run baseTreeCacheTest = {
    val a = { slug: "alpha", given: "", prefixOk: true, stableBeforeCas: true,
      newSha8: "", sha: "hash", sha8: "hash", by: "owner", byBad: false, ident: "",
      parseErr: false, lintErr: false, lintWarn: false, missing: false, setup: "ok",
      baseTree: "tree-a", cacheKey: "same-setup-check-env", baseline: "red", acceptance: "green",
      witnessMode: false, feas: "not checked", commit: "c", baseSha: "b0" }
    val first = approve(INITIAL, a)
    val second = approve(first, { ...a, baseTree: "tree-b", baseline: "green" })
    val third = approve(second, { ...a, baseTree: "tree-b", baseline: "red" })
    init.expect(and { first.bwarn, second.ran, not(second.bwarn), second.checkRuns == 2,
      not(third.ran), not(third.bwarn), third.checkRuns == 2 })
  }

  val invariant = safe(st, ev)
}
