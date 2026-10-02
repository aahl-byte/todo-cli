"""Shared fixtures: a temp `.TODO/` store the store/CLI can mutate in isolation,
built by migrating a legacy TODO.yaml."""

from pathlib import Path

import pytest

from todo import migrate

TS = "2026-06-25T09:30:00.000Z"

SAMPLE = """\
# Project TODO — edit through the `todo` CLI.
todos:
  - id: alpha
    title: ALPHA
    type: feature
    status: in-progress
    priority: medium
    super-phase: null
    created: 2026-06-24T10:00:00.000Z
    completed: null
    notes:
      - first note
  - id: beta
    title: BETA
    type: feature
    status: todo
    priority: medium
    super-phase: null
    created: 2026-06-24T11:00:00.000Z
    completed: null
    notes: []
"""


def make_store(project: Path, body: str = SAMPLE) -> Path:
    project.mkdir(parents=True, exist_ok=True)
    (project / "TODO.yaml").write_text(body)
    return migrate.migrate_repo(project)


@pytest.fixture
def root(tmp_path) -> Path:
    return make_store(tmp_path / "proj")


def bare(rows, keys=("id", "title", "status", "phase")):
    """Rows cut down to `keys`, for comparing without generated uids."""
    return [{k: r[k] for k in keys if k in r} for r in rows]


@pytest.fixture(autouse=True)
def _identity(monkeypatch):
    """Every test acts as human `tester` unless it says otherwise."""
    from todo import identity

    monkeypatch.setenv("TODO_USER", "tester")
    monkeypatch.setenv("TODO_VIA", "human")
    monkeypatch.delenv("CLAUDECODE", raising=False)
    identity.set_via(None)
    yield
    identity.set_via(None)


def run_cli(root, argv):
    """Parse argv and dispatch like main(), against an explicit store."""
    from todo import identity
    from todo.cli import build_parser

    args = build_parser().parse_args(argv)
    if getattr(args, "via", None):
        identity.set_via(args.via)
    try:
        args.func(Path(root), args)
    finally:
        identity.set_via(None)
