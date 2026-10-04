"""Terminal rendering for list and single-item views. Statuses are colorized
(purple `review`, red `blocked`, etc.) only when stdout is a real TTY, so piped
or redirected output stays plain."""

import re
import sys

from .status import COMPLETE, PAST_TRIAGE, colorize


def _use_color() -> bool:
    return sys.stdout.isatty()


def _item_line(it, w, color, indent="") -> str:
    status = it["status"]
    cell = colorize(status, f"{status:<12}", color)
    mark = ""
    if it["tasks"]:
        done = sum(1 for t in it["tasks"] if t["status"] in COMPLETE)
        mark = f'  ({done}/{len(it["tasks"])} tasks)'
    return f'{indent}{it["id"]:<{w}}  {cell} {(it["priority"] or "—"):<8} {it["title"]}{mark}'


def print_list(items) -> None:
    if not items:
        print("(no items)")
        return
    color = _use_color()
    w = min(28, max(len(i["id"]) for i in items))
    for it in items:
        print(_item_line(it, w, color))


def print_grouped(groups) -> None:
    """Cross-project view: one header per project, its items indented beneath.
    `groups` is a list of {key, items}. The id column is aligned across every
    item in every group so the status/priority columns line up globally."""
    groups = [g for g in groups if g["items"]]
    if not groups:
        print("(no items)")
        return
    color = _use_color()
    all_items = [it for g in groups for it in g["items"]]
    w = min(28, max(len(i["id"]) for i in all_items))
    for i, g in enumerate(groups):
        if i:
            print()
        print(g["key"])
        for it in g["items"]:
            print(_item_line(it, w, color, indent="  "))


LOG_PREVIEW = 3   # entries `todo get` shows before eliding the rest


def _stamp(ts: str) -> str:
    """`2026-08-14T15:02:11.483Z` → `2026-08-14 15:02`; anything else passes
    through as-is."""
    return ts[:16].replace("T", " ") if len(ts) >= 16 else ts


def _log_lines(entries) -> list:
    return [f'  [{e["id"]}] {_stamp(e["ts"])}  ' + str(e["text"]).replace("\n", "\n      ")
            for e in entries]


FILES = re.compile(r"\]\((/api/files/[^)\s]+)\)")


def absolute_files(text: str, base: str | None) -> str:
    """Point `/api/files/…` image links at the server, so they can be opened."""
    return FILES.sub(lambda m: f"]({base.rstrip('/')}{m.group(1)})", text) if base else text


def print_item(it, full_log: bool = False, related=(), server: str | None = None) -> None:
    color = _use_color()
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {colorize(it["status"], it["status"], color)}')
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
    print(f'priority:  {it["priority"] or "—"}')
    if it.get("app") or it.get("section"):
        print(f'app:       {it.get("app") or "—"}' + (f' · {it["section"]}' if it.get("section") else ""))
    for label, key in (("creator", "creator"), ("developer", "developer"), ("qa", "qa_assignee")):
        print(f'{label + ":":<11}{it.get(key) or "—"}')
    if it["super_phase"] is not None:
        print(f'super-phase: {it["super_phase"]}')
    print(f'created:   {it["created"] or "—"}')
    if it["completed"]:
        print(f'completed: {it["completed"]}')
    notes = it.get("notes") or []
    requests = [n for n in notes if n.get("kind") == "ticket-request"]
    if requests:
        req = current_request(requests)
        print(f"request:   {request_label(req, it['status'])}")
        url = (req.get("meta") or {}).get("url")
        if url:
            print(f"  {url}")
        print("  " + absolute_files(str(req["text"]).strip(), server).replace("\n", "\n  "))
    notes = [n for n in notes if n.get("kind") not in ("ticket-request", "relation")]
    if related:
        print("related:")
        for r in related:
            print(f'  {colorize(r["status"], r["status"].ljust(12), color)} {r["id"]}  {r["title"]}')
    open_qs = [n for n in notes if _is_open_question(n)]
    if open_qs:
        print("open questions:")
        for line in note_lines(open_qs):
            print(line)
    rest = [n for n in notes if not _is_open_question(n)]
    if rest:
        print("notes:")
        for line in note_lines(rest):
            print(line)
    if it["log"]:
        print("log:")
        entries = it["log"] if full_log else it["log"][-LOG_PREVIEW:]
        hidden = len(it["log"]) - len(entries)
        if hidden:
            print(f'  … {hidden} earlier (todo logs {it["id"]})')
        for line in _log_lines(entries):
            print(line)
    if it["tasks"]:
        print("tasks:")
        for line in _task_lines(it["tasks"], color, it.get("phases")):
            print(line)
    if it.get("checks"):
        print("checks:")
        for line in _check_lines(it["checks"]):
            print(line)
    if it.get("history"):
        print("history:")
        entries = it["history"][-LOG_PREVIEW:]
        hidden = len(it["history"]) - len(entries)
        if hidden:
            print(f'  … {hidden} earlier (todo history {it["id"]})')
        for line in _history_lines(entries, color):
            print(line)


