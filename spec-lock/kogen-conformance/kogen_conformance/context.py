"""Per-case world: temp HOME/TMPDIR, fixtures, stubs, git helpers and placeholders (§C.3)."""

import glob
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

from . import rsa, yamlout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FIXTURES = os.path.join(ROOT, "fixtures")
TEMPLATES = os.path.join(ROOT, "cases", "_templates")

GIT_IDENTITY = ("Kogen Test", "test@kogen.invalid")

PLACEHOLDER = re.compile(r"\{(\*?)([a-z_][a-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?::([^{}\s]+))?\}")


class CaseError(Exception):
    """A harness problem (not an implementation failure)."""


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def load_data(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f) if name.endswith(".json") else f.read()


def state_key(checkout):
    """§2.7: basename of the canonical path (≤ 40, sanitised) + '-' + sha256(path)[:10]."""
    canonical = os.path.realpath(checkout)
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(canonical))[:40]
    return "%s-%s" % (base, sha256_hex(canonical.encode())[:10])


STUB_MISE = r"""#!/bin/sh
# Conformance stub for mise (§C.3): `env --json` prints a map, `exec --` passes through.
case "$1" in
  env) echo '{}'; exit 0 ;;
  exec)
    shift
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$1" = "--" ] && shift
    exec "$@"
    ;;
  *) exit 0 ;;
esac
"""

STUB_OPEN = r"""#!@PYTHON@
# Conformance stub for open/xdg-open (§C.3): follows the authorize URL to the loopback
# from a detached session, so Kogen's process-group cleanup does not kill it.
import os, sys, time, urllib.request
url = sys.argv[-1] if len(sys.argv) > 1 else ""
with open("@STUBS@/open.log", "a") as log:
    log.write(url + "\n")
if os.environ.get("KOGEN_CONFORMANCE_BROWSER") == "off" or os.path.exists("@STUBS@/browser.off"):
    sys.exit(0)
if os.fork() > 0:
    sys.exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
devnull = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(devnull, fd)
deadline = time.time() + 20
while time.time() < deadline:
    try:
        urllib.request.urlopen(url, timeout=10).read()
        break
    except Exception:
        time.sleep(0.2)
os._exit(0)
"""

STUB_ARGV_LOGGER = r"""#!@PYTHON@
# Conformance argv-size logger (§C.3): records the largest argv element, then execs @REAL@.
import json, os, sys
with open(@LOG_EXPR@, "a") as log:
    sizes = [len(a.encode("utf-8", "surrogateescape")) for a in sys.argv[1:]]
    log.write(json.dumps({"prog": "@NAME@", "argc": len(sys.argv) - 1, "max": max(sizes) if sizes else 0}) + "\n")
os.execv("@REAL@", ["@NAME@"] + sys.argv[1:])
"""


