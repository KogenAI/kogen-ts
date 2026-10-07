#!/usr/bin/env python3
"""xspec: executable neutral spec harness (prototype).

  xspec.py spec                         run hand scenarios through the Quint spec, check
                                        their expectations and invariants, write golden traces
  xspec.py gen [--traces N --steps K --seed S]
                                        simulate the spec, keep invariant-checked random traces
  xspec.py conform [--only hand|gen] [--project a,b.c] -- <adapter argv…>
                                        replay every golden trace through an implementation.
                                        --project compares only those observation fields.

The harness knows nothing about Kogen. Configuration lives in xspec.json next to the spec.
XSPEC_SLICE points at another slice directory (xspec.json, spec/, scenarios/). The Quint
binary stays in the prototype's node_modules.
"""
import json, os, re, subprocess, sys, glob, select, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_json(path):
    with open(path) as source:
        return json.load(source)

# A slice directory holds xspec.json, spec/ and scenarios/. Default is the prototype.
SLICE = os.path.abspath(os.environ.get("XSPEC_SLICE", ROOT))
CFG = load_json(os.path.join(SLICE, "xspec.json"))
CFG["spec"] = os.environ.get("XSPEC_SPEC", CFG["spec"])  # e.g. a spec mutant
QUINT = [os.path.join(ROOT, "node_modules", ".bin", "quint")]
BUILD = os.path.abspath(os.environ.get("XSPEC_BUILD", os.path.join(SLICE, "build")))
GOLD = os.environ.get("XSPEC_GOLDEN", os.path.join(SLICE, "golden"))


# ---------- values: ITF <-> neutral JSON <-> Quint literals ----------
def itf(v, path=(), sets=None):
    """Decode an ITF value into plain JSON; record paths that hold sets."""
    if isinstance(v, dict):
        if "#bigint" in v: return int(v["#bigint"])
        if "#set" in v:
            if sets is not None: sets.add(path)
            return sorted((itf(x, path + ("[]",), sets) for x in v["#set"]), key=json.dumps)
        if "#tup" in v: return [itf(x, path + ("[]",), sets) for x in v["#tup"]]
        if "#map" in v: return {str(itf(k)): itf(x, path + ("*",), sets) for k, x in v["#map"]}
        if set(v) == {"tag", "value"}:
            val = itf(v["value"], path + ("value",), sets)
            return {"tag": v["tag"]} if val == [] else {"tag": v["tag"], "value": val}
        return {k: itf(x, path + (k,), sets) for k, x in v.items()}
    if isinstance(v, list): return [itf(x, path + ("[]",), sets) for x in v]
    return v

def wire(compact):
    """["Approve", {...}] -> {"tag": "Approve", "value": {...}}"""
    return {"tag": compact[0]} if len(compact) == 1 else {"tag": compact[0], "value": compact[1]}

def qlit(v):
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, str): return json.dumps(v)
    if isinstance(v, list): return "[" + ", ".join(map(qlit, v)) + "]"
    if isinstance(v, dict): return "{ " + ", ".join(f"{k}: {qlit(x)}" for k, x in v.items()) + " }"
    raise ValueError(v)

def qevent(e): return e["tag"] + (f"({qlit(e['value'])})" if "value" in e else "")


# ---------- comparison ----------
def canon(v, sets, path=()):
    if path in sets and isinstance(v, list): v = sorted(v, key=json.dumps)
    if isinstance(v, dict): return {k: canon(x, sets, path + (k if path + (k,) in sets or not _wild(sets, path) else "*",)) for k, x in v.items()}
    if isinstance(v, list): return [canon(x, sets, path + ("[]",)) for x in v]
    return v

def _wild(sets, path):  # does any set path continue through a map wildcard here?
    return any(p[:len(path) + 1] == path + ("*",) for p in sets)

