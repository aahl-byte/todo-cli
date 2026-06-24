from todo import store


def test_comments_and_timestamps_survive_task_mutation(todo_file):
    before = todo_file.read_text()
    assert "# Project TODO" in before  # sanity: fixture has a comment

    store.add_task(todo_file, "alpha", "a new task")
    after = todo_file.read_text()

    # the leading comment is preserved
    assert "# Project TODO" in after
    # alpha's created timestamp is byte-identical (no datetime churn)
    assert "2026-06-24T10:00:00.000Z" in after
    # beta (untouched item) timestamp also intact
    assert "2026-06-24T11:00:00.000Z" in after
    # the existing note survives
    assert "first note" in after
    # the task landed
    assert "a new task" in after
