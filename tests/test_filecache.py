from todo import filecache, yamlio


def test_a_file_is_parsed_again_only_once_it_changes(tmp_path):
    f = tmp_path / "a.yaml"
    f.write_text("n: 1\n")
    calls = []

    def parse(file):
        calls.append(file)
        return yamlio._read(file)

    assert filecache.parsed(f, parse) == {"n": 1}
    assert filecache.parsed(f, parse) == {"n": 1}
    yamlio.write_atomic(f, "n: 2\n")
    assert filecache.parsed(f, parse) == {"n": 2}
    assert len(calls) == 2


def test_callers_get_their_own_copy(tmp_path):
    f = tmp_path / "a.yaml"
    f.write_text("tags: [x]\n")
    yamlio.read(f)["tags"].append("y")
    assert yamlio.read(f) == {"tags": ["x"]}


def test_a_saved_cache_serves_a_later_run(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    root = tmp_path / ".TODO"
    root.mkdir()
    f = root / "a.yaml"
    f.write_text("n: 1\n")
    yamlio.read(f)
    filecache.save(root)
    filecache._parsed.clear()
    filecache.load(root)
    assert filecache.parsed(f, lambda file: "parsed again") == {"n": 1}