def _version(n) -> int:
    return int((n.get("meta") or {}).get("version") or 1)


def current_request(requests):
    """The highest request version; the newest note wins a tie."""
    return max(requests, key=lambda n: (_version(n), n["id"]))


def request_label(req, status: str) -> str:
    meta = req.get("meta") or {}
    label = f"v{_version(req)} [{req['id']}]"
    if status in PAST_TRIAGE and not meta.get("triaged"):
        label += " (untriaged)"
    elif not meta.get("frozen") and not meta.get("version"):
        label += " (unsynced)"
    return label


def _is_open_question(n) -> bool:
    return n.get("kind") == "clarification" and (n.get("meta") or {}).get("state") != "answered"


def _note_tag(n) -> str:
    kind = n.get("kind") or "context"
    if kind == "context":
        return "(AI) " if n.get("via") == "agent" else ""
    parts = [kind]
    meta = n.get("meta") or {}
    if kind == "link" and meta.get("type"):
        parts[0] = f'link · {meta["type"]}'
    if kind == "clarification":
        parts.append(meta.get("state") or "open")
    if n.get("author"):
        parts.append(n["author"])
    if n.get("via") == "agent":
        parts.append("AI")
    return "(" + " · ".join(parts) + ") "


def note_lines(notes, indent: str = "  ") -> list:
    """`[id] (kind · author) text` per note; a link adds its URL, an answered
    clarification its answer."""
    pad = indent + "    "
    out = []
    for n in notes:
        meta = n.get("meta") or {}
        text = str(n["text"])
        if n.get("kind") == "link" and meta.get("url") and meta["url"] != text:
            text += f'  <{meta["url"]}>'
        line = f'{indent}[{n["id"]}] {_note_tag(n)}' + text.replace("\n", "\n" + pad)
        if n.get("kind") == "clarification" and meta.get("answer"):
            who = f' ({meta["answered_by"]})' if meta.get("answered_by") else ""
            line += f"\n{pad}→{who} " + str(meta["answer"]).replace("\n", "\n" + pad)
        out.append(line)
    return out


def _check_lines(checks, item_id: str | None = None) -> list:
    lines = []
    for c in checks:
        box = "[x]" if c["status"] == "done" else "[ ]"
        where = f"{item_id} " if item_id else ""
        timing = "" if item_id else f'{c["timing"]:<11} '
        payload = f'  `{c["payload"]}`' if c.get("payload") else ""
        lines.append(f'  {box} {where}[{c["id"]}] {timing}{c["kind"]:<13} {c["title"]}{payload}')
    return lines


def _history_lines(entries, color) -> list:
    out = []
    for h in entries:
        who = f'  {h["by"]}' if h.get("by") else ""
        via = " (AI)" if h.get("via") == "agent" else ""
        forced = "  forced" if h.get("forced") else ""
        frm = colorize(h["from"] or "", h["from"] or "—", color)
        to = colorize(h["to"] or "", h["to"] or "—", color)
        out.append(f'  [{h["id"]}] {_stamp(h["ts"])}  {frm} → {to}{who}{via}{forced}')
    return out


