#!/usr/bin/env python3
"""Seed bugs into the SPEC and check that its own scenarios and invariants notice."""
import os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = open(os.path.join(ROOT, "spec", "landing.qnt")).read()
MUTANTS = {
 "spec_no_cas": ("if (tip(s) == rn.parent)", "if (true)"),
 "spec_tie_reversed": ("ta < tb or (ta == tb and rank(a) < rank(b))", "ta < tb or (ta == tb and rank(a) > rank(b))"),
 "spec_recover_ignores_landing": ("val landed = rn.landing and onBase(acc, r)", "val landed = false"),
 "spec_record_after_cas": ("{ ...setRun(s, id, { ...rn, landing: true }), proc: { rid: id, phase: \"recorded\" }, last: \"ok\" }",
                           "{ ...s, proc: { rid: id, phase: \"recorded\" }, last: \"ok\" }"),
}
EXTRA = {"spec_record_after_cas": ("{ ...s, incoming: s.incoming.exclude(Set(id)), proc: { rid: id, phase: \"cleaned\" }, last: \"ok\" }",
                                   "{ ...setRun(s, id, { ...rn, landing: true }), incoming: s.incoming.exclude(Set(id)), proc: { rid: id, phase: \"cleaned\" }, last: \"ok\" }")}
os.makedirs(os.path.join(ROOT, "build", "specmut"), exist_ok=True)
for name, (old, new) in MUTANTS.items():
    assert SPEC.count(old) == 1, name
    src = SPEC.replace(old, new)
    if name in EXTRA: o, n = EXTRA[name]; assert src.count(o) == 1, name; src = src.replace(o, n)
    path = os.path.join(ROOT, "build", "specmut", name + ".qnt"); open(path, "w").write(src)
    env = dict(os.environ, XSPEC_SPEC=os.path.relpath(path, ROOT), XSPEC_GOLDEN=os.path.join(ROOT, "build", "specmut", "golden"))
    r = subprocess.run([sys.executable, os.path.join(ROOT, "harness", "xspec.py"), "spec"], capture_output=True, text=True, env=env, cwd=ROOT)
    fails = [l.split()[1] for l in r.stdout.splitlines() if l.startswith("FAIL")]
    inv = sum("invariant violated" in l for l in r.stdout.splitlines())
    g = subprocess.run([sys.executable, os.path.join(ROOT, "harness", "xspec.py"), "gen", "--traces", "300"], capture_output=True, text=True, env=env, cwd=ROOT)
    print(f"{name:30} scenarios failing {len(fails):>2} ({inv} via invariant) {','.join(fails)[:60]:60} | simulation: {'invariant violated' if g.returncode else 'no violation'}")
