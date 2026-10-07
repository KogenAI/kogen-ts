"""The fake provider server (spec §4.8): scripted ChatGPT Responses SSE plus fake OAuth.

Usable in-process (``FakeServer``) or standalone::

    python3 -m kogen_conformance fake --script steps.jsonl --port 8765 --time-scale 0.01

Endpoints
- ``POST <any path ending in /responses>``: record ``{headers, body}``, serve the first
  unconsumed script step whose ``expect`` matches, else HTTP 400 ``scripted_mismatch``.
- ``GET /_fake/requests``, ``GET /_fake/remaining``, ``POST /_fake/reset``,
  ``POST /_fake/script`` (replace the script; body = JSON list or JSON Lines),
  ``GET /_fake/oauth`` (recorded OAuth requests).
- OAuth: ``/.well-known/openid-configuration``, ``/api/accounts/authorize``,
  ``/api/accounts/oauth/token``, ``/jwks``, ``/revoke``.
"""

import base64
import hashlib
import http.server
import json
import os
import socket
import socketserver
import subprocess
import threading
import time
import urllib.parse

from . import rsa

ROLE_MARKERS = [
    ("test_auditor", "You are Kogen's acceptance test auditor."),
    ("requirement_auditor", "You are Kogen's requirement auditor."),
    ("shaper", "You are Kogen Intent shaper."),
    ("planner", "one-shot implementation plan for a cheaper coding agent"),
    ("builder", "You are Kogen's builder."),
]

# Aliases accepted in ``expect.role``.
ROLE_ALIASES = {"auditor": ("test_auditor", "requirement_auditor", "build_auditor")}

DEFAULT_USAGE = {
    "input_tokens": 120,
    "input_tokens_details": {"cached_tokens": 20},
    "output_tokens": 30,
    "output_tokens_details": {"reasoning_tokens": 10},
    "total_tokens": 150,
}

ISSUER = "https://auth.openai.com"
REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"


def _load_script(script):
    if script is None:
        return []
    if isinstance(script, str):
        text = script.strip()
        if not text:
            return []
        if text.startswith("["):
            return json.loads(text)
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return list(script)


def item_texts(items):
    """Every human-readable text carried by Responses input items, in order."""
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        content = item.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    out.append(part["text"])
        if typ == "function_call_output":
            output = item.get("output")
            out.append(output if isinstance(output, str) else json.dumps(output))
        if typ == "function_call":
            args = item.get("arguments")
            out.append(args if isinstance(args, str) else json.dumps(args))
    return out


def conversation_items(body):
    """Input items without the owned-mode ``additional_tools`` item."""
    items = body.get("input") if isinstance(body, dict) else None
    if not isinstance(items, list):
        return []
    return [i for i in items if not (isinstance(i, dict) and i.get("type") == "additional_tools")]


def tool_names(body):
    names = []
    if isinstance(body.get("tools"), list):
        names += [t.get("name") for t in body["tools"] if isinstance(t, dict)]
    for item in body.get("input") or []:
        if isinstance(item, dict) and item.get("type") == "additional_tools":
            names += [t.get("name") for t in item.get("tools") or [] if isinstance(t, dict)]
    return sorted(n for n in names if n)


def is_user_message(item):
    return isinstance(item, dict) and item.get("role") == "user" and item.get("type") in (None, "message")


def infer_role(body):
    instructions = body.get("instructions") if isinstance(body.get("instructions"), str) else ""
    for role, marker in ROLE_MARKERS:
        if marker in instructions:
            return role
    # Fallback: a system prompt sent as a developer/system input item.
    for item in body.get("input") or []:
        if isinstance(item, dict) and item.get("role") in ("developer", "system"):
            text = "\n".join(item_texts([item]))
            for role, marker in ROLE_MARKERS:
                if marker in text:
                    return role
    return "unknown"


