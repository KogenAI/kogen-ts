"""kogen-conformance command line.

    python3 -m kogen_conformance run --kogen /path/to/kogen [--profile cli,format] [--case cli-0*]
    python3 -m kogen_conformance list [--profile ...]
    python3 -m kogen_conformance summary results.jsonl [--expectations reference/x.json]
    python3 -m kogen_conformance fake --script steps.jsonl --port 8765
"""

import argparse
import concurrent.futures
import json
import os
import platform
import subprocess
import sys
import tempfile
import time

from . import runner
from .context import ROOT


def _opts_from_args(args):
    class Opts:
        pass
    o = Opts()
    o.kogen = os.path.realpath(args.kogen)
    o.time_scale = args.time_scale
    o.run_timeout = args.run_timeout
    o.inherited_path = args.path or os.environ.get("PATH", "/usr/bin:/bin")
    o.lang = args.lang or ("en_US.UTF-8" if platform.system() == "Darwin" else "C.UTF-8")
    o.extra_env = dict(kv.split("=", 1) for kv in args.env)
    o.keep = args.keep
    o.skip_needs = [s for s in (args.skip_needs or "").split(",") if s]
    o.workdir = os.path.realpath(args.workdir or tempfile.mkdtemp(prefix="kogen-conformance-"))
    os.makedirs(o.workdir, exist_ok=True)
    return o


