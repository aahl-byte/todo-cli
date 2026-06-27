"""Global store (symlink) link/unlink/projects + worktree resolution.

These exercise real symlinks and (where available) real `git`, mirroring how the
feature works in the field. Symlink-hostile platforms skip rather than fail.
"""

import os
import shutil
import subprocess

import pytest

from todo import cli, link, store, yamlio


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    """Point the global store at a temp HOME so tests never touch ~/.todo."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(link.Path, "home", classmethod(lambda cls: home))
    return home


def _repo(parent, name="repo", body="todos:\n  - id: foo\n    title: FOO\n    status: todo\n"):
    repo = parent / name
    repo.mkdir(parents=True)
    (repo / "TODO.yaml").write_text(body)
    return repo


def _supports_symlink(p):
    try:
        (p / ".__probe").symlink_to(".")
        (p / ".__probe").unlink()
        return True
    except (OSError, NotImplementedError):
        return False


# ── link ──────────────────────────────────────────────────────────────────────
def test_link_creates_symlink_with_meta_and_gitignore(tmp_path):
    repo = _repo(tmp_path)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")
    local = repo / "TODO.yaml"

    link.link(local, None)

    assert local.is_symlink()
    target = link.global_root() / "repo" / "TODO.yaml"
    assert local.resolve() == target.resolve()
    # header comment + meta block are visible through the link
    text = local.read_text()
    assert text.startswith("# Linked store")
    meta = link._meta_of(target)
    assert meta["linked_from"] == str(repo)
    assert meta["key"] == "repo"
    # gitignore gained the entry, and the foo item still resolves through the link
    assert "TODO.yaml" in (repo / ".gitignore").read_text().split()
    assert store.resolve_item(local, "foo")["id"] == "foo"


def test_link_is_idempotent(tmp_path):
    repo = _repo(tmp_path)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")
    local = repo / "TODO.yaml"
    link.link(local, None)
    msg = link.link(local, None)
    assert "Already linked" in msg


def test_link_then_mutation_preserves_meta(tmp_path):
    repo = _repo(tmp_path)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")
    local = repo / "TODO.yaml"
    link.link(local, None)

    store.update_todo(local, "foo", {"status": "done"}, "2026-06-27T00:00:00.000Z")
    store.update_todo(local, "foo", {"notes": ["through the link"]})

    meta = link._meta_of(local.resolve())
    assert meta["linked_from"] == str(repo)          # survived two mutations
    assert store.resolve_item(local, "foo")["notes"] == ["through the link"]


def test_link_name_collision_with_different_repo_suffixes(tmp_path):
    # two distinct repos that share the basename "repo"
    repo_a = _repo(tmp_path / "a-side", "repo")
    repo_b = _repo(tmp_path / "b-side", "repo")
    if not _supports_symlink(repo_a):
        pytest.skip("platform has no symlink support")

    link.link(repo_a / "TODO.yaml", None)
    msg = link.link(repo_b / "TODO.yaml", None)
    # b cannot reuse a's key; it gets a path-hash suffix, not a hijack
    assert link._linked_from(link.global_root() / "repo" / "TODO.yaml") == str(repo_a)
    assert "repo-" in msg


def test_link_explicit_name_refuses_to_hijack(tmp_path):
    repo_a = _repo(tmp_path / "alpha", "repo")
    repo_b = _repo(tmp_path / "beta", "repo")
    if not _supports_symlink(repo_a):
        pytest.skip("platform has no symlink support")

    link.link(repo_a / "TODO.yaml", "shared")
    with pytest.raises(SystemExit):
        link.link(repo_b / "TODO.yaml", "shared")


# ── unlink ────────────────────────────────────────────────────────────────────
def test_unlink_round_trips_content(tmp_path):
    body = "todos:\n  - id: foo\n    title: FOO\n    status: in-progress\n    notes:\n      - keep me\n"
    repo = _repo(tmp_path, body=body)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")
    local = repo / "TODO.yaml"

    link.link(local, None)
    link.unlink(local)

    assert not local.is_symlink()
    text = local.read_text()
    assert "meta:" not in text and "Linked store" not in text
    assert store.resolve_item(local, "foo")["notes"] == ["keep me"]
    # the now-empty store dir is cleaned up
    assert not (link.global_root() / "repo").exists()


def test_unlink_on_real_file_errors(tmp_path):
    repo = _repo(tmp_path)
    with pytest.raises(SystemExit):
        link.unlink(repo / "TODO.yaml")


# ── failure handling ──────────────────────────────────────────────────────────
def test_symlink_failure_restores_repo(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path)
    local = repo / "TODO.yaml"
    original = local.read_text()

    def boom(*a, **k):
        raise OSError(1314, "A required privilege is not held by the client")
    monkeypatch.setattr(link.os, "symlink", boom)

    with pytest.raises(SystemExit):
        link.link(local, None)

    # repo left exactly as found: real file, original bytes, no leftover store
    assert not local.is_symlink()
    assert local.read_text() == original
    assert not (link.global_root() / "repo").exists()
    err = capsys.readouterr().err
    assert "could not create symlink" in err and "1314" in err


# ── projects ──────────────────────────────────────────────────────────────────
def test_projects_lists_linked_stores(tmp_path):
    repo = _repo(tmp_path)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")
    link.link(repo / "TODO.yaml", None)

    rows = link.projects()
    assert len(rows) == 1
    assert rows[0]["key"] == "repo"
    assert rows[0]["count"] == 1
    assert rows[0]["linked_from"] == str(repo)


# ── worktree resolution fallback ──────────────────────────────────────────────
@pytest.mark.skipif(not shutil.which("git"), reason="git not available")
def test_worktree_shares_linked_store(tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    if not _supports_symlink(repo):
        pytest.skip("platform has no symlink support")

    def git(*args):
        subprocess.run(["git", *args], cwd=repo, check=True,
                       capture_output=True, text=True)
    git("init", "-q")
    git("config", "user.email", "a@b.c")
    git("config", "user.name", "x")
    link.link(repo / "TODO.yaml", None)
    git("add", "-A")
    git("commit", "-qm", "init")

    wt = tmp_path / "wt"
    subprocess.run(["git", "worktree", "add", "-q", str(wt)], cwd=repo,
                   check=True, capture_output=True, text=True)
    assert not (wt / "TODO.yaml").exists()      # worktree has no local file

    resolved = cli._worktree_todo(wt)
    assert resolved is not None
    assert resolved.resolve() == (repo / "TODO.yaml").resolve()
