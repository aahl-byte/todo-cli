"""Git facts from real fixture repos: a bare origin plus a clone holding the
store, PRs from a fake GitHub client."""

import subprocess

import pytest

from todo import gitfacts, remote, store, sync

from .conftest import run_cli
from .fake_server import FakeServer

GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
       "-c", "init.defaultBranch=main", "-c", "advice.detachedHead=false"]


def git(cwd, *args) -> str:
    return subprocess.run([*GIT, "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


class Fixture:
    """`origin.git` (bare) and `work`, a clone that holds the store in work/.TODO."""

    def __init__(self, tmp, track="[staging, main]"):
        self.origin, self.work = tmp / "origin.git", tmp / "work"
        git(tmp, "init", "--bare", "-b", "main", str(self.origin))
        git(tmp, "clone", "-q", str(self.origin), str(self.work))
        self.write("README", "hello\n")
        if track is not None:
            self.write(".todo-plugins/plugins.yaml", f"track: {track}\n")
        git(self.work, "commit", "-qm", "init")
        git(self.work, "push", "-q", "origin", "main")
        git(self.work, "remote", "set-head", "origin", "main")
        git(self.work, "branch", "staging")
        git(self.work, "push", "-q", "origin", "staging")
        self.root = self.work / store.ROOT_NAME
        (self.root / store.OPEN).mkdir(parents=True)
        self.prs = {}

    def write(self, path, text):
        f = self.work / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        git(self.work, "add", path)

    def branch(self, name, start="staging"):
        git(self.work, "checkout", "-q", "-b", name, start)

    def commit(self, branch, path, text, msg=None):
        git(self.work, "checkout", "-q", branch)
        self.write(path, text)
        git(self.work, "commit", "-qm", msg or f"{branch}: {path}")
        git(self.work, "push", "-q", "origin", branch)
        return self.sha(branch)

    def squash(self, src, into):
        git(self.work, "checkout", "-q", into)
        git(self.work, "merge", "-q", "--squash", src)
        git(self.work, "commit", "-qm", f"squash {src}")
        git(self.work, "push", "-q", "origin", into)
        return self.sha(into)

    def merge(self, src, into):
        git(self.work, "checkout", "-q", into)
        git(self.work, "merge", "-q", "--no-ff", "-m", f"merge {src}", src)
        git(self.work, "push", "-q", "origin", into)
        return self.sha(into)

    def delete(self, branch):
        git(self.work, "checkout", "-q", "main")
        git(self.work, "push", "-q", "origin", "--delete", branch)
        git(self.work, "branch", "-q", "-D", branch)

    def sha(self, ref):
        return git(self.work, "rev-parse", ref)

    def item(self, title, branches, status="in-progress"):
        it = store.add_todo(self.root, title, "2026-10-23T00:00:00.000Z", status=status)
        store.update_todo(self.root, it["id"], {"branches": branches})
        return it["id"]

    def pr(self, branch, number, base="staging", state="open", merge_commit=None):
        self.prs[branch] = [{"number": number, "state": "closed" if state in ("merged", "closed") else "open",
                             "draft": False, "merged_at": "2026-10-23T00:00:00Z" if state == "merged" else None,
                             "merge_commit_sha": merge_commit, "base": {"ref": base},
                             "html_url": f"https://github.com/acme/web/pull/{number}"}]

    def refresh(self):
        return gitfacts.refresh(self.root)

    def facts(self, item_id):
        return gitfacts.load(self.root, store.resolve_item(self.root, item_id))


@pytest.fixture
def fx(tmp_path, monkeypatch):
    f = Fixture(tmp_path)

    def fake_get(path):
        if "/pulls?" in path:
            head = path.split("head=")[1].split("&")[0]
            branch = head.split(":", 1)[1].replace("%2F", "/")
            return f.prs.get(branch, [])
        return None

    monkeypatch.setattr(gitfacts, "gh_get", fake_get)
    return f


def edge_view(edges):
    return [(e.get("id"), e.get("branch"), e.get("via"), e["state"]) for e in edges]


def stacked(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    fx.branch("feat/b", "feat/a")
    fx.commit("feat/b", "b.txt", "b\n")
    return fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])


def test_stacked_branch_depends_on_the_one_it_was_cut_from(fx):
    a, b = stacked(fx)
    fx.refresh()
    assert edge_view(fx.facts(b)["needs"]) == [(a, "feat/a", "feat/b", "waiting")]
    assert edge_view(fx.facts(a)["needed_by"]) == [(b, "feat/b", "feat/a", "waiting")]
    assert fx.facts(a)["needs"] == [] and fx.facts(b)["needed_by"] == []
    assert fx.facts(b)["needs"][0]["commits"] == [fx.sha("feat/a")[:7]]
    assert fx.facts(b)["waits_on"] == [a]


def test_branches_cut_from_staging_share_nothing(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    fx.branch("feat/b")
    fx.commit("feat/b", "b.txt", "b\n")
    a, b = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    fx.refresh()
    for i in (a, b):
        f = fx.facts(i)
        assert (f["needs"], f["needed_by"], f["conflicts"], f["overlaps"]) == ([], [], [], [])


def test_squash_merged_dependency_resolves_through_landed_in(fx):
    a, b = stacked(fx)
    fx.pr("feat/b", 8)
    squash = fx.squash("feat/a", "staging")
    fx.pr("feat/a", 7, state="merged", merge_commit=squash)
    fx.refresh()
    assert edge_view(fx.facts(b)["needs"]) == [(a, "feat/a", "feat/b", "landed")]
    assert fx.facts(b)["waits_on"] == []
    pr = fx.facts(a)["branches"][0]["pr"]
    assert (pr["number"], pr["state"], pr["base"], pr["merge_commit"]) == (7, "merged", "staging", squash)


def test_squash_merged_dependency_waits_without_a_pr(fx):
    a, b = stacked(fx)
    fx.pr("feat/b", 8)
    fx.squash("feat/a", "staging")
    fx.refresh()
    assert edge_view(fx.facts(b)["needs"]) == [(a, "feat/a", "feat/b", "waiting")]


def test_landed_in_survives_deleting_the_branch(fx):
    fx.branch("feat/a")
    head = fx.commit("feat/a", "a.txt", "a\n")
    a = fx.item("Alpha", ["feat/a"])
    fx.refresh()
    squash = fx.squash("feat/a", "staging")
    fx.pr("feat/a", 7, state="merged", merge_commit=squash)
    fx.delete("feat/a")
    fx.refresh()
    br = fx.facts(a)["branches"][0]
    assert (br["head"], br["gone"], br["landed"]) == (head, True, squash)
    assert br["in"] == {"staging": True, "main": False}


def test_conflicting_edits_are_a_conflict(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "README", "from a\n")
    fx.branch("feat/b")
    fx.commit("feat/b", "README", "from b\n")
    a, b = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    fx.refresh()
    assert [(c["id"], c["branch"], c["via"], c["files"]) for c in fx.facts(a)["conflicts"]] == [
        (b, "feat/b", "feat/a", ["README"])]
    assert [(c["id"], c["files"]) for c in fx.facts(b)["conflicts"]] == [(a, ["README"])]
    assert fx.facts(a)["needs"] == [] and fx.facts(b)["needs"] == []


def test_same_file_edits_that_merge_cleanly_are_an_overlap_only(fx):
    base = "".join(f"line {n}\n" for n in range(20))
    git(fx.work, "checkout", "-q", "staging")
    fx.write("long.txt", base)
    git(fx.work, "commit", "-qm", "long")
    git(fx.work, "push", "-q", "origin", "staging")
    fx.branch("feat/a")
    fx.commit("feat/a", "long.txt", base.replace("line 1\n", "line one\n"))
    fx.branch("feat/b")
    fx.commit("feat/b", "long.txt", base.replace("line 18\n", "line eighteen\n"))
    a, b = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    fx.refresh()
    assert fx.facts(a)["conflicts"] == [] and fx.facts(b)["conflicts"] == []
    assert [(o["id"], o["files"]) for o in fx.facts(a)["overlaps"]] == [(b, ["long.txt"])]
    assert [(o["id"], o["files"]) for o in fx.facts(b)["overlaps"]] == [(a, ["long.txt"])]


def merged_into_staging(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    a = fx.item("Alpha", ["feat/a"])
    squash = fx.squash("feat/a", "staging")
    fx.pr("feat/a", 7, state="merged", merge_commit=squash)
    fx.refresh()
    assert fx.facts(a)["branches"][0]["in"] == {"staging": True, "main": False}
    return a


def test_promoting_staging_by_merge_flips_main(fx):
    a = merged_into_staging(fx)
    fx.merge("staging", "main")
    fx.refresh()
    assert fx.facts(a)["branches"][0]["in"] == {"staging": True, "main": True}


def test_promoting_staging_by_squash_leaves_main_unticked(fx):
    a = merged_into_staging(fx)
    fx.squash("staging", "main")
    fx.refresh()
    assert fx.facts(a)["branches"][0]["in"] == {"staging": True, "main": False}


def test_a_repo_without_track_has_no_landed_in(tmp_path, monkeypatch):
    fx = Fixture(tmp_path, track=None)
    monkeypatch.setattr(gitfacts, "gh_get", lambda path: [])
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    a = fx.item("Alpha", ["feat/a"])
    fx.refresh()
    br = fx.facts(a)["branches"][0]
    assert "in" not in br and br["target"] == "main"


def test_cancelled_dependency_goes_stale(fx):
    a, b = stacked(fx)
    store.update_todo(fx.root, a, {"status": "cancelled"}, "2026-10-23T00:00:00.000Z")
    fx.refresh()
    assert edge_view(fx.facts(b)["needs"]) == [(a, "feat/a", "feat/b", "stale")]


def test_dependency_whose_pr_closed_unmerged_goes_stale(fx):
    a, b = stacked(fx)
    fx.pr("feat/a", 7, state="closed")
    fx.refresh()
    assert fx.facts(b)["needs"][0]["state"] == "stale"


def test_dependency_note_joins_the_edges(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    fx.branch("feat/b")
    fx.commit("feat/b", "b.txt", "b\n")
    a, b = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    store.add_note(fx.root, b, "migrations first", "2026-10-23T00:00:00.000Z", kind="dependency",
                   extra={"needs": f"item:{a}", "in": "staging", "because": "the migration ships with alpha"})
    fx.refresh()
    [e] = fx.facts(b)["needs"]
    assert (e["id"], e["state"], e["source"], e["evidence"]) == (a, "waiting", "plugin", "the migration ships with alpha")
    assert [x["id"] for x in fx.facts(a)["needed_by"]] == [b]
    fx.merge("feat/a", "staging")
    fx.refresh()
    assert fx.facts(b)["needs"][0]["state"] == "landed"


def test_dependency_note_on_a_branch_maps_to_the_item_listing_it(fx):
    fx.branch("feat/a")
    fx.commit("feat/a", "a.txt", "a\n")
    a, b = fx.item("Alpha", ["feat/a"]), fx.item("Beta", [])
    store.add_note(fx.root, b, "x", "2026-10-23T00:00:00.000Z", kind="dependency", extra={"needs": "branch:feat/a"})
    fx.refresh()
    assert edge_view(fx.facts(b)["needs"]) == [(a, "feat/a", None, "waiting")]


def test_git_yaml_lives_in_the_item_folder(fx):
    a, _ = stacked(fx)
    fx.refresh()
    it = store.resolve_item(fx.root, a)
    assert (fx.root / it["folder"] / it["id"] / "git.yaml").is_file()


# ── guards ───────────────────────────────────────────────────────────────────
def test_stage_refuses_while_a_dependency_waits(fx, capsys):
    a, b = stacked(fx)
    store.update_todo(fx.root, b, {"status": "qa-approved"}, "2026-10-23T00:00:00.000Z")
    fx.refresh()
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["stage", b])
    err = capsys.readouterr().err
    assert a in err and "feat/a" in err and "waiting" in err and "--force" in err
    assert store.resolve_item(fx.root, b)["status"] == "qa-approved"


def test_stage_force_goes_through_and_history_records_it(fx, capsys):
    a, b = stacked(fx)
    store.update_todo(fx.root, b, {"status": "qa-approved"}, "2026-10-23T00:00:00.000Z")
    fx.refresh()
    run_cli(fx.root, ["stage", b, "--force"])
    it = store.get_item(fx.root, b)
    assert it["status"] == "ready-to-deploy"
    assert it["history"][-1]["forced"] is True
    assert "forced" in capsys.readouterr().out


def test_deploy_refuses_too(fx):
    _, b = stacked(fx)
    store.update_todo(fx.root, b, {"status": "ready-to-deploy"}, "2026-10-23T00:00:00.000Z")
    fx.refresh()
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["deploy", b])


def test_stage_passes_once_the_dependency_lands(fx):
    a, b = stacked(fx)
    fx.pr("feat/b", 8)
    store.update_todo(fx.root, b, {"status": "qa-approved"}, "2026-10-23T00:00:00.000Z")
    fx.refresh()
    squash = fx.squash("feat/a", "staging")
    fx.pr("feat/a", 7, state="merged", merge_commit=squash)
    run_cli(fx.root, ["stage", b])          # the guard rechecks stale facts before refusing
    it = store.get_item(fx.root, b)
    assert it["status"] == "ready-to-deploy" and it["history"][-1]["forced"] is False


def test_unchecked_dependency_note_blocks_stage(fx):
    fx.branch("feat/b")
    fx.commit("feat/b", "b.txt", "b\n")
    b = fx.item("Beta", ["feat/b"], status="qa-approved")
    store.add_note(fx.root, b, "x", "2026-10-23T00:00:00.000Z", kind="dependency",
                   extra={"needs": "https://github.com/acme/db/pull/3"})
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["stage", b])


# ── display and commands ─────────────────────────────────────────────────────
def test_get_shows_the_git_block(fx, capsys):
    a, b = stacked(fx)
    fx.pr("feat/b", 8)
    fx.refresh()
    run_cli(fx.root, ["get", b])
    out = capsys.readouterr().out
    assert "git:" in out and "feat/b  PR #8 open → staging" in out
    assert "in staging ✗ · in main ✗" in out
    assert "needs:" in out and f"{a} (feat/a) waiting" in out


def test_get_shows_conflict_hint_without_rebase(fx, capsys):
    fx.branch("feat/a")
    fx.commit("feat/a", "README", "from a\n")
    fx.branch("feat/b")
    fx.commit("feat/b", "README", "from b\n")
    a, _ = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    fx.refresh()
    run_cli(fx.root, ["get", a])
    out = capsys.readouterr().out
    assert "conflicts:" in out and "whichever merges second merges the other in" in out
    assert "rebase" not in out


def test_list_flags_waits_on(fx, capsys):
    a, b = stacked(fx)
    fx.refresh()
    run_cli(fx.root, ["list"])
    lines = capsys.readouterr().out.splitlines()
    assert any(l.startswith(b) and f"waits on {a}" in l for l in lines)
    assert not any(l.startswith(a) and "waits on" in l for l in lines)


def test_deps_prints_needs_and_needed_by(fx, capsys):
    a, b = stacked(fx)
    fx.refresh()
    capsys.readouterr()
    run_cli(fx.root, ["deps", a])
    out = capsys.readouterr().out
    assert "needed by:" in out and b in out


def test_deps_from_checks_lists_prereq_branch_checks(fx, capsys):
    b = fx.item("Beta", [])
    run_cli(fx.root, ["check", "add", b, "prereq-branch", "merge", "auth", "first", "--payload", "feat/auth"])
    run_cli(fx.root, ["check", "add", b, "db-script", "run", "it"])
    capsys.readouterr()
    run_cli(fx.root, ["deps", "--from-checks"])
    out = capsys.readouterr().out.strip().splitlines()
    assert out == [f"{b}  [1]  merge auth first  feat/auth"]


def test_refresh_command_recomputes(fx, capsys):
    a, b = stacked(fx)
    run_cli(fx.root, ["refresh"])
    assert fx.facts(b)["waits_on"] == [a]


def test_old_git_skips_conflicts_with_a_notice(fx, monkeypatch):
    monkeypatch.setattr(gitfacts, "git_version", lambda: (2, 30))
    fx.branch("feat/a")
    fx.commit("feat/a", "README", "from a\n")
    fx.branch("feat/b")
    fx.commit("feat/b", "README", "from b\n")
    a, _ = fx.item("Alpha", ["feat/a"]), fx.item("Beta", ["feat/b"])
    fx.refresh()
    f = fx.facts(a)
    assert f["conflicts"] == [] and "2.38" in f["notice"]
    assert [o["files"] for o in f["overlaps"]] == [["README"]]


# ── when facts recompute ─────────────────────────────────────────────────────
def test_round_recomputes_only_when_a_tip_moves(fx, monkeypatch):
    a, b = stacked(fx)
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    assert set(gitfacts.on_round(fx.root)) == {a, b}
    assert gitfacts.on_round(fx.root) == []
    fx.commit("feat/a", "a2.txt", "more\n")
    assert a in gitfacts.on_round(fx.root)
    assert (fx.root / ".git-tips.json").is_file()


def test_round_recomputes_when_an_items_branches_change(fx, monkeypatch):
    a, b = stacked(fx)
    monkeypatch.setattr(gitfacts, "POLL_EVERY", 3600)
    gitfacts.on_round(fx.root)
    store.update_todo(fx.root, b, {"branches": []})
    assert b in gitfacts.on_round(fx.root)
    assert fx.facts(b) == {}


def test_a_repo_with_no_checkout_is_skipped_quietly(tmp_path, capsys):
    root = tmp_path / "proj" / store.ROOT_NAME
    (root / store.OPEN).mkdir(parents=True)
    it = store.add_todo(root, "Alpha", "2026-10-23T00:00:00.000Z")
    store.update_todo(root, it["id"], {"branches": ["feat/a"], "repo": "acme/nowhere"})
    assert gitfacts.refresh(root) == []
    assert capsys.readouterr().err == ""


def test_local_store_recomputes_at_most_every_five_minutes(fx, monkeypatch):
    stacked(fx)
    calls = []
    monkeypatch.setattr(gitfacts, "on_round", lambda root, *a, **kw: calls.append(root) or [])
    gitfacts.maybe_local(fx.root)
    gitfacts.maybe_local(fx.root)
    assert len(calls) == 1


# ── sync ─────────────────────────────────────────────────────────────────────
@pytest.fixture
def synced(fx, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    return server


def test_round_posts_facts_and_never_syncs_git_yaml(fx, synced):
    a, b = stacked(fx)
    sync.run_round(fx.root, synced.client("alice"))
    assert (fx.root / ".sync" / "git-tips.json").is_file()
    posted = {f["item_uid"]: f["data"] for f in synced.git_facts}
    assert posted[store.resolve_item(fx.root, b)["uid"]]["waits_on"] == [a]
    assert sync.pending(fx.root) == []
    ops = [op for push in synced.pushes for op in push]
    assert not any("git" in str(op.get("data", {}).keys()) for op in ops)


def test_failed_post_retries_next_round(fx, synced, monkeypatch):
    stacked(fx)
    synced.git_facts_offline = True
    sync.run_round(fx.root, synced.client("alice"))
    assert synced.git_facts == []
    synced.git_facts_offline = False
    sync.run_round(fx.root, synced.client("alice"))
    assert len(synced.git_facts) == 2


def test_forced_stage_op_carries_force(fx, synced):
    a, b = stacked(fx)
    store.update_todo(fx.root, b, {"status": "qa-approved"}, "2026-10-23T00:00:00.000Z")
    sync.run_round(fx.root, synced.client("alice"))
    run_cli(fx.root, ["stage", b, "--force"])
    sync.run_round(fx.root, synced.client("alice"))
    ops = [op for push in synced.pushes for op in push if (op.get("data") or {}).get("status") == "ready-to-deploy"]
    assert ops and ops[-1].get("force") is True
