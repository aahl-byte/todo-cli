"""Global store (symlink) link/unlink/projects + worktree resolution.

These exercise real symlinks and (where available) real `git`, mirroring how the
feature works in the field. Symlink-hostile platforms skip rather than fail.
"""

import argparse
import os
import shutil
import subprocess

import pytest

from todo import cli, link, migrate, store

from .conftest import TS, make_store

BODY = "todos:\n  - id: foo\n    title: FOO\n    status: todo\n"


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    """Point the global store at a temp HOME so tests never touch ~/.todo."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(link.Path, "home", classmethod(lambda cls: home))
    return home


@pytest.fixture(autouse=True)
def _symlinks(tmp_path):
    try:
        (tmp_path / ".__probe").symlink_to(".")
        (tmp_path / ".__probe").unlink()
    except (OSError, NotImplementedError):
        pytest.skip("platform has no symlink support")


def _repo(parent, name="repo", body=BODY):
    repo = parent / name
    make_store(repo, body)
    return repo


# ── link ──────────────────────────────────────────────────────────────────────
def test_link_creates_symlink_with_meta_and_gitignore(tmp_path):
    repo = _repo(tmp_path)
    link.link(repo, None)

    local = repo / ".TODO"
    assert local.is_symlink()
    store_dir = link.global_root() / "repo"
    assert local.resolve() == (store_dir / ".TODO").resolve()
    assert (store_dir / "meta.yaml").read_text().startswith("# Linked store")
    meta = link._meta_of(store_dir)
    assert meta["linked_from"] == str(repo)
    assert meta["key"] == "repo"
    assert ".TODO" in (repo / ".gitignore").read_text().split()
    assert store.resolve_item(local, "foo")["id"] == "foo"


def test_link_is_idempotent(tmp_path):
    repo = _repo(tmp_path)
    link.link(repo, None)
    assert "Already linked" in link.link(repo, None)


def test_link_then_mutation_preserves_meta(tmp_path):
    repo = _repo(tmp_path)
    link.link(repo, None)
    local = repo / ".TODO"

    store.update_todo(local, "foo", {"status": "done"}, TS)
    store.add_note(local, "foo", "through the link", TS)

    assert link._linked_from(link.global_root() / "repo") == str(repo)
    notes = store.resolve_item(local, "foo")["notes"]
    assert [n["text"] for n in notes] == ["through the link"]


def test_link_name_collision_with_different_repo_suffixes(tmp_path):
    repo_a = _repo(tmp_path / "a-side", "repo")
    repo_b = _repo(tmp_path / "b-side", "repo")

    link.link(repo_a, None)
    msg = link.link(repo_b, None)
    assert link._linked_from(link.global_root() / "repo") == str(repo_a)
    assert "repo-" in msg


def test_link_explicit_name_refuses_to_hijack(tmp_path):
    repo_a = _repo(tmp_path / "alpha", "repo")
    repo_b = _repo(tmp_path / "beta", "repo")

    link.link(repo_a, "shared")
    with pytest.raises(SystemExit):
        link.link(repo_b, "shared")


# ── unlink ────────────────────────────────────────────────────────────────────
def test_unlink_round_trips_content(tmp_path):
    body = "todos:\n  - id: foo\n    title: FOO\n    status: in-progress\n    notes:\n      - keep me\n"
    repo = _repo(tmp_path, body=body)

    link.link(repo, None)
    link.unlink(repo)

    local = repo / ".TODO"
    assert local.is_dir() and not local.is_symlink()
    notes = store.resolve_item(local, "foo")["notes"]
    assert [n["text"] for n in notes] == ["keep me"]
    assert not (link.global_root() / "repo").exists()


def test_unlink_on_real_dir_errors(tmp_path):
    repo = _repo(tmp_path)
    with pytest.raises(SystemExit):
        link.unlink(repo)


# ── failure handling ──────────────────────────────────────────────────────────
def test_symlink_failure_restores_repo(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path)

    def boom(*a, **k):
        raise OSError(1314, "A required privilege is not held by the client")
    monkeypatch.setattr(link.os, "symlink", boom)

    with pytest.raises(SystemExit):
        link.link(repo, None)

    local = repo / ".TODO"
    assert local.is_dir() and not local.is_symlink()
    assert store.resolve_item(local, "foo")["id"] == "foo"
    assert not (link.global_root() / "repo").exists()
    err = capsys.readouterr().err
    assert "could not create symlink" in err and "1314" in err


# ── projects ──────────────────────────────────────────────────────────────────
def test_projects_lists_linked_stores(tmp_path):
    repo = _repo(tmp_path)
    link.link(repo, None)

    rows = link.projects()
    assert rows == [{"key": "repo", "count": 1, "linked_from": str(repo)}]


def test_project_stores_migrate_legacy_single_file_stores(tmp_path):
    store_dir = link.global_root() / "old"
    store_dir.mkdir(parents=True)
    (store_dir / "TODO.yaml").write_text(
        "meta:\n  linked_from: /somewhere/old\n  key: old\n" + BODY)

    stores = link.project_stores()
    assert stores == [{"key": "old", "root": store_dir / ".TODO",
                       "linked_from": "/somewhere/old"}]
    assert store.resolve_item(stores[0]["root"], "foo")["id"] == "foo"
    assert (store_dir / ".migrated" / "TODO.yaml").is_file()


# ── legacy linked repos ───────────────────────────────────────────────────────
def test_legacy_symlinked_todo_yaml_becomes_dir_symlink(tmp_path):
    store_dir = link.global_root() / "repo"
    store_dir.mkdir(parents=True)
    (store_dir / "TODO.yaml").write_text("meta:\n  linked_from: x\n" + BODY)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "TODO.yaml").symlink_to(store_dir / "TODO.yaml")

    root = migrate.migrate_repo(repo)

    assert not (repo / "TODO.yaml").exists() and not (repo / "TODO.yaml").is_symlink()
    assert (repo / ".TODO").is_symlink()
    assert root.resolve() == (store_dir / ".TODO").resolve()
    assert (store_dir / "meta.yaml").is_file()
    assert ".TODO" in (repo / ".gitignore").read_text().split()


def test_dangling_legacy_symlink_follows_an_already_migrated_store(tmp_path):
    store_dir = link.global_root() / "repo"
    store_dir.mkdir(parents=True)
    (store_dir / "TODO.yaml").write_text(BODY)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "TODO.yaml").symlink_to(store_dir / "TODO.yaml")
    link.project_stores()                       # `list -g` migrates the store first

    root = migrate.migrate_repo(repo)
    assert store.resolve_item(root, "foo")["id"] == "foo"


# ── cross-project list (todo list -g) ─────────────────────────────────────────
def test_list_all_projects_defaults_to_active(tmp_path, capsys):
    body = ("todos:\n"
            "  - id: hot\n    title: HOT\n    status: in-progress\n"
            "  - id: cold\n    title: COLD\n    status: todo\n"
            "  - id: gone\n    title: GONE\n    status: done\n")
    repo = _repo(tmp_path, body=body)
    link.link(repo, None)

    args = argparse.Namespace(all_projects=True, status=None, all=False)
    cli.cmd_list(repo / ".TODO", args)
    out = capsys.readouterr().out
    assert "hot" in out
    assert "cold" not in out and "gone" not in out


# ── worktree resolution fallback ──────────────────────────────────────────────
@pytest.mark.skipif(not shutil.which("git"), reason="git not available")
def test_worktree_shares_linked_store(tmp_path, monkeypatch):
    repo = _repo(tmp_path)

    def git(*args):
        subprocess.run(["git", *args], cwd=repo, check=True,
                       capture_output=True, text=True)
    git("init", "-q")
    git("config", "user.email", "a@b.c")
    git("config", "user.name", "x")
    link.link(repo, None)
    git("add", "-A")
    git("commit", "-qm", "init")

    wt = tmp_path / "wt"
    subprocess.run(["git", "worktree", "add", "-q", str(wt)], cwd=repo,
                   check=True, capture_output=True, text=True)
    assert not (wt / ".TODO").exists()

    monkeypatch.chdir(wt)
    assert cli._resolve_root(".TODO") == (repo / ".TODO").resolve()