class FakeState:
    def __init__(self, script=None, time_scale=1.0, side_effect_env=None, side_effect_cwd=None):
        self.lock = threading.RLock()
        self.time_scale = float(time_scale) if time_scale else 1.0
        self.side_effect_env = dict(side_effect_env or os.environ)
        self.side_effect_cwd = side_effect_cwd
        self.set_script(script)
        self.requests = []
        self.oauth = []
        self.response_counter = 0
        self.codes = {}
        self.refresh_tokens = {}
        self.token_counter = 0
        self.side_effect_log = []
        self.config = {"subject": "user-kogen-test", "email": "test@kogen.invalid", "expires_in": 3600,
                       "issued_client_id": "app_kogen_conformance", "token_status": 200,
                       "refresh_status": 200, "revoke_status": 200, "scope": REQUIRED_SCOPE}

    def set_script(self, script):
        with self.lock:
            steps = _load_script(script)
            for i, step in enumerate(steps):
                step.setdefault("id", "s%d" % (i + 1))
                rep = step.get("repeat", 1)
                step["_left"] = None if rep in ("always", -1) else int(rep)
            self.steps = steps

    def append_script(self, script):
        with self.lock:
            extra = _load_script(script)
            base = len(self.steps)
            for i, step in enumerate(extra):
                step.setdefault("id", "s%d" % (base + i + 1))
                rep = step.get("repeat", 1)
                step["_left"] = None if rep in ("always", -1) else int(rep)
            self.steps.extend(extra)

    def reset(self):
        with self.lock:
            self.steps = []
            self.requests = []
            self.oauth = []
            self.response_counter = 0

    def remaining(self):
        with self.lock:
            return [s["id"] for s in self.steps if s["_left"] not in (None, 0) and not s.get("optional")]

    def unmatched(self):
        with self.lock:
            return [r for r in self.requests if r.get("step") is None]

    def public_requests(self):
        with self.lock:
            return [{k: v for k, v in r.items() if not k.startswith("_")} for r in self.requests]

    # ----- turn tracking (§4.8.2)
    def compute_turn(self, role, items):
        user_msgs = [i for i in items if is_user_message(i)]
        if len(items) == 1 and len(user_msgs) == 1:
            return 1, True
        for prev in reversed(self.requests):
            if prev["role"] != role:
                continue
            prev_items = prev["_items"]
            if len(prev_items) < len(items) and items[: len(prev_items)] == prev_items:
                return (prev["turn"] or 0) + 1, False
        return None, False

    def match(self, step, req):
        exp = step.get("expect") or {}
        if "role" in exp:
            want = exp["role"]
            allowed = ROLE_ALIASES.get(want, (want,))
            if req["role"] not in allowed:
                return False
        body = req["body"]
        if "model" in exp and body.get("model") != exp["model"]:
            return False
        if "effort" in exp and ((body.get("reasoning") or {}).get("effort")) != exp["effort"]:
            return False
        if "tools" in exp and sorted(exp["tools"]) != req["tools"]:
            return False
        if "turn" in exp and req["turn"] != exp["turn"]:
            return False
        if "fresh" in exp and req["fresh"] != bool(exp["fresh"]):
            return False
        texts = req["_texts"]
        joined = "\n".join(texts)
        for needle in _as_list(exp.get("input_contains")):
            if needle not in joined:
                return False
        for needle in _as_list(exp.get("input_not_contains")):
            if needle in joined:
                return False
        if "instructions_contains" in exp:
            instr = body.get("instructions") or ""
            for needle in _as_list(exp["instructions_contains"]):
                if needle not in instr:
                    return False
        if "last_output_contains" in exp:
            outs = [i for i in req["_items"] if isinstance(i, dict) and i.get("type") == "function_call_output"]
            if not outs:
                return False
            last = outs[-1].get("output")
            last = last if isinstance(last, str) else json.dumps(last)
            for needle in _as_list(exp["last_output_contains"]):
                if needle not in last:
                    return False
        if "last_user_contains" in exp:
            users = [i for i in req["_items"] if is_user_message(i)]
            if not users:
                return False
            last = "\n".join(item_texts([users[-1]]))
            for needle in _as_list(exp["last_user_contains"]):
                if needle not in last:
                    return False
        if "last_item_type" in exp:
            last = req["_items"][-1] if req["_items"] else {}
            if last.get("type", "message") != exp["last_item_type"]:
                return False
        if "after" in exp:
            done = {r.get("step") for r in self.requests}
            for sid in _as_list(exp["after"]):
                if sid not in done:
                    return False
        return True

    def select(self, req):
        with self.lock:
            for step in self.steps:
                if step["_left"] == 0:
                    continue
                if self.match(step, req):
                    if step["_left"] is not None:
                        step["_left"] -= 1
                    return step
            return None


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def build_items(step_id, reply):
    items = []
    if "text" in reply:
        items.append({"type": "message", "id": "msg_%s" % step_id, "role": "assistant", "status": "completed",
                      "content": [{"type": "output_text", "text": reply["text"], "annotations": []}]})
    for i, call in enumerate(reply.get("calls") or []):
        args = call.get("arguments", {})
        if not isinstance(args, str):
            args = json.dumps(args)
        items.append({"type": "function_call", "id": "fc_%s_%d" % (step_id, i), "status": "completed",
                      "call_id": call.get("call_id", "call_%s_%d" % (step_id, i)),
                      "name": call["name"], "arguments": args})
    items.extend(reply.get("items") or [])
    return items


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KogenFake/1"

    def log_message(self, *_args):
        pass

    @property
    def state(self):
        return self.server.state

    def _read_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                size_line = self.rfile.readline().strip()
                size = int(size_line.split(b";")[0] or b"0", 16)
                if size == 0:
                    while self.rfile.readline().strip():
                        pass
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            return b"".join(chunks)
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send_json(self, status, obj, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _base(self):
        host = self.headers.get("Host") or "127.0.0.1:%d" % self.server.server_address[1]
        return "http://" + host

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if path == "/_fake/requests":
            return self._send_json(200, self.state.public_requests())
        if path == "/_fake/remaining":
            return self._send_json(200, self.state.remaining())
        if path == "/_fake/oauth":
            return self._send_json(200, self.state.oauth)
        if path == "/.well-known/openid-configuration":
            self._record_oauth("discovery", dict(urllib.parse.parse_qsl(parsed.query)))
            base = self._base()
            return self._send_json(200, {
                "issuer": ISSUER,
                "authorization_endpoint": base + "/api/accounts/authorize",
                "token_endpoint": base + "/api/accounts/oauth/token",
                "jwks_uri": base + "/jwks",
                "revocation_endpoint": base + "/revoke",
                "response_types_supported": ["code"],
                "code_challenge_methods_supported": ["S256"],
                "id_token_signing_alg_values_supported": ["RS256"],
            })
        if path == "/jwks":
            self._record_oauth("jwks", {})
            return self._send_json(200, {"keys": [rsa.jwk()]})
        if path == "/api/accounts/authorize":
            return self._authorize(dict(urllib.parse.parse_qsl(parsed.query)))
        self._send_json(404, {"error": {"message": "not_found"}})

    def _record_oauth(self, kind, params):
        with self.state.lock:
            self.state.oauth.append({"kind": kind, "params": params, "headers": {k.lower(): v for k, v in self.headers.items()},
                                     "time_ms": int(time.time() * 1000)})

    def _authorize(self, params):
        self._record_oauth("authorize", params)
        st = self.state
        code = "code_%d" % (len(st.codes) + 1)
        client_id = params.get("client_id", "")
        issued = st.config["issued_client_id"] if client_id in ("", "dynamic_agent_client") else client_id
        with st.lock:
            st.codes[code] = {"challenge": params.get("code_challenge"), "method": params.get("code_challenge_method"),
                              "nonce": params.get("nonce"), "client_id": issued,
                              "redirect_uri": params.get("redirect_uri")}
        query = {"code": code, "state": params.get("state", "")}
        if client_id in ("", "dynamic_agent_client"):
            query["client_id"] = issued
        redirect = params.get("redirect_uri", "http://127.0.0.1:1455/auth/callback")
        location = redirect + ("&" if "?" in redirect else "?") + urllib.parse.urlencode(query)
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        raw = self._read_body()
        if path == "/_fake/reset":
            self.state.reset()
            return self._send_json(200, {"ok": True})
        if path == "/_fake/script":
            self.state.set_script(raw.decode())
            return self._send_json(200, {"ok": True})
        if path == "/_fake/append":
            self.state.append_script(raw.decode())
            return self._send_json(200, {"ok": True})
        if path == "/api/accounts/oauth/token":
            return self._token(raw)
        if path == "/revoke":
            self._record_oauth("revoke", dict(urllib.parse.parse_qsl(raw.decode(errors="replace"))))
            return self._send_json(self.state.config["revoke_status"], {})
        if path.endswith("/responses"):
            return self._responses(raw)
        self._send_json(404, {"error": {"message": "not_found"}})

    def _id_token(self, client_id, nonce):
        now = int(time.time())
        cfg = self.state.config
        claims = {"iss": ISSUER, "aud": [client_id], "sub": cfg["subject"], "email": cfg["email"],
                  "iat": now, "exp": now + 3600,
                  "https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_account_id": "acct_kogen_test"}}
        if nonce is not None:
            claims["nonce"] = nonce
        return rsa.jwt_rs256(claims)

    def _token(self, raw):
        ctype = (self.headers.get("Content-Type") or "").lower()
        if "json" in ctype:
            try:
                params = json.loads(raw.decode())
            except ValueError:
                params = {}
        else:
            params = dict(urllib.parse.parse_qsl(raw.decode(errors="replace")))
        grant = params.get("grant_type")
        self._record_oauth("token:" + str(grant), params)
        st = self.state
        cfg = st.config
        with st.lock:
            st.token_counter += 1
            n = st.token_counter
        if grant == "authorization_code":
            if cfg["token_status"] != 200:
                return self._send_json(cfg["token_status"], {"error": "invalid_grant"})
            entry = st.codes.get(params.get("code"))
            if not entry:
                return self._send_json(400, {"error": "invalid_grant"})
            verifier = params.get("code_verifier", "")
            challenge = rsa.b64url(hashlib.sha256(verifier.encode()).digest())
            if entry["method"] != "S256" or challenge != entry["challenge"]:
                return self._send_json(400, {"error": "invalid_grant", "error_description": "pkce"})
            id_token = self._id_token(entry["client_id"], entry["nonce"])
            client_id = entry["client_id"]
        elif grant == "refresh_token":
            if cfg["refresh_status"] != 200:
                return self._send_json(cfg["refresh_status"], {"error": "invalid_grant"})
            client_id = params.get("client_id") or cfg["issued_client_id"]
            id_token = self._id_token(client_id, None)
        else:
            return self._send_json(400, {"error": "unsupported_grant_type"})
        access = rsa.jwt_rs256({"iss": ISSUER, "sub": cfg["subject"], "exp": int(time.time()) + cfg["expires_in"],
                                "n": n, "https://api.openai.com/auth": {"chatgpt_account_id": "acct_kogen_test"}})
        return self._send_json(200, {"access_token": access, "refresh_token": "rt_%d" % n, "id_token": id_token,
                                     "expires_in": cfg["expires_in"], "token_type": "Bearer", "scope": cfg["scope"]})

    def _responses(self, raw):
        st = self.state
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {"_unparseable": raw.decode("utf-8", errors="replace")}
        headers = {k.lower(): v for k, v in self.headers.items()}
        items = conversation_items(body) if isinstance(body, dict) else []
        role = infer_role(body) if isinstance(body, dict) else "unknown"
        with st.lock:
            turn, fresh = st.compute_turn(role, items)
            req = {"index": len(st.requests), "step": None, "role": role, "turn": turn, "fresh": fresh,
                   "headers": headers, "body": body, "body_raw_b64": base64.b64encode(raw).decode("ascii"),
                   "tools": tool_names(body) if isinstance(body, dict) else [],
                   "time_ms": int(time.time() * 1000), "_items": items, "_texts": item_texts(items)}
            step = st.select(req)
            req["step"] = step["id"] if step else None
            st.requests.append(req)
        if step is None:
            return self._send_json(400, {"error": {"message": "scripted_mismatch"}})
        self._serve_step(step)

    def _sleep(self, ms):
        if ms:
            time.sleep(float(ms) * self.state.time_scale / 1000.0)

    def _serve_step(self, step):
        st = self.state
        if step.get("side_effect_sh"):
            proc = subprocess.run(["sh", "-c", step["side_effect_sh"]], cwd=st.side_effect_cwd,
                                  env=st.side_effect_env, capture_output=True, text=True)
            st.side_effect_log.append({"step": step["id"], "exit": proc.returncode,
                                       "output": (proc.stdout + proc.stderr)[-2000:]})
        reply = step.get("reply") or {}
        self._sleep(step.get("first_byte_ms"))
        if "http" in reply:
            h = reply["http"]
            body = h.get("body", "")
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            self.send_response(int(h.get("status", 500)))
            hdrs = {"Content-Type": "application/json"}
            hdrs.update(h.get("headers") or {})
            for k, v in hdrs.items():
                self.send_header(k, str(v))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        with st.lock:
            st.response_counter += 1
            n = st.response_counter
        if "sse" in reply:
            frames = []
            for entry in reply["sse"]:
                if isinstance(entry, str):
                    frames.append(entry.encode())
                elif isinstance(entry, dict) and "raw" in entry:
                    frames.append(entry["raw"].encode())
                elif isinstance(entry, dict) and "raw_b64" in entry:
                    frames.append(base64.b64decode(entry["raw_b64"]))
                else:
                    frames.append(("event: %s\ndata: %s\n\n" % (entry.get("type", "message"), json.dumps(entry))).encode())
        else:
            items = build_items(step["id"], reply)
            usage = step["usage"] if "usage" in step else DEFAULT_USAGE
            frames = []
            for _ in range(int(step.get("pad_events") or 0)):
                ev = {"type": "response.in_progress", "response": {"id": "resp_%d" % n, "status": "in_progress"}}
                frames.append(("event: response.in_progress\ndata: %s\n\n" % json.dumps(ev)).encode())
            for idx, item in enumerate(items):
                ev = {"type": "response.output_item.done", "output_index": idx, "item": item}
                frames.append(("event: response.output_item.done\ndata: %s\n\n" % json.dumps(ev)).encode())
            response = {"id": "resp_%d" % n, "object": "response", "status": "completed",
                        "model": None, "output": []}
            if usage is not None:
                response["usage"] = usage
            completed = {"type": "response.completed", "response": response}
            if step.get("completed_output"):
                completed["response"]["output"] = step["completed_output"]
            if not step.get("omit_completed"):
                frames.append(("event: response.completed\ndata: %s\n\n" % json.dumps(completed)).encode())
        self.send_response(int(reply.get("status", 200)))
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        for k, v in (reply.get("headers") or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        drop_after = step.get("drop_after_events")
        gap = step.get("chunk_gap_ms")
        try:
            for i, frame in enumerate(frames):
                if drop_after is not None and i >= int(drop_after):
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if i > 0:
                    self._sleep(gap)
                self.wfile.write(b"%x\r\n%s\r\n" % (len(frame), frame))
                self.wfile.flush()
            if drop_after is not None and int(drop_after) >= len(frames):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.close_connection = True
                return
            self._sleep(step.get("tail_ms"))
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class FakeServer:
    def __init__(self, script=None, time_scale=1.0, port=0, host="127.0.0.1", side_effect_env=None, side_effect_cwd=None):
        self.state = FakeState(script, time_scale, side_effect_env, side_effect_cwd)
        self.httpd = _Server((host, port), Handler)
        self.httpd.state = self.state
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self):
        return self.httpd.server_address[1]

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def serve_forever(script_path, port, time_scale):
    script = open(script_path).read() if script_path else None
    server = FakeServer(script, time_scale=time_scale, port=port).start()
    print("fake provider listening on %s (responses: %s/v1/responses)" % (server.url, server.url), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()
