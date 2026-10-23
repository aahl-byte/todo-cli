"""An item's docs: `todo doc add|rm|path`, `todo docs`, the `.meta.yaml`
sidecar, and their trip through sync (uploads, conflicts, dashboard edits)."""

import io
import sys

import pytest

from todo import docs, remote, store, sync, yamlio

from .conftest import run_cli
from .fake_server import FakeServer
from .test_sync import make, rnd


def item_dir(root, q="beta"):
    it = store.resolve_item(root, q)
    return root / it["folder"] / it["id"]


def doc_dir(root, q="beta"):
    return item_dir(root, q) / docs.DOCS_DIR


def sidecar(root, q="beta"):
    f = doc_dir(root, q) / docs.META_FILE
    return yamlio.read(f) if f.is_file() else {}


def stdin_bytes(monkeypatch, data: bytes):
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(data)))


# ── the local store ──────────────────────────────────────────────────────────
def test_add_copies_the_file_in_and_records_who(root, tmp_path, capsys):
    run_cli(root, ["add", "Gamma"])
    src = tmp_path / "plan.md"
    src.write_text("# Plan\n")
    run_cli(root, ["doc", "add", "gamma", str(src)])
    assert (doc_dir(root, "gamma") / "plan.md").read_text() == "# Plan\n"
    meta = sidecar(root, "gamma")["plan.md"]
    assert meta["by"] == "tester" and meta["via"] == "human" and meta["size"] == 7
    assert meta["sha256"] == docs.sha256_bytes(b"# Plan\n") and meta["base"] is None
    assert meta["uid"] == docs.doc_uid(store.resolve_item(root, "gamma")["uid"], "plan.md")
    assert "gamma: doc plan.md added" in capsys.readouterr().out


def test_add_renames_with_name_and_replaces_an_existing_doc(root, tmp_path):
    src = tmp_path / "draft.txt"
    src.write_text("one")
    run_cli(root, ["doc", "add", "beta", str(src), "--name", "design.md"])
    src.write_text("two")
    run_cli(root, ["doc", "add", "beta", str(src), "--name", "design.md"])
    assert [p.name for p in doc_dir(root).iterdir() if not p.name.startswith(".")] == ["design.md"]
    assert (doc_dir(root) / "design.md").read_text() == "two"
    assert sidecar(root)["design.md"]["size"] == 3


def test_add_from_stdin_needs_a_name(root, monkeypatch, capsys):
    stdin_bytes(monkeypatch, b"handoff notes\n")
    with pytest.raises(SystemExit):
        run_cli(root, ["doc", "add", "beta", "-"])
    assert "--name" in capsys.readouterr().err
    stdin_bytes(monkeypatch, b"handoff notes\n")
    run_cli(root, ["doc", "add", "beta", "-", "--name", "handoff.md"])
    assert (doc_dir(root) / "handoff.md").read_bytes() == b"handoff notes\n"


@pytest.mark.parametrize("name", ["a/b.md", ".hidden", "x" * 121, ""])
def test_add_refuses_names_that_are_not_plain_file_names(root, tmp_path, name):
    src = tmp_path / "f.md"
    src.write_text("x")
    with pytest.raises(SystemExit):
        run_cli(root, ["doc", "add", "beta", str(src), "--name", name])
    assert not doc_dir(root).exists()


def test_add_refuses_a_doc_over_the_limit(root, tmp_path, monkeypatch):
    monkeypatch.setattr(docs, "MAX_BYTES", 4)
    src = tmp_path / "big.bin"
    src.write_bytes(b"12345")
    with pytest.raises(SystemExit):
        run_cli(root, ["doc", "add", "beta", str(src)])


def test_path_prints_the_absolute_path(root, tmp_path, capsys):
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "beta", str(src)])
    capsys.readouterr()
    run_cli(root, ["doc", "path", "beta", "plan.md"])
    out = capsys.readouterr().out.strip()
    assert out == str((doc_dir(root) / "plan.md").resolve())
    with pytest.raises(SystemExit):
        run_cli(root, ["doc", "path", "beta", "nope.md"])


def test_rm_deletes_the_doc(root, tmp_path):
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "beta", str(src)])
    run_cli(root, ["doc", "rm", "beta", "plan.md"])
    assert not (doc_dir(root) / "plan.md").exists()
    assert "plan.md" not in sidecar(root)
    assert store.resolve_item(root, "beta")["docs"] == []
    with pytest.raises(SystemExit):
        run_cli(root, ["doc", "rm", "beta", "plan.md"])


def test_docs_lists_name_size_who_and_the_path_on_a_local_store(root, tmp_path, capsys):
    src = tmp_path / "plan.md"
    src.write_text("x" * 2048)
    run_cli(root, ["doc", "add", "beta", str(src)])
    capsys.readouterr()
    run_cli(root, ["docs", "beta"])
    line = capsys.readouterr().out.strip()
    assert line.startswith("plan.md")
    assert "2.0 KB" in line and "tester" in line
    assert line.endswith(str((doc_dir(root) / "plan.md").resolve()))


