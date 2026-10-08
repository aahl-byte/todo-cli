"""Project Actions run by the CLI: fill an Action's templates from an item and
send it. Mirrors server/lib/actions/{model,deliver}.ts; the server owns the
definitions (docs/plans/2026-10-08-actions-design.md)."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ANY_STATUS = "*"
DEFAULT_PROMPT = "/todo {{item.id}}"
INITIAL_PROMPT_MAX = 200
TIMEOUT = 15
IDLE_WAIT = 90
IDLE_POLL = 2
SNIPPET = 300

PLACEHOLDER = re.compile(r"\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}")


class ActionError(Exception):
    """The Action's endpoint couldn't be reached or refused the call."""


def fires_on(action: dict, frm: str, to: str) -> bool:
    return frm != to and any(r.get("to") == to and r.get("from") in (ANY_STATUS, frm)
                             for r in action.get("auto") or [])


def item_vars(project: str, it: dict, frm: str, actor: str, server_url: str = "") -> dict:
    repo = it.get("repo") or ""
    return {
        "item.id": it["id"], "item.title": it["title"], "item.status": it["status"], "item.from": frm,
        "item.type": it.get("type") or "", "item.priority": it.get("priority") or "",
        "item.app": it.get("app") or "", "item.section": it.get("section") or "",
        "item.repo": repo, "item.repo_name": repo.rsplit("/", 1)[-1], "item.branch": it.get("branch") or "",
        "item.developer": it.get("developer") or "", "item.qa": it.get("qa_assignee") or "",
        "item.url": f'{server_url.rstrip("/")}/p/{project}/i/{it["id"]}' if server_url else "",
        "project": project, "actor": actor,
    }


def fill(text: str, vars_: dict) -> str:
    def one(m):
        value = vars_.get(m.group(1), "")
        if m.group(2) == "json":
            return json.dumps(value)
        if m.group(2) == "url":
            return urllib.parse.quote(value, safe="")
        return value
    return PLACEHOLDER.sub(one, text)


def render(action: dict, vars_: dict) -> dict:
    if action["kind"] == "rest":
        method = action.get("method") or "POST"
        body = action.get("body") or ""
        return {"kind": "rest", "method": method, "url": fill(action.get("url") or "", vars_),
                "headers": {k: fill(v, vars_) for k, v in (action.get("headers") or {}).items()},
                "body": None if method in ("GET", "DELETE") or not body else fill(body, vars_)}
    req = {"kind": "watchtower", "base": (action.get("base") or "").rstrip("/"),
           "dir": fill(action.get("dir") or "", vars_), "name": f'todo: {vars_["item.id"]}',
           "prompt": fill(action.get("prompt") or DEFAULT_PROMPT, vars_)}
    if action.get("model"):
        req["model"] = action["model"]
    return req


def _call(method: str, url: str, headers: dict, body: str | None, opener=urllib.request.urlopen):
    req = urllib.request.Request(url, data=body.encode() if body is not None else None, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with opener(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")[:SNIPPET]
        raise ActionError(f"{method} {url} answered {e.code}" + (f": {text}" if text else "")) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise ActionError(f"{method} {url} failed: {getattr(e, 'reason', e)}") from None


def _json(method: str, url: str, body=None, opener=urllib.request.urlopen) -> dict:
    headers = {"content-type": "application/json"} if body is not None else {}
    _, text = _call(method, url, headers, json.dumps(body) if body is not None else None, opener)
    try:
        return json.loads(text) if text else {}
    except ValueError:
        raise ActionError(f"{method} {url} didn't answer with JSON") from None


def _fits_initial_prompt(prompt: str) -> bool:
    return len(prompt) <= INITIAL_PROMPT_MAX and not any(ord(ch) < 32 for ch in prompt)


def deliver(req: dict, opener=urllib.request.urlopen, sleep=time.sleep) -> str:
    """Send a rendered Action; returns the line for the item's dev log."""
    if req["kind"] == "rest":
        status, _ = _call(req["method"], req["url"], req["headers"], req["body"], opener)
        return f'{req["method"]} {req["url"]} → {status}'
    base = req["base"]
    sessions = _json("GET", f"{base}/api/roster", opener=opener).get("sessions") or []
    live = next((s for s in sessions if s.get("name") == req["name"] and s.get("state") == "active"
                 and s.get("managed")), None)
    if live:
        sent = _json("POST", f'{base}/api/sessions/{live["id"]}/message',
                     {"text": req["prompt"], "from": "todo"}, opener)
        return f'sent to Watchtower session {req["name"]} ({sent.get("delivered", "sent")}): {live.get("url")}'
    inline = _fits_initial_prompt(req["prompt"])
    body = {"dir": req["dir"], "name": req["name"]}
    if req.get("model"):
        body["model"] = req["model"]
    if inline:
        body["initialPrompt"] = req["prompt"]
    started = _json("POST", f"{base}/api/sessions", body, opener)
    if not inline:
        deadline = time.monotonic() + IDLE_WAIT
        while True:
            s = _json("GET", f'{base}/api/sessions/{started["id"]}', opener=opener)
            if s.get("status") == "idle":
                break
            if s.get("status") == "waiting":
                raise ActionError(f'session {started["id"]} is waiting on {s.get("waitingFor") or "a person"}: '
                                  f'{started.get("url")}')
            if time.monotonic() > deadline:
                raise ActionError(f'session {started["id"]} never went idle: {started.get("url")}')
            sleep(IDLE_POLL)
        _json("POST", f'{base}/api/sessions/{started["id"]}/message', {"text": req["prompt"], "from": "todo"}, opener)
    return f'started Watchtower session {req["name"]} in {req["dir"]}: {started.get("url")}'