def diff(want, got, path="", subset=False):
    """Differences as 'path: want X, got Y'. subset=True ignores keys absent from want."""
    out = []
    if isinstance(want, dict) and isinstance(got, dict):
        # An empty expected object is an explicit assertion that the object is
        # empty. Treating it as a vacuous subset lets missing-map regressions
        # pass hand scenarios such as `refs: {}`.
        keys = (want.keys() if want else want.keys() | got.keys()) if subset else want.keys() | got.keys()
        for k in sorted(keys):
            p = f"{path}.{k}" if path else k
            if k not in got: out.append(f"{p}: want {json.dumps(want[k])}, got nothing")
            elif k not in want: out.append(f"{p}: want nothing, got {json.dumps(got[k])}")
            else: out += diff(want[k], got[k], p, subset)
    elif want != got:
        out.append(f"{path}: want {json.dumps(want)}, got {json.dumps(got)}")
    return out


# ---------- spec stage ----------
def load_scenarios():
    return [load_json(p) for p in sorted(glob.glob(os.path.join(SLICE, "scenarios", "*.json")))]

def tname(name): return "s_" + re.sub(r"\W", "_", name) + "Test"

def cmd_spec(_args):
    scen = load_scenarios()
    if not scen:
        print("spec: no scenarios; refusing to publish an empty hand corpus")
        return 1
    names = [s.get("name") for s in scen]
    if any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names):
        print("spec: scenario names must be non-empty and unique")
        return 1
    os.makedirs(os.path.join(BUILD, "itf"), exist_ok=True)
    rel = os.path.relpath(os.path.join(SLICE, CFG["spec"]), BUILD)[:-4]
    inv, fire = CFG["invariant"], CFG["fire"]
    lines = [f"module scenarios_test {{", f'  import {CFG["module"]}.* from "{rel}"']
    for s in scen:
        chain = f"{CFG['init']}.expect({inv})" + "".join(
            f".then({fire}({qevent(wire(st['do']))})).expect({inv})" for st in s["steps"])
        lines.append(f"  run {tname(s['name'])} = {chain}")
    lines.append("}")
    test_file = os.path.join(BUILD, "scenarios_test.qnt")
    with open(test_file, "w") as output:
        output.write("\n".join(lines) + "\n")
    for f in glob.glob(os.path.join(BUILD, "itf", "*.itf.json")): os.remove(f)
    t0 = time.time()
    r = subprocess.run(QUINT + ["test", test_file, "--main", "scenarios_test", "--match", "Test$",
                                "--out-itf", os.path.join(BUILD, "itf", "{test}.itf.json")],
                       capture_output=True, text=True)
    quint_ms = int((time.time() - t0) * 1000)
    quint_output = r.stdout + "\n" + r.stderr
    reported_tests = {
        name for name in (tname(s["name"]) for s in scen)
        if re.search(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])", quint_output)
    }
    failed_runs = set(re.findall(r"\d+\)\s+([A-Za-z_]\w*):", quint_output))
    reported_tests.update(failed_runs)
    goldens = []
    bad = 0
    for s in scen:
        problems = []
        path = os.path.join(BUILD, "itf", tname(s["name"]) + ".itf.json")
        test_name = tname(s["name"])
        if r.returncode and (test_name in reported_tests or not reported_tests):
            problems.append("Quint reported this scenario as failed" if reported_tests else
                            f"Quint exited {r.returncode} without identifying a failed scenario")
        if not os.path.exists(path):
            problems.append("no trace (Quint error or failed test)")
        else:
            tr = load_json(path); sets = set()
            obs = [itf(st[CFG["obs_var"]], (), sets) for st in tr["states"]]
            if len(obs) != len(s["steps"]) + 1:
                k = len(obs) - 1
                problems.append(f"incomplete trace: expected {len(s['steps']) + 1} states, got {len(obs)}")
                if len(obs) < len(s["steps"]) + 1:
                    problems.append(f"invariant violated or test stopped after step {k} {json.dumps(s['steps'][k - 1]['do']) if k else 'init'}")
            for i, st in enumerate(s["steps"][:len(obs) - 1]):
                if "expect" in st:
                    for d in diff(st["expect"], obs[i + 1], subset=True):
                        problems.append(f"step {i + 1} {json.dumps(st['do'])}: {d}")
            gold = {"name": s["name"], "source": "hand", "sets": sorted(map(list, sets)),
                    "events": [wire(st["do"]) for st in s["steps"]], "obs": obs}
            goldens.append((s["name"], gold))
        bad += bool(problems)
        print(("FAIL " if problems else "ok   ") + s["name"])
        for p in problems: print("     " + p)
    if r.returncode:
        print(f"Quint exited {r.returncode}; failed scenario tests: " +
              (", ".join(sorted(reported_tests)) if reported_tests else "unattributed"))
        print(quint_output[-6000:])
    print(f"spec: {len(scen) - bad}/{len(scen)} scenarios agree with the spec (quint {quint_ms} ms)")
    if bad or r.returncode or len(goldens) != len(scen):
        print("spec: no hand goldens published")
        return 1

    # Goldens are published only after Quint, every trace, every hand
    # expectation, and the requested scenario count have all passed.
    hand_dir = os.path.join(GOLD, "hand")
    os.makedirs(hand_dir, exist_ok=True)
    expected_files = {name + ".json" for name, _ in goldens}
    for path in glob.glob(os.path.join(hand_dir, "*.json")):
        if os.path.basename(path) not in expected_files:
            os.remove(path)
    for name, gold in goldens:
        with open(os.path.join(hand_dir, name + ".json"), "w") as output:
            json.dump(gold, output)
    return 1 if bad else 0


