// Provider profiles, account choices, and one-label resolution per run.
// Sources: spec §1.7.6, §2.7, §4.6, §4.10 (v1.2, read 2026-10-06).
// Network OAuth and filesystem effects are event inputs; no secrets enter the model.
// LABELS is a finite MBT corpus spanning boundary forms, not the full 64-byte regex language.
// Corrupt models replacing accounts.yaml with an invalid file, so choices become unreadable/default.
module accounts {
  pure val PROVIDERS: List[str] = ["chatgpt", "grok"]
  pure val LABELS: List[str] = ["A1", "a", "default", "team-x", "team.dev", "work", "x_y"]

  type Profile = {
    provider: str, label: str, present: bool, saved: bool, signedIn: bool,
    email: str, expires: int, hasExpiry: bool, notice: bool, remoteRevoked: bool,
  }
  type AccountRow = {
    provider: str, label: str, isDefault: bool, signedIn: bool, email: str, expires: int,
  }
  type State = {
    profiles: List[Profile],
    chatDefault: str, grokDefault: str, selectedDefault: str,
    chatAlpha: str, chatBravo: str, grokAlpha: str, grokBravo: str,
    providerAlpha: str, providerBravo: str, committedAlpha: str, committedBravo: str,
    alphaExists: bool, bravoExists: bool, broken: bool,
    envProvider: str, envAccount: str,
    resolvedProvider: str, resolvedLabel: str, resolvedSaved: bool,
    last: str, exit: int, operation: str,
  }
  type Event =
    | Init
    | Seed(Profile)
    | Login({ provider: str, success: bool, email: str, expires: int, hasExpiry: bool, notice: bool })
    | Logout({ provider: str, remote: bool })
    | Use({ provider: str, label: str, project: str, projectExists: bool })
    | Project({ name: str, exists: bool, provider: str, account: str })
    | ProviderDefault({ provider: str, label: str })
    | SelectionDefault({ provider: str })
    | Environment({ provider: str, account: str })
    | Corrupt({ broken: bool })
    | Resolve({ project: str })
    | ListAccounts
  type Obs = {
    last: str, exit: int, operation: str,
    rows: List[AccountRow],
    chatDefault: str, grokDefault: str, selectedDefault: str,
    chatAlpha: str, chatBravo: str, grokAlpha: str, grokBravo: str,
    providerAlpha: str, providerBravo: str,
    resolvedProvider: str, resolvedLabel: str, resolvedSaved: bool,
    broken: bool,
  }

  pure val EMPTY_PROFILE: Profile = {
    provider: "", label: "", present: false, saved: false, signedIn: false,
    email: "", expires: 0, hasExpiry: false, notice: false, remoteRevoked: false,
  }
  pure val EMPTY_ROW: AccountRow = {
    provider: "", label: "", isDefault: false, signedIn: false, email: "", expires: 0,
  }
  pure val INITIAL: State = {
    profiles: [],
    chatDefault: "", grokDefault: "", selectedDefault: "chatgpt",
    chatAlpha: "", chatBravo: "", grokAlpha: "", grokBravo: "",
    providerAlpha: "", providerBravo: "", committedAlpha: "", committedBravo: "",
    alphaExists: false, bravoExists: false, broken: false,
    envProvider: "", envAccount: "", resolvedProvider: "", resolvedLabel: "", resolvedSaved: false,
    last: "ok", exit: 0, operation: "none",
  }

  pure def knownProvider(p: str): bool = p == "chatgpt" or p == "grok"
  pure def validLabel(label: str): bool = Set("A1", "a", "default", "team-x", "team.dev", "work", "x_y").contains(label)
  pure def projectKnown(project: str): bool = project == "alpha" or project == "bravo"
  pure def projectExists(s: State, project: str): bool =
    if (project == "alpha") s.alphaExists else if (project == "bravo") s.bravoExists else false

  pure def providerRank(p: str): int = if (p == "chatgpt") 0 else if (p == "grok") 1 else 2
  pure def labelRank(label: str): int = LABELS.indices().fold(-1, (found, i) => if (LABELS[i] == label) i else found)

  pure def profile(s: State, provider: str, label: str): Profile =
    s.profiles.foldl(EMPTY_PROFILE, (found, p) => if (p.provider == provider and p.label == label) p else found)
  pure def hasProfile(s: State, provider: str, label: str): bool = profile(s, provider, label).present
  pure def hasSaved(s: State, provider: str, label: str): bool = profile(s, provider, label).saved

