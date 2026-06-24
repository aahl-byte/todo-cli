"""Shared fixtures: a temp TODO.yaml the store/CLI can mutate in isolation."""

from pathlib import Path

import pytest

SAMPLE = """\
# Project TODO — edit through the `todo` CLI.
todos:
  - id: alpha
    title: ALPHA
    type: feature
    status: in-progress
    priority: medium
    phase: null
    created: 2026-06-24T10:00:00.000Z
    completed: null
    notes:
      - first note
  - id: beta
    title: BETA
    type: feature
    status: todo
    priority: medium
    phase: null
    created: 2026-06-24T11:00:00.000Z
    completed: null
    notes: []
"""


@pytest.fixture
def todo_file(tmp_path) -> Path:
    f = tmp_path / "TODO.yaml"
    f.write_text(SAMPLE)
    return f
