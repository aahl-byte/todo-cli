from todo import render


def _item(**over):
    base = {
        "id": "x", "title": "X", "type": "feature", "status": "in-progress",
        "priority": "medium", "phase": None, "notes": [], "tasks": [],
        "calc_status": None, "created": None, "completed": None,
    }
    base.update(over)
    return base


def test_print_tasks_lists_indices(capsys):
    it = _item(tasks=[{"title": "one", "status": "done"},
                      {"title": "two", "status": "todo"}],
               calc_status="todo")
    render.print_tasks(it)
    out = capsys.readouterr().out
    assert "[0]" in out and "one" in out
    assert "[1]" in out and "two" in out
    assert "calc-status" in out


def test_print_tasks_empty(capsys):
    render.print_tasks(_item())
    assert "no tasks" in capsys.readouterr().out


def test_print_item_includes_tasks_block(capsys):
    it = _item(tasks=[{"title": "one", "status": "done"}], calc_status="done")
    render.print_item(it)
    out = capsys.readouterr().out
    assert "tasks:" in out
    assert "one" in out
    assert "calc-status:" in out


def test_print_list_marks_items_with_tasks(capsys):
    items = [_item(id="withkids",
                   tasks=[{"title": "a", "status": "done"},
                          {"title": "b", "status": "todo"}],
                   calc_status="todo"),
             _item(id="plain")]
    render.print_list(items)
    out = capsys.readouterr().out
    assert "1/2 tasks" in out  # 1 of 2 done