  pure def upsert(xs: List[Profile], profileItem: Profile): List[Profile] =
    xs.foldl([], (acc, p) =>
      if (p.provider == profileItem.provider and p.label == profileItem.label) acc else acc.append(p)
    ).append(profileItem)

  pure def accountDefault(s: State, provider: str): str =
    if (provider == "chatgpt") if (s.chatDefault == "") "default" else s.chatDefault
    else if (s.grokDefault == "") "default" else s.grokDefault

  pure def accountForProject(s: State, provider: str, project: str): str =
    if (project == "alpha") if (provider == "chatgpt") s.chatAlpha else s.grokAlpha
    else if (project == "bravo") if (provider == "chatgpt") s.chatBravo else s.grokBravo
    else ""

  pure def providerForProject(s: State, project: str): str =
    if (project == "alpha") s.providerAlpha else if (project == "bravo") s.providerBravo else ""

  pure def committedForProject(s: State, project: str): str =
    if (project == "alpha") s.committedAlpha else if (project == "bravo") s.committedBravo else ""

  pure def listRow(s: State, provider: str, label: str): AccountRow =
    val p = profile(s, provider, label)
    {
      provider: provider, label: label,
      isDefault: s.selectedDefault == provider and accountDefault(s, provider) == label,
      signedIn: p.signedIn, email: p.email, expires: if (p.hasExpiry) p.expires else 0,
    }

  pure def rowsForProvider(s: State, provider: str): List[AccountRow] =
    LABELS.foldl([], (acc, label) => if (hasProfile(s, provider, label)) acc.append(listRow(s, provider, label)) else acc)

  pure def listRows(s: State): List[AccountRow] =
    val rows = PROVIDERS.foldl([], (acc, provider) => concat(acc, rowsForProvider(s, provider)))
    if (length(rows) == 0)
      [
        { provider: "chatgpt", label: "", isDefault: false, signedIn: false, email: "", expires: 0 },
        { provider: "grok", label: "", isDefault: false, signedIn: false, email: "", expires: 0 },
      ]
    else rows

  pure def use(s: State, e: { provider: str, label: str, project: str, projectExists: bool }): State =
    if (not(knownProvider(e.provider))) { ...s, last: "unknown_provider", exit: 2, operation: "use" }
    else if (not(validLabel(e.label))) { ...s, last: "invalid_label", exit: 2, operation: "use" }
    else if (e.project != "" and not(projectKnown(e.project))) { ...s, last: "unknown_project", exit: 2, operation: "use" }
    else if (not(hasSaved(s, e.provider, e.label))) { ...s, last: "no_saved_login", exit: 4, operation: "use" }
    else if (s.broken) { ...s, last: "invalid_accounts_file", exit: 3, operation: "use" }
    else if (e.project != "" and not(e.projectExists)) { ...s, last: "project_unavailable", exit: 3, operation: "use" }
    else if (e.project == "")
      if (e.provider == "chatgpt") { ...s, chatDefault: e.label, last: "ok", exit: 0, operation: "use_default" }
      else { ...s, grokDefault: e.label, last: "ok", exit: 0, operation: "use_default" }
    else if (e.project == "alpha")
      if (e.provider == "chatgpt") { ...s, chatAlpha: e.label, last: "ok", exit: 0, operation: "use_project" }
      else { ...s, grokAlpha: e.label, last: "ok", exit: 0, operation: "use_project" }
    else if (e.provider == "chatgpt") { ...s, chatBravo: e.label, last: "ok", exit: 0, operation: "use_project" }
    else { ...s, grokBravo: e.label, last: "ok", exit: 0, operation: "use_project" }

  pure def resolve(s: State, project: str): State =
    if (project != "" and not(projectKnown(project))) { ...s, last: "unknown_project", exit: 2, operation: "resolve" }
    else if (project != "" and not(projectExists(s, project))) { ...s, last: "project_unavailable", exit: 3, operation: "resolve" }
    else if (s.envProvider != "" and not(knownProvider(s.envProvider))) { ...s, last: "invalid_provider_environment", exit: 3, operation: "resolve" }
    else if (s.broken) { ...s, last: "invalid_accounts_file", exit: 3, operation: "resolve" }
    else
      val projectProvider = providerForProject(s, project)
      val provider = if (s.envProvider != "") s.envProvider
                     else if (projectProvider != "") projectProvider
                     else if (knownProvider(s.selectedDefault)) s.selectedDefault else "chatgpt"
      val account =
        if (s.envAccount != "") s.envAccount
        else if (accountForProject(s, provider, project) != "") accountForProject(s, provider, project)
        else if (provider == "chatgpt" and committedForProject(s, project) != "") committedForProject(s, project)
        else accountDefault(s, provider)
      { ...s, resolvedProvider: provider, resolvedLabel: account,
        resolvedSaved: hasSaved(s, provider, account), last: "ok", exit: 0, operation: "resolve" }

