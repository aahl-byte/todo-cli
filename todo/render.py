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


def print_item(it) -> None:
    color = _use_color()
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {colorize(it["status"], it["status"], color)}')
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
    print(f'priority:  {it["priority"] or "—"}')
    if it["super_phase"] is not None:
        print(f'super-phase: {it["super_phase"]}')
    print(f'created:   {it["created"] or "—"}')
    if it["completed"]:
        print(f'completed: {it["completed"]}')
    if it["notes"]:
        print("notes:")
        for n in it["notes"]:
            print(f'  [{n["id"]}] ' + str(n["text"]).replace("\n", "\n      "))
    if it["tasks"]:
        print("tasks:")
        for line in _task_lines(it["tasks"], color):
            print(line)


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