def test_a_file_dropped_in_by_hand_is_a_doc_whose_author_is_unknown(root, tmp_path, capsys):
    run_cli(root, ["docs", "beta"])
    assert capsys.readouterr().out.strip() == "(no docs)"
    doc_dir(root).mkdir(parents=True)
    (doc_dir(root) / "notes.txt").write_text("by hand")
    got = store.resolve_item(root, "beta")["docs"]
    assert [(d["name"], d["by"]) for d in got] == [("notes.txt", None)]
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "beta", str(src)])
    assert sidecar(root)["notes.txt"]["by"] == "tester"


def test_get_lists_docs(root, tmp_path, capsys):
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "beta", str(src)])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    out = capsys.readouterr().out
    assert "\ndocs:\n  plan.md" in out


def test_docs_move_with_the_item(root, tmp_path):
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "beta", str(src)])
    run_cli(root, ["defer", "beta"])
    assert item_dir(root).parent.name == store.DEFERRED
    assert (doc_dir(root) / "plan.md").read_text() == "x"


# ── sync ─────────────────────────────────────────────────────────────────────
@pytest.fixture
def server():
    return FakeServer()


@pytest.fixture
def pair(tmp_path, server, monkeypatch):
    """A has an item with plan.md, synced; B has adopted it."""
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    src = tmp_path / "plan.md"
    src.write_text("v1\n")
    run_cli(a, ["doc", "add", "login-bug", str(src)])
    assert rnd(a, server, "alice").error is None
    assert rnd(b, server, "bob", adopt=True).error is None
    return a, b


def server_doc(server, name):
    hits = [r for r in server.rows.values() if r["_entity"] == "doc" and r["name"] == name]
    return hits[0] if hits else None


def test_a_doc_uploads_and_reaches_the_other_store(pair, server):
    a, b = pair
    row = server_doc(server, "plan.md")
    assert row["by"] == "alice" and row["size"] == 3
    assert server.blobs[row["file_key"]] == b"v1\n"
    assert row["file_key"].startswith("p/docs/")
    assert (doc_dir(b, "login-bug") / "plan.md").read_text() == "v1\n"
    for root in (a, b):
        meta = sidecar(root, "login-bug")["plan.md"]
        assert meta["base"] == row["sha256"] and meta["by"] == "alice"


def test_a_round_with_nothing_changed_uploads_nothing(pair, server):
    a, _ = pair
    before = len(server.uploads)
    assert rnd(a, server, "alice").error is None
    assert len(server.uploads) == before


def test_an_edit_in_place_uploads_the_new_hash(pair, server, monkeypatch):
    a, b = pair
    (doc_dir(a, "login-bug") / "plan.md").write_text("v2, edited in place\n")
    assert rnd(a, server, "alice").error is None
    row = server_doc(server, "plan.md")
    assert row["sha256"] == docs.sha256_bytes(b"v2, edited in place\n")
    assert server.blobs[row["file_key"]] == b"v2, edited in place\n"
    assert sidecar(a, "login-bug")["plan.md"]["base"] == row["sha256"]
    assert rnd(b, server, "bob").error is None
    assert (doc_dir(b, "login-bug") / "plan.md").read_text() == "v2, edited in place\n"


def test_two_writers_conflict_and_neither_copy_is_lost(pair, server, monkeypatch):
    a, b = pair
    (doc_dir(a, "login-bug") / "plan.md").write_text("alice's edit\n")
    (doc_dir(b, "login-bug") / "plan.md").write_text("bob's edit\n")
    assert rnd(a, server, "alice").error is None
    monkeypatch.setenv("TODO_USER", "bob")
    report = rnd(b, server, "bob")
    assert report.error is None
    d = doc_dir(b, "login-bug")
    assert (d / "plan.md").read_text() == "alice's edit\n"
    assert (d / "plan.conflict-bob.md").read_text() == "bob's edit\n"
    assert any("plan.conflict-bob.md" in m for m in report.messages)
    assert server.blobs[server_doc(server, "plan.conflict-bob.md")["file_key"]] == b"bob's edit\n"
    assert server_doc(server, "plan.md")["by"] == "alice"
    monkeypatch.setenv("TODO_USER", "alice")
    assert rnd(a, server, "alice").error is None
    assert (doc_dir(a, "login-bug") / "plan.conflict-bob.md").read_text() == "bob's edit\n"


def test_a_dashboard_upload_comes_down_on_the_next_round(pair, server):
    a, _ = pair
    uid = store.resolve_item(a, "login-bug")["uid"]
    server.dashboard_put(uid, "mock.html", b"<h1>hi</h1>", "carol")
    assert rnd(a, server, "alice").error is None
    assert (doc_dir(a, "login-bug") / "mock.html").read_bytes() == b"<h1>hi</h1>"
    assert sidecar(a, "login-bug")["mock.html"]["by"] == "carol"