class World:
    """Directories, environment and helpers for one case instance."""

    def __init__(self, workdir, case, opts):
        self.case = case
        self.opts = opts
        self.dir = os.path.realpath(workdir)
        argv_log = case.get("argv_log")
        self.argv_log_path = None
        if isinstance(argv_log, dict) and argv_log.get("target") == "TMP":
            self.argv_log_path = os.path.join(
                "/tmp", "kogen-conformance-argv-%s.log" % sha256_hex(self.dir.encode())[:16]
            )
        self.home = os.path.join(self.dir, "home")
        self.tmp = os.path.join(self.dir, "tmp")
        self.stubs = os.path.join(self.dir, "stubs")
        self.origin = os.path.join(self.dir, "origin.git")
        self.checkout = os.path.join(self.dir, "checkout")
        self.nowhere = os.path.join(self.dir, "nowhere")
        self.gitconfig = os.path.join(self.dir, "gitconfig")
        self.auth_path = os.path.join(self.dir, "auth.json")
        self.vars = {}
        self.project = None
        self.acceptance_ext = case.get("acceptance_ext", ".t.sh")
        self.fake = None
        for d in (self.home, self.tmp, self.stubs, self.nowhere):
            os.makedirs(d, exist_ok=True)
        self.base = case.get("base_branch", "main")

    # ------------------------------------------------------------------ environment
    def write_gitconfig(self, identity=True):
        lines = ["[init]", "\tdefaultBranch = main", "[commit]", "\tgpgsign = false", "[tag]", "\tgpgsign = false",
                 "[core]", "\tautocrlf = false",
                 "[protocol \"file\"]", "\tallow = always", "[advice]", "\tdetachedHead = false"]
        if identity:
            lines = ["[user]", "\tname = %s" % GIT_IDENTITY[0], "\temail = %s" % GIT_IDENTITY[1]] + lines
        with open(self.gitconfig, "w") as f:
            f.write("\n".join(lines) + "\n")

    def write_stubs(self):
        py = sys.executable
        def put(name, text, real=None):
            path = os.path.join(self.stubs, name)
            text = text.replace("@STUBS@", self.stubs).replace("@PYTHON@", py)
            if real:
                text = text.replace("@REAL@", real).replace("@NAME@", name)
            with open(path, "w") as f:
                f.write(text)
            os.chmod(path, 0o755)
        if self.case.get("stub_mise", True):
            put("mise", STUB_MISE)
        put("open", STUB_OPEN)
        put("xdg-open", STUB_OPEN)
        if self.case.get("argv_log"):
            argv_log = self.case["argv_log"]
            if self.argv_log_path:
                log_expr = json.dumps(self.argv_log_path)
                try:
                    os.unlink(self.argv_log_path)
                except FileNotFoundError:
                    pass
            elif isinstance(argv_log, dict) and argv_log.get("target") == "TMPDIR":
                log_expr = 'os.path.join(os.environ["TMPDIR"], "argv.log")'
            else:
                log_expr = '"@STUBS@/argv.log"'
            for prog in ("sh", "git"):
                real = shutil.which(prog, path=self.opts.inherited_path)
                text = STUB_ARGV_LOGGER.replace("@LOG_EXPR@", log_expr)
                put(prog, text, real=real)

    def write_injected_auth(self, expired=False, account_id="acct_kogen_test"):
        now = int(time.time())
        claims = {"iss": "https://auth.openai.com", "sub": "user-kogen-test", "iat": now,
                  "exp": now - 3600 if expired else now + 86400,
                  "https://api.openai.com/auth": {"chatgpt_account_id": account_id, "chatgpt_plan_type": "plus"}}
        doc = {"tokens": {"access_token": rsa.jwt_rs256(claims), "account_id": account_id}}
        with open(self.auth_path, "w") as f:
            json.dump(doc, f)
        os.chmod(self.auth_path, 0o600)

    def env(self, extra=None):
        env = {
            "HOME": self.home,
            "TMPDIR": self.tmp,
            "PATH": self.stubs + os.pathsep + self.opts.inherited_path,
            "LANG": self.opts.lang,
            "TZ": "UTC",
            "USER": os.environ.get("USER", "kogen"),
            "LOGNAME": os.environ.get("LOGNAME", os.environ.get("USER", "kogen")),
            "SHELL": "/bin/sh",
            "GIT_CONFIG_GLOBAL": self.gitconfig,
            "GIT_CONFIG_NOSYSTEM": "1",
            "KOGEN_TIME_SCALE": str(self.case.get("time_scale", self.opts.time_scale)),
            # v1.1 test seam (§4.1, §4.6): logins go to plain files under HOME, never the OS keychain.
            "KOGEN_CREDENTIAL_STORE": "file",
        }
        if self.fake is not None:
            env["KOGEN_PROVIDER_URL"] = self.fake.url + "/v1/responses"
            env["KOGEN_AUTH_URL"] = self.fake.url
        auth = self.case.get("auth", "injected")
        if auth == "injected":
            env["KOGEN_AUTH_PATH"] = self.auth_path
        if self.case.get("sandbox_unavailable"):
            env["KOGEN_SANDBOX"] = "unavailable"
        env.update(self.opts.extra_env)
        env.update(self.case.get("env") or {})
        if extra:
            env.update(extra)
        return {k: v for k, v in env.items() if v is not None}

    def git_env(self):
        env = self.env()
        env.update({"GIT_AUTHOR_NAME": GIT_IDENTITY[0], "GIT_AUTHOR_EMAIL": GIT_IDENTITY[1],
                    "GIT_COMMITTER_NAME": GIT_IDENTITY[0], "GIT_COMMITTER_EMAIL": GIT_IDENTITY[1]})
        return env

    # ------------------------------------------------------------------ git
    def git(self, args, cwd=None, check=True, input=None, env=None):
        cwd = cwd or self.checkout
        proc = subprocess.run(["git"] + list(args), cwd=cwd, env=env or self.git_env(), input=input,
                              capture_output=True)
        if check and proc.returncode != 0:
            raise CaseError("git %s failed in %s: %s" % (" ".join(args), cwd,
                                                         proc.stderr.decode(errors="replace").strip()))
        return proc.stdout.decode(errors="replace")

    def git_ok(self, args, cwd=None):
        proc = subprocess.run(["git"] + list(args), cwd=cwd or self.origin, env=self.git_env(), capture_output=True)
        return proc.returncode == 0, proc.stdout.decode(errors="replace").strip()

    def origin_git_dir(self):
        return self.origin

    def ref_value(self, ref, where="origin"):
        ok, out = self.git_ok(["rev-parse", "--verify", "-q", ref], cwd=self.origin if where == "origin" else self.checkout)
        return out if ok else None

    def refs_with_prefix(self, prefix, where="origin"):
        ok, out = self.git_ok(["for-each-ref", "--format=%(refname)", prefix],
                              cwd=self.origin if where == "origin" else self.checkout)
        return [l for l in out.splitlines() if l] if ok else []

    # ------------------------------------------------------------------ fixtures
    def build_fixture(self):
        fixture = self.case.get("fixture", "kt")
        self.write_gitconfig(identity=self.case.get("git_identity", True))
        self.write_stubs()
        self.write_injected_auth(expired=self.case.get("auth_expired", False))
        if fixture == "none":
            return
        staging = os.path.join(self.dir, "staging")
        os.makedirs(staging)
        files = {}
        if fixture == "kt":
            files.update(self._dir_files(os.path.join(FIXTURES, "kt")))
            with open(os.path.join(FIXTURES, "kt.project.json")) as f:
                project = json.load(f)
            project = yamlout.deep_merge(project, self.case.get("project") or {})
            self.project = project
            if self.case.get("project_yaml") is not None:
                files[".kogen/project.yaml"] = _text(self.case["project_yaml"])
            elif project is not None:
                files[".kogen/project.yaml"] = yamlout.emit(project)
            self.acceptance_ext = (project.get("acceptance") or {}).get("ext", self.acceptance_ext)
        elif fixture == "exunit-hello":
            files.update(self._dir_files(os.path.join(FIXTURES, "exunit-hello")))
            self.acceptance_ext = "_test.exs"
            if self.case.get("project_yaml") is not None:
                files[".kogen/project.yaml"] = _text(self.case["project_yaml"])
        elif fixture == "empty":
            files["README.md"] = "empty fixture\n"
            if self.case.get("project_yaml") is not None:
                files[".kogen/project.yaml"] = _text(self.case["project_yaml"])
        else:
            raise CaseError("unknown fixture %r" % fixture)
        for path, text in (self.case.get("fixture_files") or {}).items():
            files[path] = _text(text)
        for path in self.case.get("fixture_remove") or []:
            files.pop(path, None)
        for rel, content in files.items():
            full = os.path.join(staging, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            mode = None
            if isinstance(content, tuple):
                content, mode = content
            with open(full, "wb") as f:
                f.write(content if isinstance(content, bytes) else content.encode())
            if mode:
                os.chmod(full, mode)
        self.git(["init", "-q", "-b", self.base], cwd=staging)
        self.git(["add", "-A"], cwd=staging)
        self.git(["commit", "-q", "-m", "Initial %s fixture" % fixture], cwd=staging)
        topology = self.case.get("topology", "clone")
        if topology == "single":
            os.rename(staging, self.checkout)
            self.origin = self.checkout
            return
        if topology == "nonbare":
            os.rename(staging, os.path.join(self.dir, "origin"))
            self.origin = os.path.join(self.dir, "origin")
            self.git(["clone", "-q", self.origin, self.checkout], cwd=self.dir)
            return
        self.git(["clone", "-q", "--bare", staging, self.origin], cwd=self.dir)
        shutil.rmtree(staging)
        self.git(["clone", "-q", self.origin, self.checkout], cwd=self.dir)

    @staticmethod
    def _dir_files(root):
        files = {}
        for dirpath, _dirs, names in os.walk(root):
            for name in names:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root)
                mode = os.stat(full).st_mode & 0o777
                files[rel] = (read_bytes(full), mode)
        return files

    # ------------------------------------------------------------------ derived values
    @property
    def state_root(self):
        return os.path.join(self.home, ".kogen", "workspaces", state_key(self.checkout))

    def intent_path(self, slug):
        return os.path.join(self.checkout, ".kogen", "intents", slug, "intent.md")

    def acceptance_source(self, slug):
        return os.path.join(self.checkout, ".kogen", "acceptance", slug + self.acceptance_ext)

    def approval_hash(self, slug):
        try:
            intent = read_bytes(self.intent_path(slug))
        except OSError:
            raise CaseError("cannot compute hash: %s missing" % self.intent_path(slug))
        try:
            test = read_bytes(self.acceptance_source(slug))
        except OSError:
            test = b""
        return sha256_hex(intent + b"\x00" + test)

    def runs(self, slug=None):
        """Run dirs (optionally for one slug), oldest first."""
        out = []
        for run_json in glob.glob(os.path.join(self.state_root, "runs", "*", "run.json")):
            try:
                with open(run_json) as f:
                    doc = json.load(f)
            except (OSError, ValueError):
                doc = {}
            if slug and doc.get("slug") not in (slug, None):
                continue
            started = doc.get("started_ms")
            if not isinstance(started, int):
                started = int(os.stat(run_json).st_mtime * 1000)
            out.append((started, os.path.dirname(run_json), doc))
        out.sort(key=lambda t: t[0])
        return out

    def latest_run(self, slug=None):
        runs = self.runs(slug)
        if not runs:
            raise CaseError("no run found for %s" % (slug or "any slug"))
        return runs[-1]

    def events(self, run_dir):
        path = os.path.join(run_dir, "events.jsonl")
        events = []
        try:
            with open(path, "rb") as f:
                for line in f.read().decode("utf-8", errors="replace").splitlines():
                    if line.strip():
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            events.append({"event": "<invalid json>", "_raw": line})
        except OSError:
            pass
        return events

    # ------------------------------------------------------------------ placeholders
    def resolve(self, name, arg):
        if name == "argv_log" and self.argv_log_path:
            return self.argv_log_path
        slug = arg or "greet"
        if name.startswith("row."):
            raise CaseError("unexpanded row placeholder {%s}" % name)
        simple = {
            "checkout": lambda: self.checkout, "origin": lambda: self.origin, "home": lambda: self.home,
            "case": lambda: self.dir, "tmp": lambda: self.tmp, "stubs": lambda: self.stubs,
            "nowhere": lambda: self.nowhere, "kogen": lambda: self.opts.kogen, "data": lambda: DATA,
            "state_root": lambda: self.state_root, "state_key": lambda: state_key(self.checkout),
            "fake_url": lambda: self.fake.url if self.fake else "", "auth_path": lambda: self.auth_path,
            "fake_port": lambda: str(self.fake.port) if self.fake else "", "case_id": lambda: self.case["id"],
            "base": lambda: self.base, "templates": lambda: TEMPLATES, "python": lambda: sys.executable,
        }
        if name in simple:
            return simple[name]()
        if name == "hash64":
            return self.approval_hash(slug)
        if name == "hash8":
            return self.approval_hash(slug)[:8]
        if name == "hash6":
            return self.approval_hash(slug)[:6]
        if name == "intent_sha":
            return sha256_hex(read_bytes(self.intent_path(slug)))
        if name == "base_sha":
            return self.ref_value("refs/heads/" + (arg or self.base)) or ""
        if name == "base_sha8":
            return (self.ref_value("refs/heads/" + (arg or self.base)) or "")[:8]
        if name == "base_tree":
            return self.ref_value("refs/heads/%s^{tree}" % (arg or self.base)) or ""
        if name == "head_sha":
            return self.ref_value("HEAD", where="checkout") or ""
        if name == "approval_commit":
            return self.ref_value("refs/kogen/intents/" + slug) or ""
        if name == "approval8":
            return (self.ref_value("refs/kogen/intents/" + slug) or "")[:8]
        if name == "ref":
            return self.ref_value(arg) or ""
        if name == "run_id":
            return os.path.basename(self.latest_run(slug)[1])
        if name == "id8":
            return os.path.basename(self.latest_run(slug)[1])[:8]
        if name == "run_dir":
            return self.latest_run(slug)[1]
        if name == "var":
            if arg not in self.vars:
                raise CaseError("variable %r was never captured" % arg)
            return self.vars[arg]
        if name == "sha256_file":
            return sha256_hex(read_bytes(os.path.join(self.checkout, arg)))
        if name == "sha256_origin":
            return sha256_hex(subprocess.run(["git", "cat-file", "-p", "refs/heads/%s:%s" % (self.base, arg)], cwd=self.origin,
                                             env=self.git_env(), capture_output=True).stdout)
        if name == "absent_sha":
            return sha256_hex(b"kogen:absent")
        if name == "abs":
            return os.path.join(self.checkout, arg)
        return None

    def expand(self, value):
        if isinstance(value, str):
            return self._expand_str(value)
        if isinstance(value, list):
            out = []
            for v in value:
                if isinstance(v, str):
                    m = PLACEHOLDER.fullmatch(v)
                    if m and m.group(1) == "*":
                        res = self.resolve(m.group(2), m.group(3))
                        out.extend(res if isinstance(res, list) else [res])
                        continue
                out.append(self.expand(v))
            return out
        if isinstance(value, dict):
            return {self.expand(k): self.expand(v) for k, v in value.items()}
        return value

    def _expand_str(self, s):
        def repl(m):
            res = self.resolve(m.group(2), m.group(3))
            if res is None:
                return m.group(0)
            return res if isinstance(res, str) else json.dumps(res)
        return PLACEHOLDER.sub(repl, s)

    def path(self, p):
        p = self.expand(p)
        return p if os.path.isabs(p) else os.path.join(self.checkout, p)


def _text(value):
    if isinstance(value, list):
        return "\n".join(value) + "\n"
    return value


def template(name):
    with open(os.path.join(TEMPLATES, name), "rb") as f:
        return f.read()


def make_writable(path):
    for dirpath, dirs, files in os.walk(path):
        for d in dirs:
            try:
                os.chmod(os.path.join(dirpath, d), stat.S_IRWXU)
            except OSError:
                pass
