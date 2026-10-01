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