def cmd_gen(args):
    n, steps, seed = int(args.get("--traces", 100)), int(args.get("--steps", 30)), args.get("--seed", "1")
    if n <= 0 or steps <= 0:
        print("gen: traces and steps must both be positive")
        return 2
    out = os.path.join(BUILD, "gen"); os.makedirs(out, exist_ok=True)
    for f in glob.glob(os.path.join(out, "*.itf.json")): os.remove(f)
    t0 = time.time()
    r = subprocess.run(QUINT + ["run", os.path.join(SLICE, CFG["spec"]), "--invariant", CFG["invariant"],
                                "--max-samples", str(n), "--n-traces", str(n), "--max-steps", str(steps),
                                "--seed", seed, "--mbt", "--verbosity", "0",
                                "--out-itf", os.path.join(out, "t{seq}.itf.json")],
                       capture_output=True, text=True)
    if r.returncode:
        print(f"Quint exited {r.returncode}; generation rejected:\n" + (r.stdout + "\n" + r.stderr)[-6000:]); return 1
    traces = sorted(glob.glob(os.path.join(out, "*.itf.json")))
    if len(traces) != n:
        print(f"gen: requested {n} traces, Quint emitted {len(traces)}; refusing an incomplete corpus")
        return 1
    generated = []
    ok_events = 0; total = 0; cov = {}
    for p in traces:
        tr = load_json(p); sets = set()
        if not isinstance(tr.get("states"), list) or not tr["states"]:
            print(f"gen: invalid or empty trace {os.path.basename(p)}; refusing an incomplete corpus")
            return 1
        evs = [itf(st[CFG["ev_var"]]) for st in tr["states"]][1:]
        obs = [itf(st[CFG["obs_var"]], (), sets) for st in tr["states"]]
        if len(obs) != len(evs) + 1 or any(not isinstance(o, dict) for o in obs):
            print(f"gen: incomplete observation/event trace {os.path.basename(p)}")
            return 1
        total += len(evs); ok_events += sum(o["last"] == "ok" for o in obs[1:])
        for path in CFG.get("coverage", []):
            for o in obs: cov.setdefault(path, {}).update({v: cov.get(path, {}).get(v, 0) + 1 for v in pick(o, path)})
        name = "g" + re.search(r"t(\d+)", os.path.basename(p)).group(1).zfill(4)
        generated.append((name, {"name": name, "source": f"gen seed={seed}", "sets": sorted(map(list, sets)),
                                "events": evs, "obs": obs}))
    if len(generated) != n:
        print(f"gen: expected {n} complete traces, built {len(generated)}; refusing to publish")
        return 1
    gdir = os.path.join(GOLD, "gen"); os.makedirs(gdir, exist_ok=True)
    expected_files = {name + ".json" for name, _ in generated}
    for path in glob.glob(os.path.join(gdir, "*.json")):
        if os.path.basename(path) not in expected_files and os.path.basename(path) != "manifest.json":
            os.remove(path)
    for name, gold in generated:
        with open(os.path.join(gdir, name + ".json"), "w") as output:
            json.dump(gold, output)
    manifest = {"source": "gen", "seed": str(seed), "requested_traces": n,
                "steps": steps, "trace_names": [name for name, _ in generated]}
    with open(os.path.join(gdir, "manifest.json"), "w") as output:
        json.dump(manifest, output, sort_keys=True)
    print(f"gen: {len(generated)} traces, {total} events "
          f"({ok_events} accepted, {total - ok_events} refused), invariants hold "
          f"({int((time.time() - t0) * 1000)} ms)")
    for path, seen in cov.items():
        print(f"  coverage {path}: " + ", ".join(f"{k}×{v}" for k, v in sorted(seen.items(), key=lambda kv: -kv[1])))
    return 0

