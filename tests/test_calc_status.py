from todo.status import derive_calc_status


def test_no_tasks_returns_none():
    assert derive_calc_status([]) is None


def test_all_done():
    assert derive_calc_status(["done", "done"]) == "done"


def test_all_deferred():
    assert derive_calc_status(["deferred", "deferred"]) == "deferred"


def test_deferred_excluded_from_done_check():
    # the only non-deferred task is done → parent done
    assert derive_calc_status(["done", "deferred"]) == "done"


def test_in_progress_dominates():
    assert derive_calc_status(["todo", "in-progress", "done"]) == "in-progress"


def test_blocked_when_nothing_in_progress():
    assert derive_calc_status(["todo", "blocked", "done"]) == "blocked"


def test_precedence_order():
    # in-progress > blocked > review > in-triage > todo
    assert derive_calc_status(["review", "in-triage", "todo"]) == "review"
    assert derive_calc_status(["in-triage", "todo"]) == "in-triage"


def test_some_done_rest_todo_is_todo():
    # nothing active; highest present among the precedence list is todo
    assert derive_calc_status(["done", "todo"]) == "todo"


def test_all_cancelled():
    assert derive_calc_status(["cancelled", "cancelled"]) == "cancelled"


def test_cancelled_excluded_from_done_check():
    assert derive_calc_status(["done", "cancelled"]) == "done"


def test_cancelled_and_deferred_mix_is_deferred():
    # nothing live, but a deferred task may still come back
    assert derive_calc_status(["cancelled", "deferred"]) == "deferred"


def test_cancelled_does_not_mask_live_work():
    assert derive_calc_status(["cancelled", "in-progress"]) == "in-progress"
