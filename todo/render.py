"""Terminal rendering for list and single-item views. Statuses are colorized
(purple `review`, red `blocked`, etc.) only when stdout is a real TTY, so piped
or redirected output stays plain."""

import sys

from .status import colorize


def _use_color() -> bool:
    return sys.stdout.isatty()


def _item_line(it, w, color, indent="") -> str:
    status = it["status"]
    cell = colorize(status, f"{status:<12}", color)
    mark = ""
    if it["tasks"]:
        done = sum(1 for t in it["tasks"] if t["status"] == "done")
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


def print_item(it, full_log: bool = False) -> None:
    color = _use_color()
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {colorize(it["status"], it["status"], color)}')
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
    print(f'priority:  {it["priority"] or "—"}')
    for label, key in (("creator", "creator"), ("developer", "developer"), ("qa", "qa_assignee")):
        if it.get(key):
            print(f'{label + ":":<11}{it[key]}')
    if it["super_phase"] is not None:
        print(f'super-phase: {it["super_phase"]}')
    print(f'created:   {it["created"] or "—"}')
    if it["completed"]:
        print(f'completed: {it["completed"]}')
    notes = it.get("notes") or []
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
        for line in _task_lines(it["tasks"], color):
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


def _task_lines(tasks, color) -> list:
    """One `  [id] <status> [phase N] <title>` line per task. The phase column
    appears only when at least one task carries a phase, so phase-less items
    render exactly as before."""
    phased = [t for t in tasks if t.get("phase") is not None]
    pw = max((len(f'phase {t["phase"]}') for t in phased), default=0)
    lines = []
    for t in tasks:
        cell = colorize(t["status"], f'{t["status"]:<12}', color)
        if pw:
            ptxt = f'phase {t["phase"]}' if t.get("phase") is not None else ""
            pcell = f'{ptxt:<{pw}}  '
        else:
            pcell = ""
        lines.append(f'  [{t["id"]}] {cell} {pcell}{t["title"]}')
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
    if not tasks:
        print("(no tasks)")
        return
    color = _use_color()
    for line in _task_lines(tasks, color):
        print(line)
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
