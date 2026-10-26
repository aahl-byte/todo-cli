"""`todo login` against a stub server: browser approval, the token prompt, the
history warning, and the two kinds of 401."""

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

TOKEN = "good-token"


def make_handler(mode):
    polls = [0]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if mode == "gate":
                return self.reply(401, {"error": "sign-in required"})
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                return self.reply(401, {"error": "unauthorized"})
            self.reply(200, {"handle": "alice"})

        def do_POST(self):
            if mode == "gate":
                return self.reply(401, {"error": "sign-in required"})
            if mode == "old":
                return self.reply(404, {"error": "not found"})
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if self.path.endswith("/start"):
                return self.reply(200, {"device_code": "dev", "user_code": "ABCD-2345", "expires_in": 30, "interval": 0.05})
            polls[0] += 1
            if mode == "denied":
                return self.reply(200, {"status": "expired"})
            if polls[0] < 3:
                return self.reply(200, {"status": "pending"})
            self.reply(200, {"status": "approved", "token": TOKEN, "handle": "alice"})

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


@pytest.fixture
def stub():
    servers = []

    def start(mode="app"):
        srv = HTTPServer(("127.0.0.1", 0), make_handler(mode))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_port}"

    yield start
    for s in servers:
        s.shutdown()


def login(tmp_path, *argv, stdin=""):
    import os

    env = {k: v for k, v in os.environ.items() if k not in ("TODO_USER", "CLAUDECODE")}
    env.update(HOME=str(tmp_path), TODO_VIA="human")
    return subprocess.run([sys.executable, "-c", "from todo.cli import main; main()", "login", *argv],
                          cwd=tmp_path, env=env, input=stdin, capture_output=True, text=True, timeout=60)


def test_browser_approval_signs_in_without_a_token_on_the_terminal(stub, tmp_path):
    url = stub()
    out = login(tmp_path, url)
    assert out.returncode == 0, out.stderr
    assert f"{url}/login/device?code=ABCD-2345" in out.stdout
    assert "as alice" in out.stdout
    assert TOKEN not in out.stdout + out.stderr
    assert TOKEN in (tmp_path / ".todo" / "config.yaml").read_text()


def test_denied_or_expired_request_fails(stub, tmp_path):
    out = login(tmp_path, stub("denied"))
    assert out.returncode == 1
    assert "expired or was denied" in out.stderr


def test_server_without_browser_login_falls_back_to_the_token_prompt(stub, tmp_path):
    out = login(tmp_path, stub("old"), stdin=TOKEN + "\n")
    assert "paste an API token" in out.stderr
    assert out.returncode == 0 and "as alice" in out.stdout


def test_token_flag_prompts_instead_of_opening_the_browser(stub, tmp_path):
    out = login(tmp_path, stub(), "--token", stdin=TOKEN + "\n")
    assert out.returncode == 0, out.stderr
    assert "as alice" in out.stdout
    assert "shell history" not in out.stderr


def test_positional_token_warns_about_shell_history(stub, tmp_path):
    out = login(tmp_path, stub(), TOKEN)
    assert out.returncode == 0
    assert "shell history" in out.stderr


def test_empty_token_is_refused(stub, tmp_path):
    out = login(tmp_path, stub(), "--token", stdin="\n")
    assert out.returncode == 2
    assert "No token" in out.stderr


def test_wrong_token_says_where_to_get_one(stub, tmp_path):
    out = login(tmp_path, stub(), "nope")
    assert out.returncode == 1
    assert "token is wrong or revoked" in out.stderr


def test_gate_401_is_not_blamed_on_the_token(stub, tmp_path):
    out = login(tmp_path, stub("gate"), TOKEN)
    assert out.returncode == 1
    assert "gate" in out.stderr and "isn't open" in out.stderr
    assert "wrong" not in out.stderr


def saved_token(tmp_path):
    import yaml

    return yaml.safe_load((tmp_path / ".todo" / "config.yaml").read_text())["tokens"]


def test_login_again_keeps_a_saved_token_that_still_works(stub, tmp_path):
    url = stub()
    assert login(tmp_path, url, TOKEN).returncode == 0
    out = login(tmp_path, url)
    assert out.returncode == 0, out.stderr
    assert "Already logged in" in out.stdout and "as alice" in out.stdout
    assert "/login/device" not in out.stdout
    assert saved_token(tmp_path)[url] == TOKEN


def test_login_replaces_a_saved_token_that_no_longer_works(stub, tmp_path):
    url = stub()
    (tmp_path / ".todo").mkdir()
    (tmp_path / ".todo" / "config.yaml").write_text(f"tokens:\n  {url}: revoked\n")
    out = login(tmp_path, url)
    assert out.returncode == 0, out.stderr
    assert "/login/device" in out.stdout
    assert saved_token(tmp_path)[url] == TOKEN


def test_new_flag_signs_in_again_despite_a_working_token(stub, tmp_path):
    url = stub()
    assert login(tmp_path, url, TOKEN).returncode == 0
    out = login(tmp_path, url, "--new")
    assert out.returncode == 0, out.stderr
    assert "/login/device" in out.stdout
