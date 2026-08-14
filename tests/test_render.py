from todo import render


def _item(**over):
    base = {
        "id": "x", "title": "X", "type": "feature", "status": "in-progress",
        "priority": "medium", "super_phase": None, "notes": [], "log": [], "tasks": [],
        "calc_status": None, "created": None, "completed": None,
    }
    base.update(over)
    return base


def test_print_tasks_lists_ids(capsys):
    it = _item(tasks=[{"id": 1, "title": "one", "status": "done"},
                      {"id": 2, "title": "two", "status": "todo"}],
               calc_status="todo")
    render.print_tasks(it)
    out = capsys.readouterr().out
    assert "[1]" in out and "one" in out
    assert "[2]" in out and "two" in out
    assert "calc-status" in out


def test_print_tasks_empty(capsys):
    render.print_tasks(_item())
    assert "no tasks" in capsys.readouterr().out


def test_print_item_includes_tasks_block(capsys):
    it = _item(tasks=[{"id": 1, "title": "one", "status": "done"}], calc_status="done")
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


def test_task_phase_column_appears_only_when_present(capsys):
    it = _item(tasks=[{"id": 1, "title": "one", "status": "done", "phase": 1},
                      {"id": 2, "title": "two", "status": "todo", "phase": None}])
    render.print_tasks(it)
    out = capsys.readouterr().out
    assert "phase 1" in out          # phased task shows its phase
    assert "two" in out              # unphased task still renders (blank column)


def test_no_phase_column_when_no_task_has_one(capsys):
    it = _item(tasks=[{"id": 1, "title": "one", "status": "done", "phase": None}])
    render.print_tasks(it)
    assert "phase" not in capsys.readouterr().out


def test_print_item_shows_super_phase(capsys):
    render.print_item(_item(super_phase=3))
    assert "super-phase: 3" in capsys.readouterr().out


def test_print_grouped_headers_and_indented_items(capsys):
    groups = [
        {"key": "alpha", "items": [_item(id="a1", title="One")]},
        {"key": "beta", "items": [_item(id="b1", title="Two", status="blocked")]},
    ]
    render.print_grouped(groups)
    out = capsys.readouterr().out
    assert "alpha\n" in out and "beta\n" in out          # project headers
    assert "  a1" in out and "  b1" in out               # items indented
    assert out.index("alpha") < out.index("beta")        # discovery order kept


def test_print_grouped_drops_empty_groups(capsys):
    groups = [
        {"key": "alpha", "items": []},                   # filtered out entirely
        {"key": "beta", "items": [_item(id="b1")]},
    ]
    render.print_grouped(groups)
    out = capsys.readouterr().out
    assert "alpha" not in out and "beta" in out


def test_print_grouped_empty(capsys):
    render.print_grouped([{"key": "alpha", "items": []}])
    assert "no items" in capsys.readouterr().out
