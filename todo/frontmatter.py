"""The metadata block on note and log files, and plain YAML maps for history.

A note keeps its Markdown first and its metadata last, in an HTML comment that
Markdown renderers hide:

    the Markdown body

    <!--todo
    uid: 01J9…
    kind: comment
    author: alice
    -->

Older files carry the same map as leading YAML front matter (`---` … `---`);
they still read, and `migrate.convert_note_meta` rewrites them. A block counts
only when it parses to a map with a `uid` or `kind`, so a note that merely
contains a rule or a comment stays a body.
"""

from __future__ import annotations

import io
import re

from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import LiteralScalarString

_FENCE = "---"
_KEYS = ("uid", "kind")
_OPEN = "<!--todo"
_CLOSE = "-->"
# The last `<!--todo … -->` block, ending the file. YAML indents every line of a
# multi-line value, so no line inside the block is exactly `-->`.
_TRAILER = re.compile(r"(?:\A|\n)<!--todo\n(?P<yaml>(?:.*\n)*?)-->\s*\Z")
_reader = YAML(typ="safe")
_reader.constructor.add_constructor("tag:yaml.org,2002:timestamp", lambda c, n: n.value)


def _meta(text: str):
    try:
        meta = _reader.load(text)
    except Exception:  # noqa: BLE001 — not YAML: part of the body
        return None
    return meta if isinstance(meta, dict) and any(k in meta for k in _KEYS) else None


def split(text: str) -> tuple:
    """(meta, body). `meta` is {} when the file has no metadata block. The body
    keeps one trailing newline, as written."""
    m = _TRAILER.search(text)
    if m:
        meta = _meta(m.group("yaml"))
        if meta is not None:
            body = text[:m.start()].rstrip("\n")
            return meta, body + "\n" if body else ""
    return _split_front(text)


def _split_front(text: str) -> tuple:
    """Leading `---` front matter, the older layout."""
    if not text.startswith(_FENCE + "\n"):
        return {}, text
    end = text.find("\n" + _FENCE + "\n", len(_FENCE))
    if end == -1:
        if text.endswith("\n" + _FENCE):
            end = len(text) - len(_FENCE) - 1
        else:
            return {}, text
    meta = _meta(text[len(_FENCE) + 1:end + 1])
    if meta is None:
        return {}, text
    return meta, text[end + len(_FENCE) + 2:]


def has_front_matter(text: str) -> bool:
    return bool(_split_front(text)[0])


def _dumper() -> YAML:
    y = YAML()
    y.width = 4096
    y.default_flow_style = False
    y.representer.add_representer(
        type(None), lambda r, _d: r.represent_scalar("tag:yaml.org,2002:null", "null"))
    return y


def join(meta: dict, body: str) -> str:
    """Body first, then the metadata block. Empty `meta` writes the bare body."""
    if not meta:
        return body
    clean = {}
    for k, v in meta.items():
        if v is None:
            continue
        clean[k] = LiteralScalarString(v) if isinstance(v, str) and "\n" in v else v
    buf = io.StringIO()
    _dumper().dump(clean, buf)
    text = body.rstrip("\n")
    return f"{text}\n\n{_OPEN}\n{buf.getvalue()}{_CLOSE}\n" if text else f"{_OPEN}\n{buf.getvalue()}{_CLOSE}\n"


def dump_map(data: dict) -> str:
    """A plain YAML map, for history files."""
    buf = io.StringIO()
    _dumper().dump({k: v for k, v in data.items() if v is not None}, buf)
    return buf.getvalue()


def load_map(text: str) -> dict:
    try:
        data = _reader.load(text)
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}