def print_history(it) -> None:
    if not it["history"]:
        print("(no history)")
        return
    for line in _history_lines(it["history"], _use_color()):
        print(line)


def print_checks(it) -> None:
    if not it["checks"]:
        print("(no checks)")
        return
    for line in _check_lines(it["checks"]):
        print(line)


def print_deploy_plan(ready, after, complete_ids, all_ids) -> None:
    """Pre-deploy then post-deploy checks across the ready items, grouped by
    kind; then deployed items with post-deploy checks still open."""
    from .store import CHECK_KINDS

    if not ready and not after:
        print("(nothing ready to deploy)")
        return
    if ready:
        print("ready to deploy: " + ", ".join(it["id"] for it in ready))
    for timing in ("pre-deploy", "post-deploy"):
        rows = [(it, c) for it in ready for c in it["checks"] if c["timing"] == timing]
        if not rows:
            continue
        print(f"\n{timing}:")
        for kind in CHECK_KINDS:
            group = [(it, c) for it, c in rows if c["kind"] == kind]
            if not group:
                continue
            print(f"  {kind}")
            for it, c in group:
                line = _check_lines([c], it["id"])[0]
                if (kind == "prereq-branch" and c.get("payload")
                        and c["payload"] in all_ids and c["payload"] not in complete_ids):
                    line += "  ⚠ not deployed"
                print("  " + line)
    if after:
        print("\ndeployed — post-deploy pending:")
        for it in after:
            for c in it["checks"]:
                if c["timing"] == "post-deploy" and c["status"] != "done":
                    print("  " + _check_lines([c], it["id"])[0])


def _task_lines(tasks, color, titles=None) -> list:
    """One `  [id] <status> [phase N] <title>` line per task. The phase column
    appears only when at least one task carries a phase, so phase-less items
    render exactly as before. A named phase gets a `phase N · title` header."""
    titles = titles or {}
    phased = [t for t in tasks if t.get("phase") is not None]
    pw = max((len(f'phase {t["phase"]}') for t in phased), default=0)
    lines = []
    shown = set()
    for t in tasks:
        cell = colorize(t["status"], f'{t["status"]:<12}', color)
        if pw:
            ptxt = f'phase {t["phase"]}' if t.get("phase") is not None else ""
            pcell = f'{ptxt:<{pw}}  '
        else:
            pcell = ""
        key = str(t.get("phase"))
        if key in titles and key not in shown:
            shown.add(key)
            lines.append(f'  phase {key} · {titles[key]}')
        lines.append(f'  [{t["id"]}] {cell} {pcell}{t["title"]}')
    for key, title in titles.items():
        if key not in shown:
            lines.append(f'  phase {key} · {title}  (no tasks)')
    return lines


def print_log(it, limit=None) -> None:
    entries = it["log"]
    if not entries:
        print("(no log entries)")
        return
    for line in _log_lines(entries[-limit:] if limit else entries):
        print(line)


def print_tasks(it) -> None:
    tasks = it["tasks"]
    if not tasks and not it.get("phases"):
        print("(no tasks)")
        return
    color = _use_color()
    for line in _task_lines(tasks, color, it.get("phases")):
        print(line)
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')


def print_inbox(rows) -> None:
    for r in rows:
        mark = " " if r.get("read_at") else "•"
        when = _stamp(str(r.get("created") or ""))
        what = {"mention": "mentioned you", "qa-rejection": "QA rejected",
                "clarification": "asked a question", "answer": "answered your question",
                "ready-for-qa": "ready for your QA", "deployed": "deployed"}.get(r["kind"], r["kind"])
        who = f' {r["note_author"]}' if r.get("note_author") else ""
        print(f'{mark} {when}  {r["project"]}/{r["item_id"]}  {what}{who}  — {r["item_title"]}')
        if r.get("note_text"):
            print("      " + str(r["note_text"]).replace("\n", "\n      "))
