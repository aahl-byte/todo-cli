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
from ruamel.yaml.error import YAMLError
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


_readers = {}


def _reader(pure: bool) -> YAML:
    if pure not in _readers:
        r = YAML(typ="safe", pure=pure)
        r.constructor.add_constructor("tag:yaml.org,2002:timestamp", lambda c, n: n.value)
        _readers[pure] = r
    return _readers[pure]


def read(file: Path):
    """Parse for reading only — plain dicts/lists via the C loader, several times
    faster than the round-trip parser. Timestamps stay strings, as in `yaml()`.
    Flow maps the C loader (YAML 1.1) rejects fall back to the pure loader."""
    text = file.read_text()
    try:
        return _reader(False).load(text)
    except YAMLError:
        return _reader(True).load(text)


def _block(node) -> None:
    if isinstance(node, (CommentedMap, CommentedSeq)):
        node.fa.set_block_style()
        for child in (node.values() if isinstance(node, CommentedMap) else node):
            _block(child)


def to_block(file: Path) -> bool:
    """Rewrite `file` in block style if the C loader rejects it. Writes only
    when the result parses to the same data under both loaders."""
    text = file.read_text()
    try:
        _reader(False).load(text)
        return False
    except YAMLError:
        pass
    y, data = load(file)
    _block(data)
    out = dump(y, data)
    if _reader(False).load(out) != _reader(True).load(text):
        return False
    write_atomic(file, out)
    return True


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


def _text(value: str):
    return value if _PLAIN_TITLE.match(value) else SingleQuotedScalarString(value)


def _flow_doc(key: str, rows, fields) -> CommentedMap:
    seq = CommentedSeq()
    for row in rows:
        m = CommentedMap()
        for name, kind in fields:
            value = row.get(name)
            if value is None:
                if kind == "optional":
                    continue
                if kind == "nullable":
                    m[name] = None
                    continue
            if name == "id":
                m[name] = int(value)
            elif kind in ("text", "nullable"):
                m[name] = _text(str(value))
            else:
                m[name] = str(value)
        m.fa.set_flow_style()
        seq.append(m)
    doc = CommentedMap()
    doc[key] = seq
    return doc


def tasks_doc(tasks) -> CommentedMap:
    """Build a TASKS.yaml document — `tasks:` with one compact flow map
    `{id, uid, title, status}` per task. The phase lives in the directory name."""
    return _flow_doc("tasks", tasks, [("id", "plain"), ("uid", "optional"),
                                      ("title", "text"), ("status", "plain")])


def checks_doc(checks) -> CommentedMap:
    """Build a CHECKS.yaml document — `checks:` with one flow map per
    deployment check."""
    return _flow_doc("checks", checks, [
        ("id", "plain"), ("uid", "optional"), ("kind", "plain"), ("title", "text"),
        ("payload", "nullable"), ("timing", "plain"), ("status", "plain")])
