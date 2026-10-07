"""Case loading, execution and assertions."""

import base64
import copy
import fnmatch
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import traceback

from . import context as ctx
from . import matchers
from .context import CaseError, World
from .fake_server import FakeServer

CASES_DIR = os.path.join(ctx.ROOT, "cases")
PROFILES = ["cli", "state", "approval", "shape", "build", "ladder", "provider", "custody", "format", "exunit", "v1.2"]
V12_MANIFEST = os.path.join(ctx.ROOT, "profiles", "v1.2.json")

# §1.1: the only lines stderr may carry.
STDERR_ALLOWED = [
    re.compile(r"^shaper pass=\d+ role=[a-z_]+ \S.*$"),
    re.compile(r"^kogen: moved: account in \.kogen/project\.yaml; use kogen provider use chatgpt --as <label> --project <checkout>$"),
    re.compile(r"^land: warning: .+$"),
    re.compile(r"^kogen: warning: sandbox unavailable: .+; building unconfined$"),
]


# Behaviour profiles accept any shaper progress wording (format-07 pins it).
STDERR_ALLOWED_BEHAVIOUR = [re.compile(r"^shaper \S.*$")] + STDERR_ALLOWED[1:]


class StepFailure(Exception):
    def __init__(self, messages):
        super().__init__("; ".join(messages))
        self.messages = messages


class Skip(Exception):
    pass


# ---------------------------------------------------------------------------- loading
def load_cases(profiles=None, ids=None):
    cases = []
    selected_profiles = profiles or PROFILES
    v12_overlay = "v1.2" in selected_profiles
    superseded = {}
    replacement_ids = set()
    if v12_overlay and os.path.isfile(V12_MANIFEST):
        with open(V12_MANIFEST) as f:
            manifest = json.load(f)
        superseded = manifest.get("superseded", {})
        if ids:
            for old_id, entry in superseded.items():
                if any(fnmatch.fnmatch(old_id, pat) for pat in ids):
                    replacement_ids.add(entry["replacement"])
    for profile in PROFILES:
        if profile not in selected_profiles:
            continue
        for path in sorted(glob.glob(os.path.join(CASES_DIR, profile, "*.json"))):
            with open(path) as f:
                try:
                    case = json.load(f)
                except ValueError as e:
                    raise SystemExit("invalid case file %s: %s" % (path, e))
            case["_file"] = os.path.relpath(path, ctx.ROOT)
            case.setdefault("profile", profile)
            if v12_overlay and profile != "v1.2" and case["id"] in superseded:
                continue
            if ids and not any(fnmatch.fnmatch(case["id"], pat) for pat in ids):
                if case["id"] not in replacement_ids:
                    continue
            cases.append(case)
    return cases


def _subst_rows(value, row):
    if isinstance(value, str):
        m = re.fullmatch(r"\{row\.([A-Za-z0-9_]+)\}", value)
        if m and m.group(1) in row and not isinstance(row[m.group(1)], str):
            return row[m.group(1)]

        def repl(mm):
            key = mm.group(1)
            if key not in row:
                return mm.group(0)
            v = row[key]
            return v if isinstance(v, str) else json.dumps(v)
        return re.sub(r"\{row\.([A-Za-z0-9_]+)\}", repl, value)
    if isinstance(value, list):
        out = []
        for v in value:
            if isinstance(v, str):
                m = re.fullmatch(r"\{\*row\.([A-Za-z0-9_]+)\}", v)
                if m:
                    res = row.get(m.group(1), [])
                    out.extend(res if isinstance(res, list) else [res])
                    continue
            out.append(_subst_rows(v, row))
        return out
    if isinstance(value, dict):
        return {_subst_rows(k, row): _subst_rows(v, row) for k, v in value.items()}
    return value


def _pointer(doc, pointer):
    for part in [p for p in pointer.split("/") if p]:
        doc = doc[int(part)] if isinstance(doc, list) else doc[part]
    return doc


def generate_rows(spec):
    gen = spec.get("generator")
    if gen == "help_pages":
        rows = []
        for name in sorted(os.listdir(os.path.join(ctx.DATA, "help"))):
            words = name[: -len(".txt")].split("-")[1:]
            rows.append({"page": name, "words": words, "label": " ".join(["kogen"] + words)})
        return rows
    if gen == "help_pages_v1_2":
        rows = []
        help_dir = os.path.join(ctx.DATA, "v1.2", "help")
        for name in sorted(os.listdir(help_dir)):
            words = name[: -len(".txt")].split("-")[1:]
            if name == "kogen.txt":
                routes = [([], 0, ""), (["help"], 0, ""),
                          (["--help"], 2, "kogen: unknown command '--help'\n\n"),
                          (["help", "status"], 2, "kogen help: unexpected argument 'status'\n\n")]
            elif len(words) == 1 and words[0] in ("intent", "provider", "queue"):
                routes = [([words[0]], 0, "")]
            else:
                path = " ".join(words)
                positionals = {
                    ("intent", "shape"): ["greet", "-"],
                    ("intent", "approve"): ["greet"],
                    ("intent", "remove"): ["greet"],
                    ("status",): ["greet"],
                    ("provider", "login"): ["grok"],
                    ("provider", "logout"): ["grok"],
                    ("provider", "use"): ["grok", "--as", "default"],
                }.get(tuple(words), [])
                argv = words + positionals + ["--conformance-unknown"]
                routes = [(argv, 2, "kogen %s: unknown option '--conformance-unknown'\n\n" % path)]
            for argv, code, prefix in routes:
                rows.append({"page": name, "argv": argv, "exit": code,
                             "stdout": [prefix, {"data": "v1.2/help/" + name}],
                             "label": " ".join(["kogen"] + argv) or "kogen"})
        rows.extend([
            {"label": "provider list includes Grok", "argv": ["provider", "list"], "exit": 0,
             "stdout": "chatgpt: not signed in\ngrok: not signed in\n"},
            {"label": "logout accepts Grok", "argv": ["provider", "logout", "grok"], "exit": 0,
             "stdout": "grok:default signed out locally\n"},
            {"label": "use accepts Grok", "argv": ["provider", "use", "grok", "--as", "default"], "exit": 4,
             "stdout": "provider/login: Selected account default has no saved login; run kogen provider login <provider> to sign in\n"},
        ])
        return rows
    if "data" in spec:
        doc = ctx.load_data(spec["data"])
        items = _pointer(doc, spec.get("pointer", ""))
        rows = []
        for i, item in enumerate(items):
            row = dict(item) if isinstance(item, dict) else {"value": item}
            row.setdefault("index", i)
            rows.append(row)
        return rows
    raise CaseError("unknown rows spec %r" % spec)


def instances(case):
    """Expand a case into instances (rows)."""
    rows = case.get("rows")
    if rows is None and case.get("rows_from"):
        rows = generate_rows(case["rows_from"])
    if rows is None:
        return [(None, case)]
    zipped = case.get("rows_zip")
    if zipped:
        if len(zipped) != len(rows):
            raise CaseError("rows_zip has %d entries for %d rows" % (len(zipped), len(rows)))
        rows = [dict(r, **z) for r, z in zip(rows, zipped)]
    out = []
    body = {k: v for k, v in case.items() if k not in ("rows", "rows_from", "rows_zip")}
    for i, row in enumerate(rows):
        inst = _subst_rows(copy.deepcopy(body), row)
        label = row.get("label") or row.get("name") or str(i + 1)
        out.append(("%d:%s" % (i + 1, label), inst))
    return out


