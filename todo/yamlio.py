"""The YAML engine and durable read/write core.

Data durability (lens-data-durability): TODO.yaml is a precious, comment-rich
planning artifact, so every mutation (1) re-parses the file fresh off disk —
last-write-wins on the LATEST content, never a stale copy — via ruamel's
round-trip API which PRESERVES comments and surrounding structure, and (2)
writes atomically (temp file + os.replace) so a crash mid-write can never
truncate TODO.yaml.

This mirrors the web TODO drawer's durability contract (manager/sources/todos.ts
in the claude-tmux-manager repo) — keep the two in sync if the contract or the
YAML shape changes.
"""

import io
import os
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import LiteralScalarString


def yaml() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.width = 80                          # match the JS `yaml` lib's default wrap
    y.indent(mapping=2, sequence=4, offset=2)   # match TODO.yaml's existing shape
    # Emit None as `null` (the file's existing style), not an empty scalar.
    y.representer.add_representer(
        type(None),
        lambda r, _d: r.represent_scalar("tag:yaml.org,2002:null", "null"),
    )
    # Treat ISO timestamps as plain STRINGS, not datetimes: keeps `...683Z`
    # byte-for-byte instead of churning it to `...683000Z`. We both construct
    # them as str AND drop the implicit timestamp resolver so they re-emit
    # UNQUOTED (the resolver would otherwise force quotes to preserve str-ness).
    y.constructor.add_constructor("tag:yaml.org,2002:timestamp", lambda c, n: n.value)
    for first in list(y.resolver.versioned_resolver):
        y.resolver.versioned_resolver[first] = [
            t for t in y.resolver.versioned_resolver[first]
            if t[0] != "tag:yaml.org,2002:timestamp"
        ]
    return y


def load(file: Path):
    y = yaml()
    return y, y.load(file.read_text())


def load_or_empty(file: Path):
    """Like load, but a MISSING file yields a fresh empty document — so the
    first `add` into a project with no TODO.yaml creates one. An unreadable
    file still raises."""
    y = yaml()
    try:
        data = y.load(file.read_text())
    except FileNotFoundError:
        data = None
    if data is None:
        data = y.load("todos: []\n")
    return y, data


def save(y: YAML, file: Path, data) -> None:
    """Atomic write: render → temp sibling → rename over the original.

    ruamel appends a trailing space when it re-folds a long plain scalar across
    lines (at the SAME fold point as the JS lib, just with a stray space). We
    strip trailing whitespace per line so untouched notes stay byte-identical in
    git. (Trailing spaces inside a `|` block literal would be content; such notes
    don't occur in practice here, so the simpler global rstrip is worth it.)"""
    buf = io.StringIO()
    y.dump(data, buf)
    text = "".join(line.rstrip() + "\n" for line in buf.getvalue().splitlines())
    tmp = file.with_name(file.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, file)


def notes_node(notes) -> CommentedSeq:
    """Build the `notes:` sequence — one block map `{id, text}` per note, so
    each note carries a constant per-item id that references stay stable against
    (unlike a list index). Multi-line text keeps its `|` block literal for
    readability; single-line text stays a plain scalar. Each note is a dict
    `{"id": int, "text": str}`."""
    seq = CommentedSeq()
    for n in notes:
        m = CommentedMap()
        m["id"] = int(n["id"])
        s = str(n["text"])
        m["text"] = LiteralScalarString(s) if "\n" in s else s
        seq.append(m)
    return seq


def log_node(entries) -> CommentedSeq:
    """Build the `log:` sequence — one block map `{id, ts, text}` per entry. Same
    shape as a note plus the timestamp that makes the log chronological. Each
    entry is a dict `{"id": int, "ts": str, "text": str}`."""
    seq = CommentedSeq()
    for e in entries:
        m = CommentedMap()
        m["id"] = int(e["id"])
        m["ts"] = str(e["ts"])
        s = str(e["text"])
        m["text"] = LiteralScalarString(s) if "\n" in s else s
        seq.append(m)
    return seq


def tasks_node(tasks) -> CommentedSeq:
    """Build the `tasks:` sequence — one compact flow map `{id, title, status}`
    per task, with `phase` appended only when set (keeps phase-less tasks
    byte-identical). `id` is a constant per-item serial so references survive the
    phase re-sort. Rebuilt wholesale on each mutation (like notes); tasks don't
    carry inline comments, so nothing is lost."""
    seq = CommentedSeq()
    for t in tasks:
        m = CommentedMap()
        m["id"] = int(t["id"])
        m["title"] = str(t["title"])
        m["status"] = str(t["status"])
        if t.get("phase") is not None:
            m["phase"] = int(t["phase"])
        m.fa.set_flow_style()
        seq.append(m)
    return seq