def cmd_run(args):
    opts = _opts_from_args(args)
    profiles = [p for p in (args.profile or "").split(",") if p] or None
    ids = [p for p in (args.case or "").split(",") if p] or None
    cases = runner.load_cases(profiles, ids)
    if not cases:
        print("no cases selected", file=sys.stderr)
        return 2
    out_path = args.out or os.path.join(opts.workdir, "results.jsonl")
    meta = {"kind": "meta", "suite": "kogen-conformance", "suite_version": suite_version(), "kogen": opts.kogen,
            "platform": platform.platform(), "git": _git_version(), "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "time_scale": opts.time_scale, "profiles": profiles or runner.PROFILES, "workdir": opts.workdir}
    results = []
    lock = __import__("threading").Lock()
    with open(out_path, "w") as out:
        out.write(json.dumps(meta) + "\n")

        def record(res):
            with lock:
                results.append(res)
                out.write(json.dumps(res) + "\n")
                out.flush()
                if not args.quiet:
                    mark = {"pass": "PASS", "fail": "FAIL", "error": "ERR ", "skip": "SKIP", "unimplemented": "----"}[res["status"]]
                    inst = res.get("instances") or {}
                    extra = " (%d/%d instances)" % (inst["passed"], inst["total"]) if inst.get("total", 1) > 1 else ""
                    print("%s %-12s %s%s" % (mark, res["id"], res.get("title", ""), extra), flush=True)
                    if res["status"] in ("fail", "error") and args.verbose:
                        for f in res.get("failures", [])[:3]:
                            for m in (f.get("messages") or [f.get("harness_error", "")])[:6]:
                                print("       %s%s" % ("[%s] " % f["instance"] if f.get("instance") else "", m[:400]))
                        for h in res.get("hints", []):
                            print("       hint: %s" % h)

        parallel = [c for c in cases if not c.get("serial")]
        serial = [c for c in cases if c.get("serial")]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for res in pool.map(lambda c: runner.run_case(c, opts), parallel):
                record(res)
        for c in serial:
            record(runner.run_case(c, opts))
    expectations = load_expectations(args.expectations)
    print()
    print(summary_table(results, expectations))
    print("\nresults: %s" % out_path)
    failed = [r for r in results if r["status"] in ("fail", "error")]
    return 1 if failed else 0


def suite_version():
    try:
        with open(os.path.join(ROOT, "VERSION")) as f:
            version = f.read().strip()
    except OSError:
        version = "unknown"
    try:
        sha = subprocess.run(["git", "describe", "--always", "--tags", "--dirty"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        return "v%s+%s" % (version, sha or "unknown")
    except OSError:
        return "v%s+unknown" % version


def _git_version():
    try:
        return subprocess.run(["git", "--version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return "unknown"


def load_expectations(path):
    if not path:
        return {}
    with open(path) as f:
        doc = json.load(f)
    return doc.get("cases", doc)


def summary_table(results, expectations=None):
    expectations = expectations or {}
    rows = []
    header = ["profile", "cases", "implemented", "pass", "fail", "error", "skip", "unimpl", "instances"]
    total = dict.fromkeys(header[1:], 0)
    for profile in runner.PROFILES:
        rs = [r for r in results if r["profile"] == profile]
        if not rs:
            continue
        c = {
            "cases": len(rs),
            "implemented": len([r for r in rs if r["status"] != "unimplemented"]),
            "pass": len([r for r in rs if r["status"] == "pass"]),
            "fail": len([r for r in rs if r["status"] == "fail"]),
            "error": len([r for r in rs if r["status"] == "error"]),
            "skip": len([r for r in rs if r["status"] == "skip"]),
            "unimpl": len([r for r in rs if r["status"] == "unimplemented"]),
            "instances": sum((r.get("instances") or {}).get("total", 0) for r in rs),
        }
        for k in c:
            total[k] += c[k]
        rows.append([profile] + [str(c[k]) for k in header[1:]])
    rows.append(["total"] + [str(total[k]) for k in header[1:]])
    widths = [max(len(header[i]), *(len(r[i]) for r in rows)) for i in range(len(header))]
    lines = ["| " + " | ".join(h.ljust(w) for h, w in zip(header, widths)) + " |",
             "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
    for r in rows:
        lines.append("| " + " | ".join(v.ljust(w) if i == 0 else v.rjust(w) for i, (v, w) in enumerate(zip(r, widths))) + " |")
    if expectations:
        classes = {}
        for r in results:
            if r["status"] in ("fail", "error"):
                cls = (expectations.get(r["id"]) or {}).get("class", "unclassified")
                classes.setdefault(cls, []).append(r["id"])
        unexpected_pass = [r["id"] for r in results if r["status"] == "pass" and (expectations.get(r["id"]) or {}).get("class")]
        lines.append("")
        lines.append("Failures by classification:")
        for cls in sorted(classes):
            lines.append("  %-14s %3d  %s" % (cls, len(classes[cls]), " ".join(sorted(classes[cls]))))
        if unexpected_pass:
            lines.append("  passing although classified: %s" % " ".join(unexpected_pass))
    return "\n".join(lines)


def cmd_summary(args):
    results = []
    with open(args.results) as f:
        for line in f:
            doc = json.loads(line)
            if doc.get("kind") != "meta":
                results.append(doc)
    print(summary_table(results, load_expectations(args.expectations)))
    return 0


def cmd_list(args):
    profiles = [p for p in (args.profile or "").split(",") if p] or None
    for case in runner.load_cases(profiles):
        status = case.get("status", "implemented")
        print("%-12s %-14s %s" % (case["id"], status, case.get("title", "")))
    return 0


def cmd_fake(args):
    from .fake_server import serve_forever
    serve_forever(args.script, args.port, args.time_scale)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="kogen-conformance", description="Kogen core v1 black-box conformance suite")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run cases against a kogen binary")
    r.add_argument("--kogen", required=True, help="path to the implementation's kogen executable")
    r.add_argument("--profile", help="comma-separated profiles (default: all)")
    r.add_argument("--case", help="comma-separated case ids or globs (e.g. cli-0*,build-02)")
    r.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) // 2))
    r.add_argument("--workdir", help="where case directories go (default: a new temp dir)")
    r.add_argument("--out", help="JSONL results path (default: <workdir>/results.jsonl)")
    r.add_argument("--time-scale", type=float, default=0.01, help="KOGEN_TIME_SCALE (default 0.01)")
    r.add_argument("--run-timeout", type=float, default=180, help="seconds per kogen invocation")
    r.add_argument("--path", help="PATH after the stubs dir (default: the runner's PATH)")
    r.add_argument("--lang", help="LANG for kogen (default en_US.UTF-8 on macOS, C.UTF-8 elsewhere)")
    r.add_argument("--env", action="append", default=[], help="extra NAME=VALUE for kogen (repeatable)")
    r.add_argument("--skip-needs", help="skip cases needing any of these (e.g. login,elixir)")
    r.add_argument("--expectations", help="known-failure classification JSON (e.g. reference/elixir-97ef563d.json)")
    r.add_argument("--keep", action="store_true", help="keep passing case directories")
    r.add_argument("--quiet", action="store_true")
    r.add_argument("-v", "--verbose", action="store_true", help="print failure details")
    r.set_defaults(func=cmd_run)
    s = sub.add_parser("summary", help="print the summary table of a results.jsonl")
    s.add_argument("results")
    s.add_argument("--expectations")
    s.set_defaults(func=cmd_summary)
    l = sub.add_parser("list", help="list cases")
    l.add_argument("--profile")
    l.set_defaults(func=cmd_list)
    f = sub.add_parser("fake", help="run the fake provider standalone")
    f.add_argument("--script")
    f.add_argument("--port", type=int, default=8765)
    f.add_argument("--time-scale", type=float, default=1.0)
    f.set_defaults(func=cmd_fake)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