  pure def login(s: State, e: { provider: str, success: bool, email: str, expires: int, hasExpiry: bool, notice: bool }): State =
    if (not(knownProvider(e.provider))) { ...s, last: "unknown_provider", exit: 2, operation: "login" }
    else if (not(e.success)) { ...s, last: "login_failed", exit: 4, operation: "login" }
    else
      val p = {
        provider: e.provider, label: "default", present: true, saved: true, signedIn: true,
        email: e.email, expires: e.expires, hasExpiry: e.hasExpiry, notice: e.notice, remoteRevoked: false,
      }
      { ...s, profiles: upsert(s.profiles, p), last: "ok", exit: 0, operation: if (e.notice) "login_notice" else "login" }

  pure def logout(s: State, provider: str, remote: bool): State =
    if (not(knownProvider(provider))) { ...s, last: "unknown_provider", exit: 2, operation: "logout" }
    else
      val old = profile(s, provider, "default")
      val p = {
        ...old, provider: provider, label: "default", present: true, saved: false,
        signedIn: false, remoteRevoked: provider == "chatgpt" and remote,
      }
      { ...s, profiles: upsert(s.profiles, p), last: "ok", exit: 0,
        operation: if (provider == "chatgpt" and remote) "logout_remote" else "logout_local" }

  pure def apply(s: State, e: Event): State = match e {
    | Init => INITIAL
    | Seed(p) => if (knownProvider(p.provider) and validLabel(p.label))
        { ...s, profiles: upsert(s.profiles, p), last: "ok", exit: 0, operation: "seed" }
      else { ...s, last: "bad_profile", exit: 2, operation: "seed" }
    | Login(a) => login(s, a)
    | Logout(a) => logout(s, a.provider, a.remote)
    | Use(a) => use(s, a)
    | Project(a) => if (a.name == "alpha")
        { ...s, alphaExists: a.exists, providerAlpha: a.provider, committedAlpha: a.account, last: "ok", exit: 0, operation: "project" }
      else if (a.name == "bravo")
        { ...s, bravoExists: a.exists, providerBravo: a.provider, committedBravo: a.account, last: "ok", exit: 0, operation: "project" }
      else { ...s, last: "unknown_project", exit: 2, operation: "project" }
    | ProviderDefault(a) => if (not(knownProvider(a.provider)) or (a.label != "" and not(validLabel(a.label))))
        { ...s, last: "bad_choice", exit: 2, operation: "choice" }
      else if (a.provider == "chatgpt") { ...s, chatDefault: a.label, last: "ok", exit: 0, operation: "choice" }
      else { ...s, grokDefault: a.label, last: "ok", exit: 0, operation: "choice" }
    | SelectionDefault(a) => if (not(knownProvider(a.provider)))
        { ...s, last: "bad_choice", exit: 2, operation: "selection" }
      else { ...s, selectedDefault: a.provider, last: "ok", exit: 0, operation: "selection" }
    | Environment(a) => { ...s, envProvider: a.provider, envAccount: a.account, last: "ok", exit: 0, operation: "environment" }
    | Corrupt(a) => if (a.broken)
        { ...s, chatDefault: "", grokDefault: "", selectedDefault: "chatgpt",
          chatAlpha: "", chatBravo: "", grokAlpha: "", grokBravo: "",
          providerAlpha: "", providerBravo: "", broken: true, last: "ok", exit: 0, operation: "accounts_file" }
      else
        { ...s, chatDefault: "", grokDefault: "", selectedDefault: "chatgpt",
          chatAlpha: "", chatBravo: "", grokAlpha: "", grokBravo: "",
          providerAlpha: "", providerBravo: "", broken: false, last: "ok", exit: 0, operation: "accounts_file" }
    | Resolve(a) => resolve(s, a.project)
    | ListAccounts => { ...s, last: "ok", exit: 0, operation: "list" }
  }

