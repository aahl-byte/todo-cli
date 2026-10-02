"""Automatic conversion of a legacy TODO.yaml into a `.TODO/` store."""

import shutil
import subprocess

import pytest

from todo import cli, migrate, store

from .conftest import SAMPLE, bare


def test_first_command_migrates_and_backs_up_untracked_file(tmp_path, monkeypatch):
    (tmp_path / "TODO.yaml").write_text(SAMPLE)
    monkeypatch.chdir(tmp_path)

    root = cli._resolve_root(".TODO")

    assert root == (tmp_path / ".TODO").resolve()
    assert not (tmp_path / "TODO.yaml").exists()
    assert (root / ".migrated" / "TODO.yaml").read_text() == SAMPLE
    assert {it["id"] for it in store.list_todos(root)} == {"alpha", "beta"}


def test_items_land_in_their_status_folder(tmp_path):
    body = ("todos:\n"
            "  - {id: a, title: A, status: deferred}\n"
            "  - {id: b, title: B, status: cancelled}\n"
            "  - {id: c, title: C, status: done}\n")
    root = migrate.migrate_repo(_project(tmp_path, body))
    assert (root / "DEFERRED" / "a").is_dir()
    assert (root / "CANCELLED" / "b").is_dir()
    assert (root / "OPEN" / "c").is_dir()


def test_archive_files_migrate_and_colliding_ids_get_suffixed(tmp_path):
    project = _project(tmp_path, "todos:\n  - {id: a, title: A, status: todo}\n")
    archive = project / "ARCHIVE" / "TODO"
    archive.mkdir(parents=True)
    (archive / "todo_1.yaml").write_text(
        "todos:\n  - {id: a, title: OLD A, status: done}\n"
        "  - {id: x, title: X, status: cancelled}\n")

    root = migrate.migrate_repo(project)

    assert (root / "ARCHIVED" / "a-2").is_dir()
    assert (root / "CANCELLED" / "x").is_dir()
    assert not (project / "ARCHIVE").exists()
    assert (root / ".migrated" / "ARCHIVE" / "TODO" / "todo_1.yaml").is_file()


def test_log_timestamps_survive_and_notes_take_created(tmp_path):
    body = ("todos:\n"
            "  - id: a\n    title: A\n    status: todo\n"
            "    created: 2026-05-01T08:00:00.000Z\n"
            "    notes: [{id: 2, text: why}]\n"
            "    log: [{id: 1, ts: 2026-05-02T09:10:11.123Z, text: did}]\n")
    root = migrate.migrate_repo(_project(tmp_path, body))
    item = root / "OPEN" / "a"
    assert [p.name for p in (item / "notes").iterdir()] == ["2026-05-01T08-00-00.000Z-2.md"]
    log = store.resolve_item(root, "a")["log"]
    assert bare(log, ("id", "ts", "text")) == [{"id": 1, "ts": "2026-05-02T09:10:11.123Z", "text": "did"}]


def test_flow_style_items_are_written_as_block_maps(tmp_path):
    body = ("todos: [{id: a, title: a long title that wraps past the eighty column limit of the dumper,\n"
            "    status: todo, created: 2026-05-01T08:00:00.000Z}]\n")
    root = migrate.migrate_repo(_project(tmp_path, body))
    meta = (root / "OPEN" / "a" / "TODO.yaml").read_text()
    assert meta.startswith("id: a\n")
    assert store.list_todos(root)[0]["title"].startswith("a long title")


def test_crashed_partial_migration_is_rebuilt(tmp_path):
    project = _project(tmp_path, SAMPLE)
    (project / ".TODO.migrating" / "OPEN" / "junk").mkdir(parents=True)
    root = migrate.migrate_repo(project)
    assert not (root / "OPEN" / "junk").exists()
    assert not (project / ".TODO.migrating").exists()


@pytest.mark.skipif(not shutil.which("git"), reason="git not available")
def test_git_tracked_file_is_deleted_not_backed_up(tmp_path):
    project = _project(tmp_path, SAMPLE)
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "add", "TODO.yaml"], cwd=project, check=True)

    root = migrate.migrate_repo(project)
    assert not (root / ".migrated").exists()
    assert not (project / "TODO.yaml").exists()


@pytest.mark.skipif(not shutil.which("git"), reason="git not available")
def test_ignored_todo_yaml_means_dot_todo_is_ignored_too(tmp_path):
    project = _project(tmp_path, SAMPLE)
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    (project / ".gitignore").write_text("TODO.yaml\n")

    migrate.migrate_repo(project)
    assert (project / ".gitignore").read_text().split() == ["TODO.yaml", ".TODO"]


def _project(tmp_path, body):
    project = tmp_path / "proj"
    project.mkdir()
    (project / "TODO.yaml").write_text(body)
    return project
