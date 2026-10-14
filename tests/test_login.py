"""`todo login` against a stub server: the token prompt, the history warning,
and the two kinds of 401."""

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

TOKEN = "good-token"


def make_handler(mode):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if mode == "gate":
                return self.reply(401, {"error": "sign-in required"})
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                return self.reply(401, {"error": "unauthorized"})
            self.reply(200, {"handle": "alice"})

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


def test_token_read_from_stdin_when_not_given(stub, tmp_path):
    out = login(tmp_path, stub(), stdin=TOKEN + "\n")
    assert out.returncode == 0, out.stderr
    assert "as alice" in out.stdout
    assert "shell history" not in out.stderr


def test_positional_token_warns_about_shell_history(stub, tmp_path):
    out = login(tmp_path, stub(), TOKEN)
    assert out.returncode == 0
    assert "shell history" in out.stderr


def test_empty_token_is_refused(stub, tmp_path):
    out = login(tmp_path, stub(), stdin="\n")
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