  pure def observe(s: State): Obs = {
    last: s.last, exit: s.exit, operation: s.operation, rows: listRows(s),
    chatDefault: if (s.chatDefault == "") "default" else s.chatDefault,
    grokDefault: if (s.grokDefault == "") "default" else s.grokDefault,
    selectedDefault: s.selectedDefault,
    chatAlpha: s.chatAlpha, chatBravo: s.chatBravo, grokAlpha: s.grokAlpha, grokBravo: s.grokBravo,
    providerAlpha: s.providerAlpha, providerBravo: s.providerBravo,
    resolvedProvider: s.resolvedProvider, resolvedLabel: s.resolvedLabel,
    resolvedSaved: s.resolvedSaved, broken: s.broken,
  }

  pure def rowBefore(a: AccountRow, b: AccountRow): bool =
    if (providerRank(a.provider) != providerRank(b.provider)) providerRank(a.provider) < providerRank(b.provider)
    else labelRank(a.label) < labelRank(b.label)

  pure def rowsOrdered(xs: List[AccountRow]): bool =
    xs.indices().fold({ ok: true, prev: -1 }, (a, i) =>
      if (i == 0) { ok: a.ok, prev: i }
      else { ok: a.ok and rowBefore(xs[i - 1], xs[i]), prev: i }).ok

  pure def uniqueProfiles(xs: List[Profile]): bool =
    xs.indices().forall(i => xs.indices().forall(j =>
      i == j or xs[i].provider != xs[j].provider or xs[i].label != xs[j].label))

  pure def safe(s: State): bool = and {
    s.exit == 0 or s.exit == 2 or s.exit == 3 or s.exit == 4,
    uniqueProfiles(s.profiles),
    rowsOrdered(observe(s).rows),
    s.selectedDefault == "chatgpt" or s.selectedDefault == "grok",
    s.chatDefault == "" or validLabel(s.chatDefault),
    s.grokDefault == "" or validLabel(s.grokDefault),
    s.chatAlpha == "" or validLabel(s.chatAlpha),
    s.chatBravo == "" or validLabel(s.chatBravo),
    s.grokAlpha == "" or validLabel(s.grokAlpha),
    s.grokBravo == "" or validLabel(s.grokBravo),
    s.providerAlpha == "" or knownProvider(s.providerAlpha),
    s.providerBravo == "" or knownProvider(s.providerBravo),
    s.last == "ok" implies s.exit == 0,
    s.resolvedLabel == "" or validLabel(s.resolvedLabel),
    s.last == "ok" and s.operation == "resolve" implies s.resolvedProvider != "" and s.resolvedLabel != "",
    s.envAccount != "" and s.last == "ok" and s.operation == "resolve" implies s.resolvedLabel == s.envAccount,
  }

  var st: State
  var ev: Event
  var obs: Obs

  action fire(e: Event): bool = {
    val n = apply(st, e)
    all { st' = n, ev' = e, obs' = observe(n) }
  }
  action init = all { st' = INITIAL, ev' = Init, obs' = observe(INITIAL) }

  pure val INITIAL_PROFILE: Profile = {
    provider: "chatgpt", label: "default", present: true, saved: true, signedIn: true,
    email: "", expires: 0, hasExpiry: false, notice: false, remoteRevoked: false,
  }
  action step = any {
    fire(ListAccounts),
    fire(Login({ provider: "chatgpt", success: true, email: "c@example.test", expires: 200, hasExpiry: true, notice: true })),
    fire(Login({ provider: "grok", success: true, email: "g@example.test", expires: 300, hasExpiry: true, notice: false })),
    fire(Login({ provider: "chatgpt", success: false, email: "", expires: 0, hasExpiry: false, notice: false })),
    fire(Logout({ provider: "chatgpt", remote: false })),
    fire(Logout({ provider: "grok", remote: true })),
    fire(Seed({ ...INITIAL_PROFILE, label: "work", email: "work@example.test", notice: true })),
    fire(Seed({ ...INITIAL_PROFILE, provider: "grok", label: "a", signedIn: false, saved: false })),
    fire(Use({ provider: "chatgpt", label: "default", project: "", projectExists: true })),
    fire(Use({ provider: "grok", label: "work", project: "alpha", projectExists: true })),
    fire(Use({ provider: "chatgpt", label: "bad label", project: "", projectExists: true })),
    fire(Project({ name: "alpha", exists: true, provider: "chatgpt", account: "work" })),
    fire(Project({ name: "bravo", exists: false, provider: "", account: "" })),
    fire(ProviderDefault({ provider: "grok", label: "a" })),
    fire(SelectionDefault({ provider: "grok" })),
    fire(Environment({ provider: "", account: "work" })),
    fire(Corrupt({ broken: true })),
    fire(Resolve({ project: "alpha" })),
    fire(Resolve({ project: "" })),
  }

  val invariant = safe(st)
}
