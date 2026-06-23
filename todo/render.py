"""Terminal rendering for list and single-item views. Statuses are colorized
(purple `review`, red `blocked`, etc.) only when stdout is a real TTY, so piped
or redirected output stays plain."""

import sys

from .status import colorize


def _use_color() -> bool:
    return sys.stdout.isatty()


def print_list(items) -> None:
    if not items:
        print("(no items)")
        return
    color = _use_color()
    w = min(28, max(len(i["id"]) for i in items))
    for it in items:
        status = it["status"]
        cell = colorize(status, f"{status:<12}", color)
        print(f'{it["id"]:<{w}}  {cell} {(it["priority"] or "—"):<8} {it["title"]}')


def print_item(it) -> None:
    color = _use_color()
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {colorize(it["status"], it["status"], color)}')
    print(f'priority:  {it["priority"] or "—"}')
    if it["phase"] is not None:
        print(f'phase:     {it["phase"]}')
    print(f'created:   {it["created"] or "—"}')
    if it["completed"]:
        print(f'completed: {it["completed"]}')
    if it["notes"]:
        print("notes:")
        for i, n in enumerate(it["notes"]):
            print(f'  [{i}] ' + str(n).replace("\n", "\n      "))
