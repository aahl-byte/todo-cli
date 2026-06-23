"""Terminal rendering for the list and single-item views."""


def print_list(items) -> None:
    if not items:
        print("(no items)")
        return
    w = min(28, max(len(i["id"]) for i in items))
    for it in items:
        print(f'{it["id"]:<{w}}  {it["status"]:<12} {(it["priority"] or "—"):<8} {it["title"]}')


def print_item(it) -> None:
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {it["status"]}')
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