def pick(o, path):
    """values at a dotted path; '*' fans out over map values"""
    vals = [o]
    for part in path.split("."):
        vals = [x for v in vals for x in (v.values() if part == "*" else [v.get(part)]) if isinstance(v, dict)]
    return [json.dumps(v) if not isinstance(v, str) else v for v in vals if v is not None]


# ---------- implementation stage ----------
class Adapter:
    def __init__(self, cmd):
        self.cmd = cmd; self.start()
    def start(self):
        self.p = subprocess.Popen(self.cmd, shell=False, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1, cwd=ROOT)
    def ask(self, req, timeout=10):
        self.p.stdin.write(json.dumps(req) + "\n"); self.p.stdin.flush()
        ready, _, _ = select.select([self.p.stdout], [], [], timeout)
        line = self.p.stdout.readline() if ready else ""
        if not line:
            err = ""
            try:
                self.p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            if self.p.poll() is not None: err = self.p.stderr.read()[-1500:]
            raise RuntimeError(f"adapter gave no answer to {json.dumps(req)} {err}")
        return json.loads(line)
    def close(self):
        try:
            if self.p.stdin and not self.p.stdin.closed:
                self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()
            self.p.wait()
        finally:
            for pipe in (self.p.stdout, self.p.stderr):
                if pipe and not pipe.closed:
                    pipe.close()

def prune(v, paths, cur=""):
    """Keep only the dotted paths in `paths` (prefix match).

    Adapters over a real core often expose a partial view. `--project a,b.c`
    compares just those fields.
    """
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            p = f"{cur}.{k}" if cur else k
            if p in paths:
                out[k] = x
            elif any(q.startswith(p + ".") for q in paths):
                out[k] = prune(x, paths, p)
        return out
    return v