def test_a_dashboard_replace_and_delete_come_down(pair, server):
    a, _ = pair
    uid = store.resolve_item(a, "login-bug")["uid"]
    server.dashboard_put(uid, "plan.md", b"replaced\n", "carol")
    assert rnd(a, server, "alice").error is None
    assert (doc_dir(a, "login-bug") / "plan.md").read_text() == "replaced\n"
    server.dashboard_delete(uid, "plan.md")
    assert rnd(a, server, "alice").error is None
    assert not (doc_dir(a, "login-bug") / "plan.md").exists()
    assert "plan.md" not in sidecar(a, "login-bug")


def test_a_local_delete_removes_the_doc_on_the_server(pair, server):
    a, b = pair
    run_cli(a, ["doc", "rm", "login-bug", "plan.md"])
    assert rnd(a, server, "alice").error is None
    assert server_doc(server, "plan.md") is None
    assert rnd(b, server, "bob").error is None
    assert not (doc_dir(b, "login-bug") / "plan.md").exists()


def test_an_edit_survives_a_delete_on_the_server(pair, server):
    a, _ = pair
    uid = store.resolve_item(a, "login-bug")["uid"]
    server.dashboard_delete(uid, "plan.md")
    (doc_dir(a, "login-bug") / "plan.md").write_text("kept\n")
    assert rnd(a, server, "alice").error is None
    assert (doc_dir(a, "login-bug") / "plan.md").read_text() == "kept\n"
    assert server.blobs[server_doc(server, "plan.md")["file_key"]] == b"kept\n"


def test_docs_on_a_synced_store_link_to_the_dashboard(pair, capsys):
    a, _ = pair
    capsys.readouterr()
    run_cli(a, ["docs", "login-bug"])
    line = capsys.readouterr().out.strip()
    assert line.endswith("http://fake/p/p/i/login-bug/docs/plan.md")


# ── the HTTP client ──────────────────────────────────────────────────────────
class _Recorder:
    """A tiny HTTP server that answers each path with a canned JSON body and
    records what it got."""

    def __init__(self, answers):
        import http.server
        import json
        import threading

        seen = self.seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def _any(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                status, out = answers.get(self.path.split("?")[0], (404, {"error": "no"}))
                raw = out if isinstance(out, bytes) else json.dumps(out).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PUT = do_DELETE = _any

            def log_message(self, *a):
                pass

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


def _form(headers, body):
    from email.parser import BytesParser

    msg = BytesParser().parsebytes(f"content-type: {headers['content-type']}\r\n\r\n".encode() + body)
    return {part.get_param("name", header="content-disposition"): part for part in msg.get_payload()}


def test_an_upload_to_the_bucket_posts_the_form_without_the_token():
    bucket = _Recorder({"/b": (204, b"")})
    api = _Recorder({"/api/projects/p/docs/upload": (200, {
        "key": "p/docs/K.md", "url": bucket.url + "/b", "fields": {"key": "p/docs/K.md", "Policy": "x"},
        "content_type": "text/markdown"})})
    try:
        key = remote.Remote(api.url, "tok").doc_upload("p", "I1", "plan.md", b"# hi\n")
        assert key == "p/docs/K.md"
        _, _, headers, body = bucket.seen[0]
        assert "authorization" not in headers
        form = _form(headers, body)
        assert list(form) == ["key", "Policy", "file"]
        assert form["file"].get_payload(decode=True) == b"# hi\n"
        assert form["file"].get_content_type() == "text/markdown"
        assert form["file"].get_filename() == "plan.md"
    finally:
        bucket.close()
        api.close()


def test_an_upload_through_the_app_sends_the_token():
    api = _Recorder({"/api/projects/p/docs/upload": (200, {
        "key": "p/docs/K.md", "url": "/api/files/p/docs/K.md", "fields": {}, "content_type": "text/markdown"}),
        "/api/files/p/docs/K.md": (204, b"")})
    try:
        remote.Remote(api.url, "tok").doc_upload("p", "I1", "plan.md", b"x")
        method, path, headers, _ = api.seen[1]
        assert (method, path) == ("POST", "/api/files/p/docs/K.md")
        assert headers["authorization"] == "Bearer tok"
    finally:
        api.close()


def test_a_server_without_docs_leaves_the_round_clean(tmp_path, monkeypatch):
    s = FakeServer()
    root = make(tmp_path, "a", s)
    run_cli(root, ["add", "Login bug"])
    src = tmp_path / "plan.md"
    src.write_text("x")
    run_cli(root, ["doc", "add", "login-bug", str(src)])
    client = s.client("tester")

    def gone(*a, **k):
        raise remote.RemoteError("404 not found", 404)

    monkeypatch.setattr(type(client), "doc_upload", gone)
    report = sync.run_round(root, client)
    assert report.error is None and report.messages == []