# ---------------------------------------------------------------------------- processes
class Proc:
    def __init__(self, argv, cwd, env, stdin_bytes):
        self.argv = argv
        self.start = time.time()
        self.p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.out = bytearray()
        self.err = bytearray()
        self.t_out = threading.Thread(target=self._pump, args=(self.p.stdout, self.out), daemon=True)
        self.t_err = threading.Thread(target=self._pump, args=(self.p.stderr, self.err), daemon=True)
        self.t_out.start()
        self.t_err.start()
        if stdin_bytes is not None:
            def feed():
                try:
                    self.p.stdin.write(stdin_bytes)
                    self.p.stdin.close()
                except OSError:
                    pass
            threading.Thread(target=feed, daemon=True).start()

    @staticmethod
    def _pump(stream, buf):
        while True:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not chunk:
                break
            buf.extend(chunk)

    def wait(self, timeout):
        try:
            code = self.p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill_group()
            self.p.wait()
            self.t_out.join(2)
            self.t_err.join(2)
            return None
        self.t_out.join(5)
        self.t_err.join(5)
        return code

    def kill_group(self):
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except OSError:
            pass

    @property
    def stdout(self):
        return bytes(self.out)

    @property
    def stderr(self):
        return bytes(self.err)


def sweep_processes(case_dir):
    """Kill anything still running that mentions the case dir (detached drains, stray children)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,pgid=,args="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return
    me = os.getpid()
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3 or case_dir not in parts[2]:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if pid == me:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def exit_code(rc):
    if rc is None:
        return None
    return 128 - rc if rc < 0 else rc


# ---------------------------------------------------------------------------- execution
class CaseRun:
    def __init__(self, case, opts, workdir):
        self.case = case
        self.opts = opts
        self.w = World(workdir, case, opts)
        self.bg = {}
        self.last = None
        self.used_fake = False
        self.hints = []

    # ------------------------------------------------------------------ lifecycle
    def run(self):
        c = self.case
        if c.get("fake", c.get("profile") in ("shape", "build", "ladder", "provider")):
            self.w.fake = FakeServer(time_scale=float(c.get("time_scale", self.opts.time_scale)),
                                     side_effect_cwd=self.w.dir).start()
            self.used_fake = True
        try:
            self.w.build_fixture()
            if self.w.fake:
                se = self.w.git_env()
                se.update({"ORIGIN": self.w.origin, "CHECKOUT": self.w.checkout, "CASE_DIR": self.w.dir,
                           "STATE_ROOT": self.w.state_root})
                self.w.fake.state.side_effect_env = se
                if c.get("fake_config"):
                    self.w.fake.state.config.update(c["fake_config"])
                if c.get("script") is not None:
                    self.w.fake.state.set_script(self.load_script(c["script"]))
            for i, step in enumerate(c.get("steps") or []):
                try:
                    self.step(step)
                except StepFailure as f:
                    raise StepFailure(["step %d (%s): %s" % (i + 1, _step_label(step), m) for m in f.messages])
            self.final_checks()
        finally:
            for proc in self.bg.values():
                if proc.p.poll() is None:
                    proc.kill_group()
            sweep_processes(self.w.dir)
            if self.w.fake:
                try:
                    with open(os.path.join(self.w.dir, "fake-requests.json"), "w") as f:
                        json.dump({"requests": self.w.fake.state.public_requests(), "oauth": self.w.fake.state.oauth,
                                   "remaining": self.w.fake.state.remaining(),
                                   "side_effects": self.w.fake.state.side_effect_log}, f, indent=1, default=str)
                except OSError:
                    pass
                if self.w.fake.state.requests == [] and self.expects_requests():
                    self.hints.append("no provider request reached the fake server (KOGEN_PROVIDER_URL seam missing?)")
                for r in self.w.fake.state.unmatched()[:3]:
                    tail = (r["_texts"][-1] if r["_texts"] else "")[-160:].replace("\n", " | ")
                    self.hints.append("unmatched provider request #%d role=%s turn=%s tools=%s last text: %s" % (
                        r["index"], r["role"], r["turn"], r["tools"], tail))
                self.w.fake.stop()
            if self.w.argv_log_path:
                try:
                    os.unlink(self.w.argv_log_path)
                except FileNotFoundError:
                    pass

    def expects_requests(self):
        return bool(self.case.get("script"))

    def final_checks(self):
        if not self.w.fake:
            return
        st = self.w.fake.state
        msgs = []
        unmatched = st.unmatched()
        if unmatched and not self.case.get("allow_unmatched"):
            descr = ["#%d role=%s turn=%s model=%s" % (r["index"], r["role"], r["turn"], r["body"].get("model") if isinstance(r["body"], dict) else None)
                     for r in unmatched[:5]]
            msgs.append("fake: %d unmatched request(s): %s" % (len(unmatched), ", ".join(descr)))
        remaining = st.remaining()
        if remaining and not self.case.get("allow_remaining"):
            msgs.append("fake: script steps never served: %s" % remaining)
        if msgs:
            raise StepFailure(["final: " + m for m in msgs])

    def load_script(self, script):
        steps = []
        for entry in script if isinstance(script, list) else [script]:
            if isinstance(entry, dict) and "include" in entry:
                path = os.path.join(ctx.TEMPLATES, "scripts", entry["include"] + ".json")
                with open(path) as f:
                    inc = json.load(f)
                prefix = entry.get("prefix", entry["include"])
                for s in inc:
                    s = copy.deepcopy(s)
                    s["id"] = "%s.%s" % (prefix, s.get("id", len(steps)))
                    suffix = s["id"][len(prefix) + 1:]
                    for k, v in (entry.get("override") or {}).get(suffix, {}).items():
                        s[k] = v
                    steps.append(s)
            else:
                steps.append(entry)
        return self.w.expand(steps)

    # ------------------------------------------------------------------ steps
    def step(self, step):
        kind = next(iter(step), None)
        if kind not in STEP_KINDS:
            raise CaseError("a step's first key must be one of %s: %r" % (sorted(STEP_KINDS), step))
        STEP_KINDS[kind](self, step)

    def s_write(self, step):
        spec = step["write"]
        path = self._where(spec)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if "from" in spec:
            data = ctx.template(self.w.expand(spec["from"]))
            if spec.get("expand"):
                data = self.w.expand(data.decode()).encode()
        elif "b64" in spec:
            data = base64.b64decode(spec["b64"])
        else:
            text = ctx._text(spec.get("text", ""))
            if spec.get("expand", True):
                text = self.w.expand(text)
            data = text.encode()
        if spec.get("crlf"):
            data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        mode = "ab" if spec.get("append") else "wb"
        if os.path.islink(path) and not spec.get("append"):
            os.unlink(path)
        with open(path, mode) as f:
            f.write(data)
        if spec.get("mode"):
            os.chmod(path, int(str(spec["mode"]), 8))

    def _where(self, spec):
        p = self.w.expand(spec["path"])
        if os.path.isabs(p):
            return p
        base = {"checkout": self.w.checkout, "origin": self.w.origin, "home": self.w.home, "case": self.w.dir,
                "tmp": self.w.tmp, "nowhere": self.w.nowhere}[spec.get("in", "checkout")]
        return os.path.join(base, p)

    def s_remove(self, step):
        spec = step["remove"]
        spec = {"path": spec} if isinstance(spec, str) else spec
        path = self._where(spec)
        if os.path.islink(path) or os.path.isfile(path):
            os.unlink(path)
        elif os.path.isdir(path):
            if not os.path.realpath(path).startswith(self.w.dir + os.sep):
                raise CaseError("refusing to remove %s outside the case dir" % path)
            shutil.rmtree(path)

    def s_symlink(self, step):
        spec = step["symlink"]
        path = self._where(spec)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(self.w.expand(spec["target"]), path)

    def s_intent(self, step):
        """Install an Intent from cases/_templates/intents/<template>/ (intent.md + test)."""
        spec = step["intent"]
        spec = {"slug": spec} if isinstance(spec, str) else spec
        slug = spec["slug"]
        tpl = spec.get("template", slug)
        tdir = os.path.join(ctx.TEMPLATES, "intents", tpl)
        intent = spec.get("intent_text")
        intent = ctx._text(intent).encode() if intent is not None else ctx.read_bytes(os.path.join(tdir, "intent.md"))
        test = spec.get("test_text")
        if test is not None:
            test = ctx._text(test).encode()
        else:
            cand = [n for n in os.listdir(tdir) if n.startswith("test")] if os.path.isdir(tdir) else []
            test = ctx.read_bytes(os.path.join(tdir, cand[0])) if cand else None
        for old, new in (spec.get("replace") or {}).items():
            intent = intent.replace(old.encode(), new.encode())
            if test is not None:
                test = test.replace(old.encode(), new.encode())
        ipath = self.w.intent_path(slug)
        os.makedirs(os.path.dirname(ipath), exist_ok=True)
        with open(ipath, "wb") as f:
            f.write(intent)
        if test is not None and spec.get("test", True):
            tpath = self.w.acceptance_source(slug)
            os.makedirs(os.path.dirname(tpath), exist_ok=True)
            with open(tpath, "wb") as f:
                f.write(test)
        if spec.get("commit", True):
            self.w.git(["add", "-A", ".kogen"])
            self.w.git(["commit", "-q", "-m", spec.get("message", "Add %s Intent" % slug)])
        if spec.get("push"):
            self.w.git(["push", "-q", "origin", "HEAD:refs/heads/" + self.w.base])

    def s_commit(self, step):
        spec = step["commit"]
        spec = {"message": spec} if isinstance(spec, str) else spec
        cwd = self.w.checkout if spec.get("in", "checkout") == "checkout" else self.w.origin
        if spec.get("paths"):
            self.w.git(["add", "-A", "--"] + self.w.expand(spec["paths"]), cwd=cwd)
        else:
            self.w.git(["add", "-A"], cwd=cwd)
        args = ["commit", "-q", "-m", self.w.expand(spec["message"])]
        if spec.get("allow_empty"):
            args.append("--allow-empty")
        self.w.git(args, cwd=cwd)
        if spec.get("push"):
            self.w.git(["push", "-q", "origin", "HEAD:refs/heads/" + self.w.base], cwd=cwd)

    def s_push(self, step):
        spec = step["push"]
        ref = spec if isinstance(spec, str) else "HEAD:refs/heads/" + self.w.base
        self.w.git(["push", "-q", "origin", self.w.expand(ref)])

    def s_origin_commit(self, step):
        """Commit files directly on the origin's base branch (moves the base)."""
        spec = step["origin_commit"]
        tmp = os.path.join(self.w.dir, "origin-work-%d" % int(time.time() * 1e6))
        self.w.git(["clone", "-q", self.w.origin, tmp], cwd=self.w.dir)
        for rel, text in (spec.get("files") or {}).items():
            full = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(self.w.expand(ctx._text(text)))
        for rel in spec.get("delete") or []:
            os.unlink(os.path.join(tmp, rel))
        self.w.git(["add", "-A"], cwd=tmp)
        self.w.git(["commit", "-q", "-m", spec.get("message", "Move the base")], cwd=tmp)
        self.w.git(["push", "-q", "origin", "HEAD:refs/heads/" + self.w.base], cwd=tmp)
        shutil.rmtree(tmp)
        if spec.get("pull"):
            self.w.git(["pull", "-q", "--ff-only"])

    def s_git(self, step):
        args = self.w.expand(step["git"])
        where = step.get("in", "checkout")
        cwd = {"checkout": self.w.checkout, "origin": self.w.origin, "case": self.w.dir}[where]
        env = self.w.git_env()
        proc = subprocess.run(["git"] + args, cwd=cwd, env=env, capture_output=True,
                              input=self.w.expand(step["stdin"]).encode() if "stdin" in step else None)
        result = {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
        expect = step.get("expect", {"exit": 0})
        msgs = self.check_expect(result, expect, stderr_rule=False)
        if msgs:
            raise StepFailure(["git %s: %s" % (" ".join(args), m) for m in msgs])
        self.capture(step, proc.stdout.decode(errors="replace"))

    def s_sh(self, step):
        script = self.w.expand(step["sh"])
        where = step.get("in", "checkout")
        cwd = {"checkout": self.w.checkout, "origin": self.w.origin, "case": self.w.dir, "home": self.w.home,
               "nowhere": self.w.nowhere}[where]
        env = self.w.git_env()
        env.update({"ORIGIN": self.w.origin, "CHECKOUT": self.w.checkout, "CASE_DIR": self.w.dir,
                    "STATE_ROOT": self.w.state_root, "KOGEN": self.opts.kogen})
        proc = subprocess.run(["sh", "-c", script], cwd=cwd, env=env, capture_output=True,
                              timeout=step.get("timeout", 120))
        result = {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
        msgs = self.check_expect(result, step.get("expect", {"exit": 0}), stderr_rule=False)
        if msgs:
            raise StepFailure(["sh: %s (stderr: %s)" % (m, proc.stderr.decode(errors="replace")[-300:]) for m in msgs])
        self.capture(step, proc.stdout.decode(errors="replace"))

    def s_sleep(self, step):
        time.sleep(float(step["sleep"]))

    def s_fake(self, step):
        spec = step["fake"]
        if not self.w.fake:
            raise CaseError("case has no fake server (set \"fake\": true)")
        if spec.get("reset"):
            self.w.fake.state.reset()
        if "script" in spec:
            self.w.fake.state.set_script(self.load_script(spec["script"]))
        if "append" in spec:
            self.w.fake.state.append_script(self.load_script(spec["append"]))
        if "config" in spec:
            self.w.fake.state.config.update(spec["config"])

    def s_auth(self, step):
        spec = step["auth"]
        self.w.write_injected_auth(expired=spec.get("expired", False))

    def s_approve(self, step):
        spec = step["approve"]
        spec = {"slug": spec} if isinstance(spec, str) else spec
        slug = spec["slug"]
        argv = ["kogen", "intent", "approve", slug, "{hash8:%s}" % slug] + spec.get("args", [])
        self.s_run({"run": argv, "expect": spec.get("expect", {"exit": 0, "stdout_regex": r"approved %s [0-9a-f]{8} \(approval [0-9a-f]{8}\); it is queued\n" % re.escape(slug)})})

    def s_run(self, step):
        argv = self._argv(step["run"])
        cwd = self._cwd(step)
        env = self.w.env(self.w.expand(step.get("env") or {}))
        for k in step.get("unset_env") or []:
            env.pop(k, None)
        stdin = None
        if "stdin" in step:
            stdin = self.w.expand(ctx._text(step["stdin"])).encode()
        elif "stdin_b64" in step:
            stdin = base64.b64decode(step["stdin_b64"])
        proc = Proc(argv, cwd, env, stdin)
        if step.get("background"):
            self.bg[step["background"]] = proc
            return
        if step.get("signal"):
            self._deliver_signal(proc, step["signal"])
        code = proc.wait(step.get("timeout", self.opts.run_timeout))
        result = {"exit": exit_code(code), "stdout": proc.stdout, "stderr": proc.stderr, "timed_out": code is None,
                  "wall_ms": int((time.time() - proc.start) * 1000)}
        self.last = result
        self.w.vars["last_stdout"] = proc.stdout.decode(errors="replace")
        msgs = self.check_expect(result, step.get("expect", {}))
        if msgs:
            raise StepFailure(["`%s`: %s" % (" ".join(step["run"]), m) for m in msgs] +
                              (["stdout was: %r" % _clip(proc.stdout)] if not step.get("quiet") else []) +
                              (["stderr was: %r" % _clip(proc.stderr)] if proc.stderr else []))
        self.capture(step, proc.stdout.decode(errors="replace"))

    def _argv(self, argv):
        argv = self.w.expand(argv)
        if argv and argv[0] == "kogen":
            argv = [self.opts.kogen] + argv[1:]
        return argv

    def _cwd(self, step):
        where = step.get("cwd", "checkout" if self.case.get("fixture", "kt") != "none" else "nowhere")
        named = {"checkout": self.w.checkout, "origin": self.w.origin, "case": self.w.dir, "home": self.w.home,
                 "nowhere": self.w.nowhere, "tmp": self.w.tmp}
        if where in named:
            return named[where]
        return self.w.path(where)

    def _deliver_signal(self, proc, spec):
        sig = getattr(signal, "SIG" + spec.get("sig", "INT"))
        cond = spec.get("when")
        if cond:
            self.wait_until(cond, proc=proc)
        else:
            time.sleep(float(spec.get("after_s", 1.0)))
        target = spec.get("target", "pid")
        try:
            if target == "group":
                os.killpg(proc.p.pid, sig)
            else:
                os.kill(proc.p.pid, sig)
        except OSError:
            pass
        self.w.vars["signal_ms"] = str(int(time.time() * 1000))

    def s_signal(self, step):
        spec = step["signal"]
        proc = self.bg[spec["name"]]
        self._deliver_signal(proc, spec)

    def s_wait(self, step):
        spec = step["wait"]
        spec = {"name": spec} if isinstance(spec, str) else spec
        proc = self.bg[spec["name"]]
        code = proc.wait(spec.get("timeout", self.opts.run_timeout))
        result = {"exit": exit_code(code), "stdout": proc.stdout, "stderr": proc.stderr, "timed_out": code is None,
                  "wall_ms": int((time.time() - proc.start) * 1000)}
        self.last = result
        self.w.vars["last_stdout"] = proc.stdout.decode(errors="replace")
        msgs = self.check_expect(result, spec.get("expect", {}))
        if msgs:
            raise StepFailure(["wait %s: %s" % (spec["name"], m) for m in msgs] +
                              ["stdout was: %r" % _clip(proc.stdout)] +
                              (["stderr was: %r" % _clip(proc.stderr)] if proc.stderr else []))
        self.capture(spec, proc.stdout.decode(errors="replace"))

    def s_wait_until(self, step):
        self.wait_until(step["wait_until"])

    def wait_until(self, cond, proc=None):
        timeout = float(cond.get("timeout_s", 60))
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._cond(cond, proc):
                return
            time.sleep(0.05)
        raise StepFailure(["condition not reached within %ss: %s" % (timeout, json.dumps({k: v for k, v in cond.items() if k != "timeout_s"}))])

    def _cond(self, cond, proc):
        if "file_exists" in cond:
            return bool(glob.glob(self.w.path(cond["file_exists"])))
        if "stdout_contains" in cond:
            p = self.bg.get(cond.get("name")) if cond.get("name") else proc
            return p is not None and self.w.expand(cond["stdout_contains"]).encode() in p.stdout
        if "event" in cond:
            try:
                _s, run_dir, _d = self.w.latest_run(cond.get("slug", "greet"))
            except CaseError:
                return False
            return any(e.get("event") == cond["event"] for e in self.w.events(run_dir))
        if "fake_requests" in cond:
            reqs = self.w.fake.state.requests if self.w.fake else []
            role = cond.get("role")
            return len([r for r in reqs if role is None or r["role"] == role]) >= int(cond["fake_requests"])
        if "exited" in cond:
            return self.bg[cond["exited"]].p.poll() is not None
        raise CaseError("unknown wait condition %r" % cond)

    def s_capture(self, step):
        spec = step["capture"]
        src = spec.get("from", "last_stdout")
        if src == "last_stdout":
            text = self.w.vars.get("last_stdout", "")
        elif src == "file":
            text = open(self.w.path(spec["path"]), errors="replace").read()
        elif src == "git":
            text = self.w.git(self.w.expand(spec["args"]), cwd=self.w.origin if spec.get("in") == "origin" else self.w.checkout)
        else:
            raise CaseError("unknown capture source %r" % src)
        self.capture({"capture": spec.get("vars") or {spec["var"]: spec.get("regex", r"(?s)(.*)")}}, text)

    def capture(self, step, text):
        cap = step.get("capture")
        if not isinstance(cap, dict):
            return
        for name, regex in cap.items():
            m = re.search(regex, text, re.M)
            if not m:
                raise StepFailure(["capture %s: /%s/ not found in %r" % (name, regex, _clip(text.encode()))])
            self.w.vars[name] = m.group(1) if m.groups() else m.group(0)

    def s_snapshot(self, step):
        name = step["snapshot"]
        self.w.vars["snapshot:" + name] = self._checkout_state()

    def _checkout_state(self):
        head = self.w.git(["rev-parse", "HEAD"]).strip()
        status = self.w.git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"])
        index = self.w.git(["ls-files", "-s"])
        tree_files = self.w.git(["ls-files", "-m"])
        refs = subprocess.run(["git", "for-each-ref", "--format=%(refname) %(objectname)"], cwd=self.w.origin,
                              env=self.w.git_env(), capture_output=True).stdout.decode()
        return json.dumps({"head": head, "status": status, "index": index, "modified": tree_files})

    def s_assert(self, step):
        msgs = self.assertions(step["assert"])
        if msgs:
            raise StepFailure(msgs)

    def s_eventually(self, step):
        """Retry an assert block until it holds or times out."""
        spec = step["eventually"]
        deadline = time.time() + float(spec.get("timeout_s", 10))
        while True:
            msgs = self.assertions(spec["assert"])
            if not msgs:
                return
            if time.time() > deadline:
                raise StepFailure(msgs)
            time.sleep(0.1)

    def s_synthetic_run(self, step):
        """Write a finished (or running) run dir in the §2.8 format, for status derivation cases."""
        spec = self.w.expand(step["synthetic_run"])
        slug = spec["slug"]
        run_id = spec["run_id"]
        run_dir = os.path.join(self.w.state_root, "runs", run_id)
        os.makedirs(os.path.join(run_dir, "logs"), exist_ok=True)
        now = int(time.time() * 1000)
        started = now - int(spec.get("age_ms", 120000))
        status = spec.get("status", "failed")
        approval_commit = spec.get("approval_commit") or self.w.ref_value("refs/kogen/intents/" + slug)
        dead = subprocess.Popen(["true"])
        dead.wait()
        run = {"schema": 2, "run_id": run_id, "slug": slug, "approval_sha256": self.w.approval_hash(slug),
               "approval_commit": approval_commit, "target_branch": self.w.base, "status": status,
               "landing": spec.get("landing"), "owner_pid": spec.get("owner_pid", dead.pid),
               "owner_started_ms": started, "started_ms": started}
        events = [{"event": "started", "ts": started, "approval_commit": approval_commit, "approved_by": "Kogen Test <test@kogen.invalid>",
                   "base_sha": self.w.ref_value("refs/heads/" + self.w.base), "recipe": "ladder", "max_rungs": 3, "roles": {},
                   "land": "green-or-advisory", "budget_ms": 3600000, "credential_source": "injected",
                   "credential_label": "default", "sandbox": "confined"}]
        ts = started
        for ev in spec.get("events") or []:
            ts += 1000
            events.append(dict({"ts": ts}, **ev))
        if status != "running" or spec.get("finished"):
            ts += 1000
            events.append({"event": "finished", "ts": ts, "status": status, "reason": spec.get("reason"),
                           "rung": spec.get("rung"), "verdict": spec.get("verdict", "none"), "advisory_items": []})
        with open(os.path.join(run_dir, "run.json"), "w") as f:
            json.dump(run, f, separators=(",", ":"))
        with open(os.path.join(run_dir, "events.jsonl"), "w") as f:
            for ev in events:
                f.write(json.dumps(ev, separators=(",", ":")) + "\n")
        if spec.get("candidate_diff"):
            path = os.path.join(run_dir, "candidate.diff")
            with open(path, "w") as f:
                f.write(spec["candidate_diff"] if isinstance(spec["candidate_diff"], str) else "")
            os.chmod(path, 0o600)
        if spec.get("mtime_ms"):
            os.utime(os.path.join(run_dir, "run.json"), (spec["mtime_ms"] / 1000.0, spec["mtime_ms"] / 1000.0))

    def s_skip_if(self, step):
        spec = step["skip_if"]
        if spec.get("platform") and os.uname().sysname.lower() == spec["platform"]:
            raise Skip(spec.get("reason", "skipped on " + spec["platform"]))

    # ------------------------------------------------------------------ expectations
    def check_expect(self, result, expect, stderr_rule=True):
        msgs = []
        try:
            expect = self.w.expand(expect)
        except CaseError as e:
            return ["cannot evaluate the expectation: %s" % e]
        out_b, err_b = result["stdout"], result["stderr"]
        out = out_b.decode("utf-8", errors="replace")
        err = err_b.decode("utf-8", errors="replace")
        if result.get("timed_out"):
            msgs.append("timed out")
        if "exit" in expect:
            want = expect["exit"]
            if (result["exit"] not in want) if isinstance(want, list) else result["exit"] != want:
                msgs.append("exit %s, expected %s" % (result["exit"], want))
        if "stdout" in expect:
            want = self.golden(expect["stdout"])
            if out != want:
                msgs.append("stdout differs from expected %r%s" % (_clip(want.encode()), _first_diff(want, out)))
        if "stdout_regex" in expect:
            for rx in _as_list(expect["stdout_regex"]):
                if re.search(rx, out) is None:
                    msgs.append("stdout does not match /%s/" % rx)
        if "stdout_not_regex" in expect:
            for rx in _as_list(expect["stdout_not_regex"]):
                if re.search(rx, out) is not None:
                    msgs.append("stdout must not match /%s/" % rx)
        if "stdout_lines" in expect:
            msgs += _check_lines("stdout", out, expect["stdout_lines"])
        if "stdout_starts_lines" in expect:
            msgs += _check_lines("stdout", out, expect["stdout_starts_lines"], prefix=True)
        for needle in _as_list(expect.get("stdout_contains")):
            if needle not in out:
                msgs.append("stdout does not contain %r" % needle)
        for needle in _as_list(expect.get("stdout_not_contains")):
            if needle in out:
                msgs.append("stdout must not contain %r" % needle)
        if "stdout_json" in expect:
            try:
                doc = json.loads(out)
            except ValueError as e:
                msgs.append("stdout is not one JSON value: %s" % e)
            else:
                if out.count("\n") != 1 or not out.endswith("\n"):
                    msgs.append("stdout JSON must be exactly one line")
                msgs += ["stdout json " + m for m in matchers.match(expect["stdout_json"], doc)]
        if "stdout_jsonl" in expect:
            docs = []
            for line in out.splitlines():
                try:
                    docs.append(json.loads(line))
                except ValueError:
                    msgs.append("stdout line is not JSON: %r" % line)
            msgs += ["stdout jsonl " + m for m in matchers.match(expect["stdout_jsonl"], docs)]
        if expect.get("stdout_empty") and out:
            msgs.append("stdout must be empty")
        if expect.get("utf8_lines", True) and result.get("exit") is not None:
            if b"\r" in out_b:
                msgs.append("stdout contains \\r (§1.1)")
            if out and not out.endswith("\n"):
                msgs.append("stdout does not end with \\n (§1.1)")
            trailing = [l for l in out.split("\n") if l.endswith(" ")]
            if trailing and expect.get("no_trailing_spaces", True):
                msgs.append("stdout has trailing spaces on %d line(s), e.g. %r (§1.1)" % (len(trailing), trailing[0]))
        # stderr
        if "stderr" in expect:
            want = self.golden(expect["stderr"])
            if err != want:
                msgs.append("stderr %r, expected %r" % (_clip(err_b), _clip(want.encode())))
        if "stderr_lines" in expect:
            msgs += _check_lines("stderr", err, expect["stderr_lines"])
        for needle in _as_list(expect.get("stderr_contains")):
            if needle not in err:
                msgs.append("stderr does not contain %r" % needle)
        for rx in _as_list(expect.get("stderr_regex")):
            if re.search(rx, err) is None:
                msgs.append("stderr does not match /%s/" % rx)
        if stderr_rule and not expect.get("stderr_any") and "stderr" not in expect:
            # §1.1 line kinds everywhere; their exact wording is pinned only in the format profile.
            allowed = STDERR_ALLOWED if self.case.get("profile") == "format" else STDERR_ALLOWED_BEHAVIOUR
            bad = [l for l in err.splitlines() if not any(p.match(l) for p in allowed)]
            if bad:
                msgs.append("stderr carries lines outside the §1.1 list: %r" % bad[:3])
        if "watch_frames" in expect:
            wf = expect["watch_frames"]
            frames = [f for f in out.split("\n\n")] if out else []
            if out.endswith("\n") and frames:
                frames[-1] = frames[-1][:-1] if frames[-1].endswith("\n") else frames[-1]
            if len(frames) < wf.get("min", 1):
                msgs.append("watch printed %d frame(s), expected at least %d" % (len(frames), wf.get("min", 1)))
            if "max" in wf and len(frames) > wf["max"]:
                msgs.append("watch printed %d frame(s), expected at most %d" % (len(frames), wf["max"]))
            if wf.get("distinct_consecutive", True):
                for i in range(1, len(frames)):
                    if frames[i] == frames[i - 1]:
                        msgs.append("watch frames %d and %d are identical (frames print only on change)" % (i, i + 1))
            for needle in _as_list(wf.get("last_contains")):
                if not frames or needle not in frames[-1]:
                    msgs.append("last watch frame does not contain %r" % needle)
            for needle in _as_list(wf.get("first_contains")):
                if not frames or needle not in frames[0]:
                    msgs.append("first watch frame does not contain %r" % needle)
        if "max_wall_ms" in expect and result.get("wall_ms", 0) > expect["max_wall_ms"]:
            msgs.append("took %d ms, limit %d ms" % (result["wall_ms"], expect["max_wall_ms"]))
        return msgs

    def golden(self, spec):
        if isinstance(spec, str):
            return spec
        if isinstance(spec, dict):
            if "data" in spec:
                return ctx.load_data(spec["data"])
            if "lines" in spec:
                return "".join(l + "\n" for l in spec["lines"])
        if isinstance(spec, list):
            return "".join(self.golden(p) for p in spec)
        raise CaseError("bad golden %r" % spec)

    # ------------------------------------------------------------------ assertions
    def assertions(self, spec):
        try:
            spec = self.w.expand(spec)
        except CaseError as e:
            return ["cannot evaluate the assertion: %s" % e]
        msgs = []
        for path, fs in (spec.get("files") or {}).items():
            msgs += self._file_assert(path, fs)
        for pattern, n in (spec.get("glob_count") or {}).items():
            got = len(glob.glob(self.w.path(pattern)))
            if not matchers.match(n, got) == []:
                msgs.append("glob %s: %d matches, expected %s" % (pattern, got, n))
        where = spec.get("refs_in", "origin")
        for ref, want in (spec.get("refs") or {}).items():
            val = self.w.ref_value(ref, where=where)
            if want is True and not val:
                msgs.append("ref %s is missing in %s" % (ref, where))
            elif want is False and val:
                msgs.append("ref %s exists in %s (%s), expected absent" % (ref, where, val))
            elif isinstance(want, str) and not (val and not matchers.match(want, val)):
                msgs.append("ref %s = %s, expected %s" % (ref, val, want))
        for prefix, n in (spec.get("ref_count") or {}).items():
            got = len(self.w.refs_with_prefix(prefix, where=where))
            if matchers.match(n, got):
                msgs.append("refs under %s: %d, expected %s" % (prefix, got, n))
        for g in spec.get("git") or []:
            cwd = {"origin": self.w.origin, "checkout": self.w.checkout}[g.get("in", "origin")]
            proc = subprocess.run(["git"] + g["args"], cwd=cwd, env=self.w.git_env(), capture_output=True)
            res = {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
            if "json" in g:
                try:
                    doc = json.loads(proc.stdout.decode("utf-8", errors="replace"))
                    msgs += ["git %s json %s" % (" ".join(g["args"]), m) for m in matchers.match(g["json"], doc)]
                except ValueError as e:
                    msgs.append("git %s: output is not JSON (%s)" % (" ".join(g["args"]), e))
            exp = {k: v for k, v in g.items() if k not in ("args", "in", "json")}
            exp.setdefault("exit", 0)
            exp["utf8_lines"] = False
            msgs += ["git %s: %s" % (" ".join(g["args"]), m) for m in self.check_expect(res, exp, stderr_rule=False)]
        if "events" in spec:
            msgs += self._events_assert(spec["events"])
        if "run_json" in spec:
            rj = spec["run_json"]
            try:
                _s, run_dir, doc = self.w.latest_run(rj.get("slug", "greet"))
                msgs += ["run.json " + m for m in matchers.match(rj["match"], doc)]
            except CaseError as e:
                msgs.append(str(e))
        if "runs_count" in spec:
            for slug, n in spec["runs_count"].items():
                got = len(self.w.runs(slug if slug != "*" else None))
                if matchers.match(n, got):
                    msgs.append("runs for %s: %d, expected %s" % (slug, got, n))
        if "fake_requests" in spec:
            msgs += self._fake_assert(spec["fake_requests"])
        if "fake_request_sequences" in spec:
            msgs += self._fake_request_sequences(spec["fake_request_sequences"])
        if "fake_request_count" in spec:
            reqs = self.w.fake.state.requests if self.w.fake else []
            want = spec["fake_request_count"]
            if isinstance(want, dict) and not any(k.startswith("$") for k in want):
                for role, n in want.items():
                    got = len([r for r in reqs if role == "*" or r["role"] == role])
                    if matchers.match(n, got):
                        msgs.append("fake requests with role %s: %d, expected %s" % (role, got, n))
            elif matchers.match(want, len(reqs)):
                msgs.append("fake requests: %d, expected %s" % (len(reqs), want))
        if "fake_remaining" in spec:
            rem = self.w.fake.state.remaining() if self.w.fake else []
            if rem != spec["fake_remaining"]:
                msgs.append("fake remaining %s, expected %s" % (rem, spec["fake_remaining"]))
        if "prompt_cache_keys" in spec:
            # §4.1: prompt_cache_key = sha256("kogen:responses:v1\0" + run dir + "\0" + stage), stages from model_stage events.
            pk = spec["prompt_cache_keys"]
            try:
                _s, run_dir, _d = self.w.latest_run(pk.get("slug", "greet"))
                stages = {e.get("stage") for e in self.w.events(run_dir) if e.get("event") == "model_stage" and isinstance(e.get("stage"), str)}
                allowed = {ctx.sha256_hex(b"kogen:responses:v1\0" + run_dir.encode() + b"\0" + st.encode()): st for st in stages}
                if not stages:
                    msgs.append("prompt_cache_key: no model_stage stages in the journal")
                for r in (self.w.fake.state.requests if self.w.fake else []):
                    key = r["body"].get("prompt_cache_key") if isinstance(r["body"], dict) else None
                    if key not in allowed:
                        msgs.append("prompt_cache_key %r of request #%d (%s) matches no stage in %s" % (key, r["index"], r["role"], sorted(stages)))
            except CaseError as e:
                msgs.append(str(e))
        if "fake_oauth_count" in spec:
            oauth = self.w.fake.state.oauth if self.w.fake else []
            for kind, n in spec["fake_oauth_count"].items():
                got = len([o for o in oauth if o["kind"] == kind])
                if matchers.match(n, got):
                    msgs.append("fake oauth %s requests: %d, expected %s" % (kind, got, n))
        if "fake_oauth" in spec:
            oauth = self.w.fake.state.oauth if self.w.fake else []
            msgs += ["oauth " + m for m in matchers.match(spec["fake_oauth"], oauth)]
        if spec.get("checkout_clean"):
            st = self.w.git(["status", "--porcelain=v1", "--untracked-files=all"])
            if st.strip():
                msgs.append("checkout is not clean: %r" % st[:300])
        if "checkout_unchanged" in spec:
            before = self.w.vars.get("snapshot:" + spec["checkout_unchanged"])
            if before != self._checkout_state():
                msgs.append("checkout changed since snapshot %s" % spec["checkout_unchanged"])
        if "json_file_lines" in spec:
            for path, m in spec["json_file_lines"].items():
                msgs += self._file_assert(path, {"jsonl": m})
        if "argv_max" in spec:
            argv_log = self.case.get("argv_log")
            if self.w.argv_log_path:
                path = self.w.argv_log_path
            elif isinstance(argv_log, dict) and argv_log.get("path"):
                path = self.w.expand(argv_log["path"])
            else:
                path = os.path.join(self.w.stubs, "argv.log")
            worst = 0
            if os.path.exists(path):
                for line in open(path):
                    worst = max(worst, json.loads(line)["max"])
            if worst > spec["argv_max"]:
                msgs.append("an argv element of %d bytes was passed to sh/git (limit %d)" % (worst, spec["argv_max"]))
        if "vars" in spec:
            for name, m in spec["vars"].items():
                msgs += ["var %s: %s" % (name, e) for e in matchers.match(m, self.w.vars.get(name))]
        return msgs

    def _file_assert(self, path, fs):
        full = self.w.path(path)
        msgs = []
        exists = os.path.lexists(full)
        if fs is False or fs == {"exists": False}:
            if exists:
                msgs.append("%s exists, expected absent" % path)
            return msgs
        if fs is True:
            fs = {"exists": True}
        if not exists:
            if fs.get("exists", True):
                msgs.append("%s does not exist" % path)
            return msgs
        if fs.get("exists") is False:
            msgs.append("%s exists, expected absent" % path)
            return msgs
        if "is_symlink" in fs and os.path.islink(full) != fs["is_symlink"]:
            msgs.append("%s symlink=%s, expected %s" % (path, os.path.islink(full), fs["is_symlink"]))
        if "link_target" in fs and (not os.path.islink(full) or os.readlink(full) != fs["link_target"]):
            msgs.append("%s link target %r, expected %r" % (path, os.readlink(full) if os.path.islink(full) else None, fs["link_target"]))
        if "mode" in fs:
            mode = os.stat(full).st_mode & 0o777
            if mode != int(str(fs["mode"]), 8):
                msgs.append("%s mode %o, expected %s" % (path, mode, fs["mode"]))
        if "executable" in fs and bool(os.stat(full).st_mode & 0o100) != fs["executable"]:
            msgs.append("%s executable=%s" % (path, not fs["executable"]))
        if os.path.isdir(full):
            if "entries" in fs:
                got = sorted(os.listdir(full))
                msgs += ["%s entries %s" % (path, m) for m in matchers.match(fs["entries"], got)]
            return msgs
        data = ctx.read_bytes(full)
        text = data.decode("utf-8", errors="replace")
        if "text" in fs and text != self.golden(fs["text"]):
            msgs.append("%s content %r, expected %r" % (path, _clip(data), _clip(self.golden(fs["text"]).encode())))
        if "bytes_b64" in fs and data != base64.b64decode(fs["bytes_b64"]):
            msgs.append("%s bytes differ" % path)
        if "same_as" in fs:
            other = self.w.path(fs["same_as"])
            if not os.path.exists(other) or ctx.read_bytes(other) != data:
                msgs.append("%s differs from %s" % (path, fs["same_as"]))
        for rx in _as_list(fs.get("regex")):
            if re.search(rx, text, re.M) is None:
                msgs.append("%s does not match /%s/" % (path, rx))
        for needle in _as_list(fs.get("contains")):
            if needle not in text:
                msgs.append("%s does not contain %r" % (path, needle))
        for needle in _as_list(fs.get("not_contains")):
            if needle in text:
                msgs.append("%s must not contain %r" % (path, needle))
        if "json" in fs:
            try:
                doc = json.loads(text)
                msgs += ["%s %s" % (path, m) for m in matchers.match(fs["json"], doc)]
            except ValueError as e:
                msgs.append("%s is not JSON: %s" % (path, e))
        if "jsonl" in fs:
            docs = []
            for line in text.splitlines():
                try:
                    docs.append(json.loads(line))
                except ValueError:
                    msgs.append("%s has a non-JSON line %r" % (path, line[:120]))
            msgs += ["%s %s" % (path, m) for m in matchers.match(fs["jsonl"], docs)]
        if "lines" in fs:
            msgs += _check_lines(path, text, fs["lines"])
        return msgs

    def _events_assert(self, spec):
        msgs = []
        slug = spec.get("slug", "greet")
        try:
            runs = self.w.runs(slug)
            if not runs:
                return ["no run for %s" % slug]
            idx = spec.get("run", -1)
            _s, run_dir, _doc = runs[idx]
        except (CaseError, IndexError) as e:
            return [str(e)]
        events = self.w.events(run_dir)
        names = [e.get("event") for e in events]
        if "subsequence" in spec:
            pos = 0
            for want in spec["subsequence"]:
                m = {"event": want} if isinstance(want, str) else want
                while pos < len(events) and matchers.match(m, events[pos]):
                    pos += 1
                if pos >= len(events):
                    msgs.append("journal: %s not found in order; journal was %s" % (json.dumps(m), names))
                    break
                pos += 1
        for name in spec.get("absent") or []:
            if name in names:
                msgs.append("journal: unexpected %s event" % name)
        for name, n in (spec.get("count") or {}).items():
            got = names.count(name)
            if matchers.match(n, got):
                msgs.append("journal: %d %s event(s), expected %s" % (got, name, n))
        if "each" in spec:
            for i, e in enumerate(events):
                for m in matchers.match(spec["each"], e):
                    msgs.append("journal[%d] %s" % (i, m))
        if "all" in spec:
            msgs += ["journal " + m for m in matchers.match(spec["all"], events)]
        for want in spec.get("contains") or []:
            if not any(not matchers.match(want, e) for e in events):
                msgs.append("journal: no event matches %s" % json.dumps(want))
        if "first" in spec:
            msgs += ["journal first " + m for m in matchers.match(spec["first"], events[0] if events else None)]
        if "last" in spec:
            msgs += ["journal last " + m for m in matchers.match(spec["last"], events[-1] if events else None)]
        if "sequence_equal" in spec:
            # Compare event-name sequences (and key sets) of two runs, ignoring ids and ts (§C.3 determinism).
            a, b = spec["sequence_equal"]
            try:
                ea = self.w.events(runs[a][1])
                eb = self.w.events(runs[b][1])
            except IndexError:
                return msgs + ["journal: sequence_equal needs runs %s and %s; %d run(s) exist" % (a, b, len(runs))]
            sa = [(e.get("event"), sorted(k for k in e if k not in ("ts",))) for e in ea]
            sb = [(e.get("event"), sorted(k for k in e if k not in ("ts",))) for e in eb]
            if sa != sb:
                msgs.append("journal: runs %s and %s differ: %s vs %s" % (a, b, [x[0] for x in sa], [x[0] for x in sb]))
        return msgs

    def _fake_assert(self, specs):
        msgs = []
        reqs = self.w.fake.state.public_requests() if self.w.fake else []
        for spec in specs:
            sel = spec.get("select", {})
            cand = [r for r in reqs if all(r.get(k) == v for k, v in sel.items() if k != "nth")]
            nth = sel.get("nth", 0)
            if nth >= len(cand) or -nth > len(cand):
                msgs.append("fake: no request #%d matching %s (%d requests seen: %s)" % (
                    nth, sel, len(reqs), [(r["role"], r["turn"], r["step"]) for r in reqs]))
                continue
            r = cand[nth]
            if "match" in spec:
                msgs += ["fake request %s: %s" % (sel, m) for m in matchers.match(spec["match"], r)]
            texts = "\n".join(_texts_of(r["body"]))
            for needle in _as_list(spec.get("input_contains")):
                if needle not in texts:
                    msgs.append("fake request %s: input does not contain %r" % (sel, needle))
            for needle in _as_list(spec.get("input_not_contains")):
                if needle in texts:
                    msgs.append("fake request %s: input must not contain %r" % (sel, needle))
            for rx in _as_list(spec.get("input_regex")):
                if re.search(rx, texts, re.M) is None:
                    msgs.append("fake request %s: input does not match /%s/" % (sel, rx))
            if "first_user_text" in spec:
                items = [i for i in (r["body"].get("input") or []) if isinstance(i, dict) and i.get("role") == "user"]
                txt = "\n".join(_texts_of({"input": items[:1]}))
                want = self.golden(spec["first_user_text"])
                if txt != want:
                    msgs.append("fake request %s: first user message %r, expected %r%s" % (sel, _clip(txt.encode()), _clip(want.encode()), _first_diff(want, txt)))
        return msgs

    def _fake_request_sequences(self, specs):
        """Relational checks over ordered fake-provider requests (including raw HTTP body bytes)."""
        msgs = []
        reqs = self.w.fake.state.public_requests() if self.w.fake else []
        for seq in specs:
            selected = []
            for sel in seq.get("select", []):
                cand = [r for r in reqs if all(r.get(k) == v for k, v in sel.items() if k != "nth")]
                nth = sel.get("nth", 0)
                if nth >= len(cand) or -nth > len(cand):
                    msgs.append("fake sequence: no request matching %s (%d requests seen: %s)" % (
                        sel, len(reqs), [(r["role"], r["turn"], r["step"]) for r in reqs]))
                    selected = []
                    break
                selected.append(cand[nth])
            if not selected:
                continue
            label = seq.get("label", "requests " + ", ".join(str(r.get("step")) for r in selected))
            bodies = [r.get("body") if isinstance(r.get("body"), dict) else {} for r in selected]
            if seq.get("byte_prefix"):
                for i in range(1, len(selected)):
                    try:
                        previous = base64.b64decode(selected[i - 1]["body_raw_b64"], validate=True)
                        current = base64.b64decode(selected[i]["body_raw_b64"], validate=True)
                    except (KeyError, ValueError) as e:
                        msgs.append("fake sequence %s: raw body bytes unavailable (%s)" % (label, e))
                        break
                    suffix = base64.b64decode(seq.get("strip_suffix_b64", "XX0="), validate=True)
                    next_byte = seq.get("next_byte", ",").encode("utf-8")
                    if not previous.endswith(suffix):
                        msgs.append("fake sequence %s: earlier body does not end with %r" % (label, suffix))
                    elif not current.startswith(previous[:-len(suffix)] + next_byte):
                        msgs.append("fake sequence %s: next body is not the earlier body without %r plus %r as a byte prefix" % (
                            label, suffix, next_byte))
            if seq.get("input_prefix"):
                for i in range(1, len(bodies)):
                    before = bodies[i - 1].get("input")
                    after = bodies[i].get("input")
                    if not isinstance(before, list) or not isinstance(after, list) or after[:len(before)] != before:
                        msgs.append("fake sequence %s: earlier input items are not an unchanged prefix" % label)
            for field in seq.get("stable_body_fields", []):
                values = [_nested_value(body, field) for body in bodies]
                if any(value != values[0] for value in values[1:]):
                    msgs.append("fake sequence %s: body field %s changed across requests" % (label, field))
            if seq.get("same_cache_key"):
                keys = [body.get("prompt_cache_key") for body in bodies]
                if not keys or not isinstance(keys[0], str) or not keys[0] or any(key != keys[0] for key in keys[1:]):
                    msgs.append("fake sequence %s: prompt_cache_key is empty or changed (%r)" % (label, keys))
            if seq.get("session_header_matches_cache_key"):
                for req, body in zip(selected, bodies):
                    key = body.get("prompt_cache_key")
                    if not key or req.get("headers", {}).get("session-id") != key:
                        msgs.append("fake sequence %s: request #%s session-id does not equal its prompt_cache_key" % (
                            label, req.get("index")))
            if seq.get("same_thread_id"):
                thread_ids = [req.get("headers", {}).get("thread-id") for req in selected]
                if not thread_ids or not isinstance(thread_ids[0], str) or not thread_ids[0] or any(
                        thread_id != thread_ids[0] for thread_id in thread_ids[1:]):
                    msgs.append("fake sequence %s: thread-id is empty or changed (%r)" % (label, thread_ids))
            if seq.get("safe_ids"):
                sensitive = [self.w.checkout, self.w.home, "acct_kogen_test"]
                for req, body in zip(selected, bodies):
                    authorization = req.get("headers", {}).get("authorization", "")
                    if authorization.lower().startswith("bearer "):
                        sensitive.append(authorization[7:])
                    ids = [body.get("prompt_cache_key"), req.get("headers", {}).get("thread-id")]
                    for value in ids:
                        if not isinstance(value, str) or not value:
                            continue
                        if any(secret and secret in value for secret in sensitive):
                            msgs.append("fake sequence %s: cache or thread id contains a path, account id or token" % label)
            if seq.get("journal_identity"):
                try:
                    _started, run_dir, _doc = self.w.latest_run(seq.get("slug", "greet"))
                    journal = [e for e in self.w.events(run_dir) if e.get("event") == "model_stage"]
                    for req, body in zip(selected, bodies):
                        key = body.get("prompt_cache_key")
                        thread_id = req.get("headers", {}).get("thread-id")
                        matches = [e for e in journal if e.get("cache_key") == key and
                                   e.get("thread_id") == thread_id and e.get("conversation_id") == thread_id]
                        if not matches:
                            msgs.append("fake sequence %s: journal has no model_stage with matching cache_key, thread_id and conversation_id for request #%s" % (
                                label, req.get("index")))
                except CaseError as e:
                    msgs.append("fake sequence %s: %s" % (label, e))
        return msgs


def _texts_of(body):
    from .fake_server import item_texts
    return item_texts((body or {}).get("input") or [])


def _nested_value(value, dotted_path):
    for part in dotted_path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _check_lines(name, text, wants, prefix=False):
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    msgs = []
    if not prefix and len(lines) != len(wants):
        msgs.append("%s has %d lines, expected %d: %r" % (name, len(lines), len(wants), lines[:40]))
    for i, want in enumerate(wants):
        if i >= len(lines):
            if prefix:
                msgs.append("%s has only %d lines" % (name, len(lines)))
            break
        got = lines[i]
        if want.startswith("~"):
            if re.fullmatch(want[1:], got) is None:
                msgs.append("%s line %d %r does not match /%s/" % (name, i + 1, got, want[1:]))
        elif want.startswith("\\~"):
            if got != want[1:]:
                msgs.append("%s line %d %r, expected %r" % (name, i + 1, got, want[1:]))
        elif got != want:
            msgs.append("%s line %d %r, expected %r" % (name, i + 1, got, want))
    return msgs


def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _clip(b, n=600):
    s = b.decode("utf-8", errors="replace") if isinstance(b, (bytes, bytearray)) else str(b)
    return s if len(s) <= n else s[:n] + "…(%d more)" % (len(s) - n)


def _first_diff(want, got):
    for i, (a, b) in enumerate(zip(want, got)):
        if a != b:
            return " (first difference at char %d: expected %r, got %r)" % (i, want[max(0, i - 20):i + 20], got[max(0, i - 20):i + 20])
    if len(want) != len(got):
        return " (lengths %d vs %d; got tail %r)" % (len(want), len(got), got[len(want):len(want) + 80] if len(got) > len(want) else "")
    return ""


def _step_label(step):
    k = next(iter(step), "?")
    if k == "run":
        return "run " + " ".join(step[k])[:80]
    return k


STEP_KINDS = {
    "write": CaseRun.s_write, "remove": CaseRun.s_remove, "symlink": CaseRun.s_symlink,
    "intent": CaseRun.s_intent, "commit": CaseRun.s_commit, "push": CaseRun.s_push,
    "origin_commit": CaseRun.s_origin_commit, "git": CaseRun.s_git, "sh": CaseRun.s_sh,
    "sleep": CaseRun.s_sleep, "fake": CaseRun.s_fake, "auth": CaseRun.s_auth,
    "approve": CaseRun.s_approve, "run": CaseRun.s_run, "signal": CaseRun.s_signal,
    "wait": CaseRun.s_wait, "wait_until": CaseRun.s_wait_until, "capture": CaseRun.s_capture,
    "snapshot": CaseRun.s_snapshot, "assert": CaseRun.s_assert, "eventually": CaseRun.s_eventually,
    "skip_if": CaseRun.s_skip_if, "synthetic_run": CaseRun.s_synthetic_run,
}


# ---------------------------------------------------------------------------- one case
def run_case(case, opts):
    started = time.time()
    result = {"id": case["id"], "profile": case["profile"], "title": case.get("title", ""),
              "spec": case.get("spec", []), "file": case.get("_file")}
    if case.get("status") == "unimplemented":
        result.update(status="unimplemented", reason=case.get("reason", ""), duration_ms=0)
        return result
    skip = _skip_reason(case, opts)
    if skip:
        result.update(status="skip", reason=skip, duration_ms=0)
        return result
    insts = instances(case)
    failures, hints, passed, errors, skipped = [], [], 0, 0, 0
    for label, inst in insts:
        inst.setdefault("id", case["id"])
        inst.setdefault("profile", case["profile"])
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", case["id"] + ("-" + label if label else ""))[:80]
        workdir = os.path.join(opts.workdir, safe)
        if os.path.exists(workdir):
            shutil.rmtree(workdir)
        os.makedirs(workdir)
        cr = CaseRun(inst, opts, workdir)
        ok = False
        try:
            cr.run()
            ok = True
            passed += 1
        except StepFailure as f:
            failures.append({"instance": label, "messages": f.messages})
        except Skip as s:
            skipped += 1
            failures.append({"instance": label, "skipped": str(s)})
            ok = True
        except CaseError as e:
            errors += 1
            failures.append({"instance": label, "harness_error": str(e)})
        except Exception as e:  # noqa: BLE001 - report harness bugs, never crash the suite
            errors += 1
            failures.append({"instance": label, "harness_error": "%s: %s" % (type(e).__name__, e),
                             "trace": traceback.format_exc()[-1500:]})
        hints += [h for h in cr.hints if h not in hints]
        if ok and not opts.keep:
            ctx.make_writable(workdir)
            shutil.rmtree(workdir, ignore_errors=True)
        elif not ok:
            result.setdefault("workdirs", []).append(workdir)
    total = len(insts)
    if skipped == total:
        status = "skip"
    elif errors and passed + skipped < total and not any("messages" in f for f in failures):
        status = "error"
    elif passed + skipped == total:
        status = "pass"
    else:
        status = "fail"
    result.update(status=status, instances={"total": total, "passed": passed, "skipped": skipped, "errors": errors},
                  failures=[f for f in failures if "skipped" not in f], hints=hints,
                  duration_ms=int((time.time() - started) * 1000))
    if skipped and status == "skip":
        result["reason"] = failures[0].get("skipped") if failures else ""
    return result


def _skip_reason(case, opts):
    needs = set(case.get("needs") or [])
    skip = set(opts.skip_needs)
    hit = sorted(needs & skip)
    if hit:
        return "needs %s (skipped by --skip-needs)" % ", ".join(hit)
    if "elixir" in needs and not shutil.which("elixir", path=opts.inherited_path):
        return "needs Elixir on PATH"
    if "linux" in needs and os.uname().sysname != "Linux":
        return "Linux only"
    if "darwin" in needs and os.uname().sysname != "Darwin":
        return "macOS only"
    return None
