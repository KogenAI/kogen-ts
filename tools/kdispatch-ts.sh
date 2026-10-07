#!/bin/bash
# macOS Bash 3.2 compatible. No worker starts in DRY_RUN mode.
set -euo pipefail
R=${KTS_REPO:-$HOME/Areas/Kogen/kogen-ts}
W=${KTS_WORKTREES:-$HOME/Areas/Kogen/kogen-ts-wt}
D=${KTS_STATE:-$HOME/cx/kts}
RUNNER=${KTS_RUNNER:-$HOME/cx/run.sh}
RUNNER_LOGS=${KTS_RUNNER_LOGS:-$HOME/cx/logs}
MISE=${KTS_MISE:-$HOME/.local/bin/mise}
MAX=${MAX:-4}
MAX_FIXES=${MAX_FIXES:-1}
POLL=${KTS_POLL:-10}
case "$MAX" in ''|*[!0-9]*) echo 'MAX must be a positive integer' >&2; exit 2;; esac
[ "$MAX" -gt 0 ] || exit 2
case "$MAX_FIXES" in ''|*[!0-9]*) exit 2;; esac
[ -f "$R/docs/work/QUEUE.txt" ] || { echo 'Missing queue' >&2; exit 2; }
ROWS=(); PACKAGES=(); DEPS=(); GATES=()
while IFS= read -r row || [ -n "$row" ]; do
  case "$row" in ''|'#'*) continue;; esac
  if [[ ! "$row" =~ ^[0-9][0-9]-[a-z0-9-]+\ deps:\ (none|[0-9][0-9](,[0-9][0-9])*)$ ]]; then
    echo "Invalid queue row: $row" >&2; exit 2
  fi
  p=${row%% *}; dep=${row##*deps: }; gate=none
  while read -r gp label gg; do [ "$gp" != "$p" ] || gate=$gg; done < "$R/docs/work/GATES.txt"
  PACKAGES+=("$p"); DEPS+=("$dep"); GATES+=("$gate"); ROWS+=("$row")
done < "$R/docs/work/QUEUE.txt"
COUNT=${#PACKAGES[@]}
index() { local j; for ((j=0;j<COUNT;j++)); do [ "${PACKAGES[$j]%%-*}" != "$1" ] || { echo "$j"; return 0; }; done; return 1; }
for ((i=0;i<COUNT;i++)); do
  [ -f "$R/docs/work/${PACKAGES[$i]}.md" ] || exit 2
  for dep in ${DEPS[$i]//,/ }; do [ "$dep" = none ] || index "$dep" >/dev/null || { echo "Unknown dependency $dep" >&2; exit 2; }; done
done
# Read-only DAG simulation, also validates later-numbered dependencies/cycles.
dry_plan() {
  local i j dep ok batch wave=0 remaining=$COUNT changed g prior gd
  local complete=' ' gate_complete=' ' next=' '
  echo "DRY_RUN: $COUNT packages; MAX=$MAX; gpt-6-luna / max"
  echo "Repo: $R"
  echo "Worktrees: $W/<pkg>; branches: kts/<pkg>"
  echo "Worker: $RUNNER KTS-<pkg> <worktree> <promptfile> gpt-6-luna max"
  echo 'Integration: locked rebase -> GIT_CONFIG_GLOBAL=/dev/null make check -> ff-only; one fix worker on failure'
  echo 'Integration gates require coordinator receipts; this simulation assumes each gate is accepted when eligible.'
  while [ "$remaining" -gt 0 ]; do
    changed=1
    while [ "$changed" = 1 ]; do
      changed=0
      while read -r g label gd prior_label prior; do
        case "$gate_complete" in *" $g "*) continue;; esac
        case "$prior" in none) ;; *) case "$gate_complete" in *" $prior "*) ;; *) continue;; esac;; esac
        ok=1
        for dep in ${gd//,/ }; do case "$complete" in *" $dep "*) ;; *) ok=0;; esac; done
        if [ "$ok" = 1 ]; then gate_complete="$gate_complete$g "; echo "  gate $g: coordinator integration"; changed=1; fi
      done < "$R/docs/work/INTEGRATION.txt"
    done
    batch=0; next=' '
    for ((i=0;i<COUNT;i++)); do
      dep=${PACKAGES[$i]%%-*}
      case "$complete" in *" $dep "*) continue;; esac
      ok=1
      for j in ${DEPS[$i]//,/ }; do [ "$j" = none ] && continue; case "$complete" in *" $j "*) ;; *) ok=0;; esac; done
      g=${GATES[$i]}; if [ "$g" != none ]; then case "$gate_complete" in *" $g "*) ;; *) ok=0;; esac; fi
      if [ "$ok" = 1 ] && [ "$batch" -lt "$MAX" ]; then next="$next$dep "; batch=$((batch+1)); fi
    done
    [ "$batch" -gt 0 ] || { echo 'Dependency/gate cycle or deadlock' >&2; return 2; }
    wave=$((wave+1)); printf '  batch %02d:%s\n' "$wave" "${next% }"
    complete="$complete$next"; remaining=$((remaining-batch))
  done
  echo '  gate I7: final coordinator release integration (no release claim from package merges)'
  echo 'No workers started; no worktrees or dispatch state changed.'
}
if [ "${DRY_RUN:-0}" = 1 ]; then dry_plan; exit 0; fi
# Validate the complete graph before any write or launch.
dry_plan >/dev/null
umask 077
mkdir -p "$D/packages" "$D/logs" "$D/prompts" "$W" "$RUNNER_LOGS" "$D/gates"
status() { if [ -f "$D/packages/$1/status" ]; then cat "$D/packages/$1/status"; else echo PENDING; fi; }
record() {
  local pkg=$1 state=$2 detail=${3:-}
  mkdir -p "$D/packages/$pkg"
  printf '%s\n' "$state" > "$D/packages/$pkg/status.tmp"
  mv "$D/packages/$pkg/status.tmp" "$D/packages/$pkg/status"
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$pkg" "$state" "$detail" >> "$D/events.tsv"
  if [ "$state" = FAILED ]; then printf '%s\t%s\n' "$pkg" "$detail" >> "$D/FAILED"; fi
}
identity() { ps -p "$1" -o lstart= 2>/dev/null | sed 's/^ *//'; }
owned_alive() {
  [ -f "$1/pid" ] && [ -f "$1/identity" ] || return 1
  local pid; pid=$(cat "$1/pid")
  kill -0 "$pid" 2>/dev/null && [ "$(identity "$pid")" = "$(cat "$1/identity")" ]
}
lock() {
  local path=$1
  if ! mkdir "$path" 2>/dev/null; then
    owned_alive "$path" && { echo "Lock held: $path" >&2; return 1; }
    # Incomplete publication of a lock requires a coordinator, not a racing removal.
    [ -s "$path/pid" ] && [ -s "$path/identity" ] || { echo "Incomplete lock: $path" >&2; return 1; }
    rm "$path/pid" "$path/identity"; rmdir "$path"; mkdir "$path"
  fi
  echo "$$" > "$path/pid"; identity "$$" > "$path/identity"
}
unlock() { rm "$1/pid" "$1/identity"; rmdir "$1"; }
lock "$D/dispatcher.lock" || exit 1
MERGE_OWNED=0
cleanup() { [ "$MERGE_OWNED" = 0 ] || unlock "$D/merge.lock"; unlock "$D/dispatcher.lock"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$R"
export MISE_AUTO_INSTALL=0
# Use the repo-selected Git and Bun, never change global mise/Git configuration.
GIT=$("$MISE" which git); BUN=$("$MISE" which bun)
export PATH="$(dirname "$GIT"):$(dirname "$BUN"):$PATH"
[ -x "$GIT" ] && [ -x "$BUN" ] && [ -x "$RUNNER" ] || exit 2
[ "$("$GIT" branch --show-current)" = main ] || { echo 'Main checkout must be on main' >&2; exit 1; }
[ -z "$("$GIT" status --porcelain)" ] || { echo 'Main checkout is dirty; preserved' >&2; exit 1; }
merged_id() { local idx; idx=$(index "$1") || return 1; [ "$(status "${PACKAGES[$idx]}")" = MERGED ]; }
gate_valid() {
  local g=$1 sha receipt="$R/docs/work/receipts/$1.md"
  [ -f "$D/gates/$g" ] && [ -f "$receipt" ] || return 1
  sha=$(cat "$D/gates/$g")
  "$GIT" merge-base --is-ancestor "$sha" main && "$GIT" cat-file -e "$sha:docs/work/receipts/$g.md" 2>/dev/null
}
if [ "${1:-}" = --accept-gate ]; then
  gate=${2:-}; sha=${3:-}; found=0
  while read -r g label gd prior_label prior; do
    [ "$g" = "$gate" ] || continue
    found=1
    [ "$prior" = none ] || gate_valid "$prior" || { echo "Missing prior gate $prior" >&2; exit 1; }
    for dep in ${gd//,/ }; do merged_id "$dep" || { echo "Unmerged dependency $dep" >&2; exit 1; }; done
  done < "$R/docs/work/INTEGRATION.txt"
  [ "$found" = 1 ] && [ -n "$sha" ] || exit 2
  "$GIT" merge-base --is-ancestor "$sha" main
  "$GIT" cat-file -e "$sha:docs/work/receipts/$gate.md"
  echo "$sha" > "$D/gates/$gate"
  printf '%s\t%s\tGATE_ACCEPTED\t%s\n' "$(date -u +%FT%TZ)" "$gate" "$sha" >> "$D/events.tsv"
  echo "$gate accepted at $sha"; exit 0
fi
[ "$#" = 0 ] || { echo 'Usage: kdispatch-ts.sh [--accept-gate I0 <committed-sha>]' >&2; exit 2; }
ready() {
  local i=$1 dep
  [ "$(status "${PACKAGES[$i]}")" = PENDING ] || return 1
  for dep in ${DEPS[$i]//,/ }; do [ "$dep" = none ] || merged_id "$dep" || return 1; done
  [ "${GATES[$i]}" = none ] || gate_valid "${GATES[$i]}"
}
launch() {
  local pkg=$1 mode=$2 pd="$D/packages/$1" wt="$W/$1" attempt=0 name prompt base
  mkdir -p "$pd"
  if [ -f "$pd/attempt" ]; then attempt=$(cat "$pd/attempt"); fi
  if [ "$mode" = fix ]; then attempt=$((attempt+1)); name="KTS-$pkg-fix$attempt"; else name="KTS-$pkg"; fi
  echo "$attempt" > "$pd/attempt"
  if [ ! -d "$wt" ]; then
    "$GIT" show-ref --verify --quiet "refs/heads/kts/$pkg" && { record "$pkg" FAILED 'Existing branch without owned worktree; coordinator required'; return 0; }
    "$GIT" worktree add -q -b "kts/$pkg" "$wt" main || { record "$pkg" FAILED 'worktree creation failed'; return 0; }
    "$GIT" rev-parse main > "$pd/base"
    cp "$pd/base" "$pd/scope-base"
    # Provision dependencies from already-installed/cache-only Bun; checks never install.
    (cd "$wt" && "$MISE" trust mise.toml && "$BUN" install --frozen-lockfile --offline) > "$D/logs/$pkg.provision.log" 2>&1 || { record "$pkg" FAILED 'offline provisioning failed'; return 0; }
  fi
  base=$(cat "$pd/base"); prompt="$D/prompts/$name.md"
  {
    cat "$R/docs/work/$pkg.md" "$R/docs/work/WORKER-RULES.md"
    printf '\nWork only in %s on kts/%s. Base SHA: %s.\n' "$wt" "$pkg" "$base"
    printf 'Read docs/work/PLAN.md and docs/work/QUEUE.md fully. Run make check and exact package acceptance; commit with plain git commit. Never push or merge main.\n'
    if [ "$mode" = fix ]; then
      printf '\nFix integration failure. Read %s and your prior receipt.\n' "$D/logs/$pkg.integration.log"
      cat "$D/logs/$pkg.integration.log" 2>/dev/null || true
      printf '\nResolve/continue any in-progress rebase on main in this worktree (GIT_EDITOR=true is allowed; signing remains normal). Fix only your owned files, rerun checks/cases, commit normally and return. The dispatcher will recheck and fast-forward. Never edit main/other worktrees or retry oracle failures into official green.\n'
    fi
  } > "$prompt"
  rm -f "$pd/done"
  echo "$name" > "$pd/runner"
  record "$pkg" STARTED "$mode attempt=$attempt base=$base"
  (
    set +e
    "$RUNNER" "$name" "$wt" "$prompt" gpt-6-luna max
    rc=$?
    # run.sh ends with echo and masks codex exit; its final exit= line is authoritative.
    if [ "$rc" = 0 ]; then
      last=$(tail -n 1 "$RUNNER_LOGS/$name.err" 2>/dev/null)
      case "$last" in exit=*) rc=${last#exit=};; *) rc=125;; esac
    fi
    for suffix in out err last.md; do [ ! -f "$RUNNER_LOGS/$name.$suffix" ] || cp "$RUNNER_LOGS/$name.$suffix" "$D/logs/$name.$suffix"; done
    printf '%s\n' "$rc" > "$pd/done.tmp"; mv "$pd/done.tmp" "$pd/done"
  ) &
  echo "$!" > "$pd/pid"; identity "$!" > "$pd/identity"
}
integrate() {
  local pkg=$1 wt="$W/$1" pd="$D/packages/$1" base head log="$D/logs/$1.integration.log"
  lock "$D/merge.lock" || return 1
  MERGE_OWNED=1
  : > "$log"
  base=$("$GIT" rev-parse main)
  if (
    set -e
    [ "$("$GIT" branch --show-current)" = main ] || exit 1
    [ -z "$("$GIT" status --porcelain)" ] || exit 1
    [ -z "$("$GIT" -C "$wt" status --porcelain)" ] || exit 1
    [ "$("$GIT" rev-parse "kts/$pkg")" != "$(cat "$pd/base")" ] || { echo NOCOMMITS; exit 1; }
    "$BUN" --no-install "$R/tools/dispatch-scope.ts" "$pkg" "$wt" "$(cat "$pd/scope-base")" || exit 1
    echo "$base" > "$pd/scope-base"
    "$GIT" -C "$wt" rebase main || exit 1
    # An already-integrated branch is valid after crash between ff and state publication.
    [ -z "$("$GIT" -C "$wt" status --porcelain)" ] || exit 1
    (cd "$wt" && GIT_CONFIG_GLOBAL=/dev/null make check) || exit 1
    [ -z "$("$GIT" -C "$wt" status --porcelain)" ] || exit 1
    "$BUN" --no-install "$R/tools/dispatch-scope.ts" "$pkg" "$wt" "$base" || exit 1
    [ "$("$GIT" rev-parse main)" = "$base" ] || { echo 'main moved during integration'; exit 1; }
    [ -z "$("$GIT" status --porcelain)" ] || exit 1
    "$GIT" merge --ff-only "kts/$pkg" || exit 1
  ) >> "$log" 2>&1; then
    head=$("$GIT" rev-parse main); echo "$head" > "$pd/head"
    record "$pkg" MERGED "$head"
    printf '%s\t%s\n' "$pkg" "$head" >> "$D/MERGED"
    # Never force-remove a dirty/failed worktree. Branch and commit receipts remain.
    if ! "$GIT" worktree remove "$wt" >> "$log" 2>&1; then
      echo "$wt" > "$pd/cleanup.pending"
      printf "%s\t%s\tCLEANUP_PENDING\t%s\n" "$(date -u +%FT%TZ)" "$pkg" "$wt" >> "$D/events.tsv"
    fi
    unlock "$D/merge.lock"; MERGE_OWNED=0; return 0
  fi
  record "$pkg" FAILED "rebase/check/scope/ff failure; see $log"
  unlock "$D/merge.lock"; MERGE_OWNED=0; return 1
}
while :; do
  running=0; merged=0; launched=0
  for ((i=0;i<COUNT;i++)); do
    pkg=${PACKAGES[$i]}; pd="$D/packages/$pkg"; st=$(status "$pkg")
    if [ "$st" = STARTED ]; then
      if [ -f "$pd/done" ]; then
        rc=$(cat "$pd/done"); wait "$(cat "$pd/pid")" 2>/dev/null || true
        if [ "$rc" = 0 ]; then
          record "$pkg" COMMITTED "$("$GIT" -C "$W/$pkg" rev-parse HEAD)"
          integrate "$pkg" || true
        else
          printf "Worker exit=%s; see copied KTS runner logs\n" "$rc" > "$D/logs/$pkg.integration.log"
          record "$pkg" FAILED "worker exit=$rc; retained worktree/logs"
        fi
        st=$(status "$pkg")
      elif owned_alive "$pd"; then running=$((running+1)); continue
      else record "$pkg" FAILED 'worker disappeared without completion receipt'; st=FAILED; fi
    fi
    if [ "$st" = COMMITTED ]; then integrate "$pkg" || true; st=$(status "$pkg"); fi
    if [ "$st" = FAILED ] && [ -d "$W/$pkg" ]; then
      attempt=$(cat "$pd/attempt")
      if [ "$attempt" -lt "$MAX_FIXES" ] && [ "$running" -lt "$MAX" ]; then launch "$pkg" fix; running=$((running+1)); launched=1; fi
    fi
    [ "$st" != MERGED ] || merged=$((merged+1))
  done
  [ "$merged" -ne "$COUNT" ] || { echo 'ALL PACKAGES MERGED; I7 release gate remains coordinator-owned'; exit 0; }
  for ((i=0;i<COUNT;i++)); do
    if [ "$running" -lt "$MAX" ] && ready "$i"; then launch "${PACKAGES[$i]}" implement; running=$((running+1)); launched=1; fi
  done
  if [ "$running" = 0 ] && [ "$launched" = 0 ]; then
    echo 'BLOCKED: unresolved failure or integration gate. Worktrees/state retained; see events.tsv and DISPATCH.md.'
    exit 1
  fi
  sleep "$POLL"
done
