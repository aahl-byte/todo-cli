"""YAML front matter on note, log and history files.

    ---
    uid: 01J9…
    kind: comment
    author: alice
    ---
    the Markdown body

A leading `---` block counts as front matter only when it parses to a map with
a `uid` or `kind`, so a legacy note that opens with a Markdown rule stays a body.
"""

from __future__ import annotations

import io

from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import LiteralScalarString

_FENCE = "---"
_KEYS = ("uid", "kind")
_reader = YAML(typ="safe")
_reader.constructor.add_constructor("tag:yaml.org,2002:timestamp", lambda c, n: n.value)


def split(text: str) -> tuple:
    """(meta, body). `meta` is {} when the file has no front matter."""
    if not text.startswith(_FENCE + "\n"):
        return {}, text
    end = text.find("\n" + _FENCE + "\n", len(_FENCE))
    if end == -1:
        if text.endswith("\n" + _FENCE):
            end = len(text) - len(_FENCE) - 1
        else:
            return {}, text
    try:
        meta = _reader.load(text[len(_FENCE) + 1:end + 1])
    except Exception:  # noqa: BLE001 — not YAML: a legacy body
        return {}, text
    if not isinstance(meta, dict) or not any(k in meta for k in _KEYS):
        return {}, text
    if meta.get("uid") is not None:
        meta["uid"] = str(meta["uid"])
    return meta, text[end + len(_FENCE) + 2:]


def _dumper() -> YAML:
    y = YAML()
    y.width = 4096
    y.default_flow_style = False
    y.representer.add_representer(
        type(None), lambda r, _d: r.represent_scalar("tag:yaml.org,2002:null", "null"))
    return y


def join(meta: dict, body: str) -> str:
    """Front matter + body. Empty `meta` writes the bare body."""
    if not meta:
        return body
    clean = {}
    for k, v in meta.items():
        if v is None:
            continue
        clean[k] = LiteralScalarString(v) if isinstance(v, str) and "\n" in v else v
    buf = io.StringIO()
    _dumper().dump(clean, buf)
    return f"{_FENCE}\n{buf.getvalue()}{_FENCE}\n{body}"


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
