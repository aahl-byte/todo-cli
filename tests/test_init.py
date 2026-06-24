from todo import init


def _write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def test_sync_adds_updates_and_prunes(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    _write(src / "SKILL.md", "v2")
    _write(src / "ref/extra.md", "new")     # a nested new file
    _write(dst / "SKILL.md", "v1")          # exists, differs → updated
    _write(dst / "stale.md", "gone")        # not in src → removed

    changes = dict(init._sync_dir(src, dst))

    assert changes["SKILL.md"] == "updated"
    assert changes["ref/extra.md"] == "added"
    assert changes["stale.md"] == "removed"
    # dst now mirrors src exactly
    assert (dst / "SKILL.md").read_text() == "v2"
    assert (dst / "ref/extra.md").read_text() == "new"
    assert not (dst / "stale.md").exists()


def test_sync_reports_unchanged_when_identical(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    _write(src / "SKILL.md", "same")
    _write(dst / "SKILL.md", "same")
    assert init._sync_dir(src, dst) == []


def test_sync_prunes_emptied_subdirs(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    _write(src / "SKILL.md", "x")
    _write(dst / "SKILL.md", "x")
    _write(dst / "old/legacy.md", "y")      # whole subtree should vanish
    init._sync_dir(src, dst)
    assert not (dst / "old").exists()