def cmd_conform(args, cmd):
    proj = set(args["--project"].split(",")) if args.get("--project") else None
    if proj:
        print("DIAGNOSTIC PROJECTION ONLY: projected results are not conformance passes")
    sources = ["hand", "gen"] if not args.get("--only") else [args["--only"]]
    if any(source not in ("hand", "gen") for source in sources):
        print("conform: --only must be hand or gen")
        return 2
    files = []
    corpus_errors = []
    for src in sources:
        directory = os.path.join(GOLD, src)
        selected = sorted(glob.glob(os.path.join(directory, "*.json")))
        selected = [path for path in selected if os.path.basename(path) != "manifest.json"]
        if not selected:
            corpus_errors.append(f"{src} corpus is empty or missing at {directory}")
            continue
        if src == "hand":
            expected = {s.get("name") + ".json" for s in load_scenarios() if isinstance(s.get("name"), str)}
            actual = {os.path.basename(path) for path in selected}
            if actual != expected:
                missing = sorted(expected - actual)
                extra = sorted(actual - expected)
                corpus_errors.append(f"hand corpus is incomplete (missing={missing}, extra={extra})")
        else:
            manifest_path = os.path.join(directory, "manifest.json")
            try:
                manifest = load_json(manifest_path)
                actual_names = sorted(os.path.splitext(os.path.basename(path))[0] for path in selected)
                expected_names = manifest["trace_names"]
                if (not isinstance(manifest, dict) or manifest.get("source") != "gen"
                        or not isinstance(expected_names, list)
                        or manifest.get("requested_traces") != len(expected_names)
                        or sorted(expected_names) != actual_names or not expected_names):
                    corpus_errors.append("generated corpus does not match its complete manifest")
            except (OSError, ValueError, KeyError, TypeError) as error:
                corpus_errors.append(f"generated corpus has no valid completeness manifest: {error}")
        for path in selected:
            try:
                gold = load_json(path)
                if (not isinstance(gold, dict) or not isinstance(gold.get("events"), list)
                        or not isinstance(gold.get("obs"), list)
                        or len(gold["obs"]) != len(gold["events"]) + 1
                        or any(not isinstance(event, dict) or not isinstance(event.get("tag"), str)
                               for event in gold["events"])
                        or any(not isinstance(obs, dict) for obs in gold["obs"])):
                    corpus_errors.append(f"incomplete trace {path}")
            except (OSError, ValueError, TypeError, AttributeError) as error:
                corpus_errors.append(f"invalid trace {path}: {error}")
        files += selected
    if corpus_errors:
        for error in corpus_errors:
            print("conform: " + error)
        print("conform: refusing to replay an empty or incomplete corpus")
        return 2
    ad = Adapter(cmd); t0 = time.time()
    fails, sigs, steps = [], {}, 0
    for f in files:
        g = load_json(f); sets = {tuple(p) for p in g["sets"]}
        i = 0
        try:
            got = canon(ad.ask({"op": "reset"}), sets)
            if proj: got = prune(got, proj)
            want0 = prune(g["obs"][0], proj) if proj else g["obs"][0]
            d = diff(want0, got); i = 0
            while not d and i < len(g["events"]):
                got = canon(ad.ask({"op": "apply", "event": g["events"][i]}), sets); steps += 1
                if proj: got = prune(got, proj)
                want = prune(g["obs"][i + 1], proj) if proj else g["obs"][i + 1]
                d = diff(want, got); i += 1
        except Exception as ex:
            d = [f"adapter error: {str(ex)[-1500:]}"]; ad.close(); ad = Adapter(cmd)
        if d:
            ev = g["events"][i - 1]["tag"] if i else "reset"
            sig = f"{ev} -> " + ", ".join(sorted({re.sub(r'\.(r|x)\d+', '.<id>', x.split(':')[0]) for x in d}))
            sigs.setdefault(sig, []).append(g["name"])
            fails.append((g["name"], i, g["events"][:i], d))
    ad.close()
    hand = [f for f in files if "/hand/" in f]
    hand_fail = [x for x in fails if not x[0].startswith("g")]
    label = "diagnostic projection" if proj else "conform"
    print(f"{label}: {len(files) - len(fails)}/{len(files)} traces agree with the spec "
          f"(hand {len(hand) - len(hand_fail)}/{len(hand)}, gen {len(files) - len(hand) - len(fails) + len(hand_fail)}/{len(files) - len(hand)}); "
          f"{steps} steps in {int((time.time() - t0) * 1000)} ms")
    for name, i, evs, d in fails[:int(args.get("--show", 3))]:
        print(f"\n✗ {name}: diverges at step {i}")
        for k, e in enumerate(evs[-6:]): print(f"    {i - len(evs[-6:]) + k + 1:>3} {json.dumps(e)}")
        for x in d[:6]: print("      " + x)
    if sigs:
        print("\ndivergence classes (first differing event -> fields):")
        for s, names in sorted(sigs.items(), key=lambda kv: -len(kv[1])):
            print(f"  {len(names):>4} × {s}   e.g. {names[0]}")
    return 1 if fails else (2 if proj else 0)


def main(argv):
    if not argv: print(__doc__); return 2
    cmd, rest = argv[0], argv[1:]
    adapter = None
    if "--" in rest: k = rest.index("--"); adapter = rest[k + 1:]; rest = rest[:k]
    opts = dict(zip(rest[::2], rest[1::2]))
    if cmd == "spec": return cmd_spec(opts)
    if cmd == "gen": return cmd_gen(opts)
    if cmd == "conform" and adapter: return cmd_conform(opts, adapter)
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
