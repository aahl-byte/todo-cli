"""The YAML engine and durable read/write core.

Data durability (lens-data-durability): the store is a precious, comment-rich
planning artifact, so every mutation (1) re-parses its file fresh off disk —
last-write-wins on the LATEST content, never a stale copy — via ruamel's
round-trip API which PRESERVES comments and surrounding structure, and (2)
writes atomically (temp file + os.replace) so a crash mid-write can never
truncate a file.

This mirrors the web TODO drawer's durability contract (manager/sources/todos.ts
in the watchtower repo) — keep the two in sync if the contract or the store
shape changes.
"""

import io
import os
import re
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import SingleQuotedScalarString


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


_reader = None


def read(file: Path):
    """Parse for reading only — plain dicts/lists via the C loader, several times
    faster than the round-trip parser. Timestamps stay strings, as in `yaml()`."""
    global _reader
    if _reader is None:
        _reader = YAML(typ="safe")
        _reader.constructor.add_constructor("tag:yaml.org,2002:timestamp",
                                            lambda c, n: n.value)
    return _reader.load(file.read_text())


def dump(y: YAML, data) -> str:
    """Render to text. ruamel appends a trailing space when it re-folds a long
    plain scalar across lines, so trailing whitespace is stripped per line to
    keep untouched values byte-identical in git."""
    buf = io.StringIO()
    y.dump(data, buf)
    return "".join(line.rstrip() + "\n" for line in buf.getvalue().splitlines())


def write_atomic(file: Path, text: str) -> None:
    """Temp sibling + rename, so a crash mid-write never truncates `file`."""
    tmp = file.with_name(file.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, file)


def save(y: YAML, file: Path, data) -> None:
    write_atomic(file, dump(y, data))


# Titles left unquoted in a flow map. Anything else is quoted: the C loader
# (YAML 1.1) rejects plain flow scalars that ruamel's emitter (YAML 1.2) allows.
_PLAIN_TITLE = re.compile(r"^[A-Za-z0-9][\w .\-/()]*$")


def tasks_doc(tasks) -> CommentedMap:
    """Build a TASKS.yaml document — `tasks:` with one compact flow map
    `{id, title, status}` per task. The phase lives in the directory name."""
    seq = CommentedSeq()
    for t in tasks:
        m = CommentedMap()
        m["id"] = int(t["id"])
        title = str(t["title"])
        m["title"] = title if _PLAIN_TITLE.match(title) else SingleQuotedScalarString(title)
        m["status"] = str(t["status"])
        m.fa.set_flow_style()
        seq.append(m)
    doc = CommentedMap()
    doc["tasks"] = seq
    return doc
