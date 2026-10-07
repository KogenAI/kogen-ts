#!/usr/bin/env python3
"""Mutation study: seed realistic bugs into the Go implementation and see which
scenario set (hand-written vs spec-generated) catches each one."""
import os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "impls", "go")
CORE = "core/core.go"

MUTANTS = {  # name: (description, old, new)
 "no_cas": ("land even when the base moved", "if s.tip() == rn.Parent {", "if true {"),
 "recover_ignores_landing": ("recovery fails every dead run", "if rn.Landing && s.onBase(id) {", "if false {"),
 "recover_trusts_record": ("recovery trusts the Landing record without checking the base", "if rn.Landing && s.onBase(id) {", "if rn.Landing {"),
 "recover_keeps_incoming": ("recovery leaves refs/kogen/incoming", "\t\tdelete(s.Incoming, id)\n\t\tif s.Claim == id {", "\t\tif s.Claim == id {"),
 "recover_keeps_claim": ("recovery leaves the dead run's claim", "\t\tif s.Claim == id {\n\t\t\ts.Claim = \"\"\n\t\t}\n\t}\n}", "\t}\n}"),
 "start_skips_recovery": ("queue start does not recover first", "\ts.recover() // recovery", "\t// s.recover() // recovery"),
 "queue_tie_reversed": ("equal times ordered by slug descending", "cmp.Compare(a, b))", "cmp.Compare(b, a))"),
 "queue_time_only": ("ties left to map iteration order", "cmp.Or(cmp.Compare(s.Approvals[a].Time, s.Approvals[b].Time), cmp.Compare(a, b))", "cmp.Compare(s.Approvals[a].Time, s.Approvals[b].Time)"),
 "gate_red_keeps_claim": ("a red gate does not release the claim", "\t\ts.Runs[id] = rn\n\t\ts.Claim = \"\"\n\t\ts.Proc = Proc{}\n\t}\n\ts.Last = \"ok\"", "\t\ts.Runs[id] = rn\n\t\ts.Proc = Proc{}\n\t}\n\ts.Last = \"ok\""),
 "no_interrupted_postpass": ("status never shows interrupted", "if interrupted && (base", "if false && interrupted && (base"),
 "failed_ignores_approval": ("re-approval does not requeue a failed Intent", "case current && r.Status == \"failed\":", "case r.Status == \"failed\":"),
 "approve_while_building": ("approval accepted during the Intent's own Build", "case s.hasApproval(slug) && s.derive(slug) == \"building\":", "case false:"),
 "park_keeps_incoming": ("parking leaves refs/kogen/incoming", "\t\t\tdelete(s.Incoming, id)\n\t\t\ts.Claim = \"\"", "\t\t\ts.Claim = \"\""),
 "finish_keeps_incoming": ("landing never deletes refs/kogen/incoming", "\t\tdelete(s.Incoming, id)\n\t\ts.Proc.Phase = \"cleaned\"", "\t\ts.Proc.Phase = \"cleaned\""),
 "record_after_cas": ("Landing recorded after the base CAS, not before",
   "\t\trn.Landing = true\n\t\ts.Runs[id] = rn\n\t\ts.Proc.Phase = \"recorded\"", "\t\ts.Proc.Phase = \"recorded\""),
 "latest_run_by_id": ("latest run chosen by id order, not start order", "r.Started > s.Runs[best].Started", "id > best"),
 "kill_without_process": ("Crash with no Build is accepted", "func (s *State) kill(sigterm bool) {\n\tif s.Proc.Phase == \"\" {", "func (s *State) kill(sigterm bool) {\n\tif false {"),
 "external_id_collision": ("an external commit may reuse a run id", "if _, isRun := s.Runs[id]; isRun || s.onBase(id) {", "if s.onBase(id) {"),
}
EXTRA = {"record_after_cas": ("\tcase \"based\":\n", "\tcase \"based\":\n\t\trn.Landing = true\n\t\ts.Runs[id] = rn\n")}


def conform(adapter, only):
    r = subprocess.run([sys.executable, os.path.join(ROOT, "harness", "xspec.py"), "conform", "--only", only,
                        "--show", "0", "--", adapter], capture_output=True, text=True, cwd=ROOT)
    m = re.search(r"conform: (\d+)/(\d+)", r.stdout)
    return (int(m.group(2)) - int(m.group(1)), int(m.group(2))) if m else (-1, 0)


def main():
    base = os.path.join(ROOT, "build", "mutants")
    rows = []
    for name, (desc, old, new) in MUTANTS.items():
        d = os.path.join(base, name)
        if os.path.exists(d): shutil.rmtree(d)
        shutil.copytree(SRC, d, ignore=shutil.ignore_patterns("landing-adapter"))
        p = os.path.join(d, CORE); src = open(p).read()
        assert src.count(old) == 1, f"{name}: pattern found {src.count(old)} times"
        src = src.replace(old, new)
        if name in EXTRA:
            o, n = EXTRA[name]; assert src.count(o) == 1, name; src = src.replace(o, n)
        open(p, "w").write(src)
        b = subprocess.run(["sh", os.path.join(d, "build.sh")], capture_output=True, text=True)
        if b.returncode: rows.append((name, desc, "build failed", "")); print(b.stderr[-500:]); continue
        adapter = os.path.join(d, "landing-adapter")
        h, g = conform(adapter, "hand"), conform(adapter, "gen")
        rows.append((name, desc, f"{h[0]}/{h[1]}", f"{g[0]}/{g[1]}"))
        print(f"{name:26} hand fails {h[0]:>2}/{h[1]:<3} gen fails {g[0]:>3}/{g[1]:<4} {desc}", flush=True)
    killed_h = sum(r[2][0] != "0" for r in rows); killed_g = sum(r[3][0] != "0" for r in rows)
    killed_any = sum(r[2][0] != "0" or r[3][0] != "0" for r in rows)
    print(f"\nkilled: hand {killed_h}/{len(rows)}, gen {killed_g}/{len(rows)}, either {killed_any}/{len(rows)}")


if __name__ == "__main__":
    main()
