"""Project Actions from the CLI: templates, delivery, `todo action`, and CLI
Actions firing on the status moves this process makes."""

import io
import json
import urllib.error

import pytest

from todo import actions, remote, store, sync

from .conftest import run_cli
from .fake_server import FakeServer

REST = {"id": "ping", "name": "Ping", "kind": "rest", "runner": "cli", "method": "POST",
        "url": "https://hooks.test/{{item.id}}", "headers": {"content-type": "application/json"},
        "body": '{"title": {{item.title | json}}, "from": {{item.from | json}}}', "auto": []}
TOWER = {"id": "agent", "name": "Agent", "kind": "watchtower", "runner": "cli", "base": "http://wt",
         "dir": "/mnt/rain/git/{{item.repo_name}}", "prompt": "/todo {{item.id}}", "auto": []}


class FakeHttp:
    """An urlopen stand-in: records each request and answers from `answer`."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data) if req.data and req.data[:1] in (b"{", b"[") else req.data
        call = {"method": req.get_method(), "url": req.full_url, "body": body}
        self.calls.append(call)
        status, payload = self.answer(call)
        text = payload if isinstance(payload, str) else json.dumps(payload)
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(text.encode()))
        return _Resp(status, text)


class _Resp(io.BytesIO):
    def __init__(self, status, text):
        super().__init__(text.encode())
        self.status = status


def team(root, defs):
    remote.save_sync_config(root, {"url": "https://todo.test", "project": "p", "deploy_step": True, "actions": defs})
    return root


def vars_for(it, frm=""):
    return actions.item_vars("p", it, frm, "tester", "https://todo.test")


def test_fill_handles_names_and_filters():
    v = vars_for({"id": "safari", "title": 'Say "hi"', "status": "in-qa", "repo": "acme/web"}, "review")
    assert actions.fill("{{item.repo_name}} {{ item.from }}", v) == "web review"
    assert actions.fill("{{item.title | json}}", v) == '"Say \\"hi\\""'
    assert actions.fill("{{item.title|url}}", v) == "Say%20%22hi%22"
    assert v["item.url"] == "https://todo.test/p/p/i/safari"


def test_render_matches_the_server_shape():
    v = vars_for({"id": "x", "title": "T", "status": "todo", "repo": "acme/web"})
    assert actions.render(REST, v) == {"kind": "rest", "method": "POST", "url": "https://hooks.test/x",
                                       "headers": {"content-type": "application/json"},
                                       "body": '{"title": "T", "from": ""}'}
    assert actions.render(TOWER, v) == {"kind": "watchtower", "base": "http://wt", "dir": "/mnt/rain/git/web",
                                        "name": "todo: x", "prompt": "/todo x"}


def test_fires_on_named_moves_only():
    a = {**REST, "auto": [{"from": "*", "to": "qa-approved"}, {"from": "review", "to": "todo"}]}
    assert actions.fires_on(a, "in-qa", "qa-approved")
    assert actions.fires_on(a, "review", "todo")
    assert not actions.fires_on(a, "in-triage", "todo")


def test_rest_failure_names_the_status():
    http = FakeHttp(lambda c: (500, "boom"))
    with pytest.raises(actions.ActionError, match="answered 500: boom"):
        actions.deliver({"kind": "rest", "method": "POST", "url": "https://h", "headers": {}, "body": "{}"}, http)


def test_watchtower_reuses_the_items_live_session():
    def answer(c):
        if c["url"].endswith("/roster"):
            return 200, {"sessions": [{"id": "s9", "name": "todo: x", "state": "active", "managed": True, "url": "u9"}]}
        return 200, {"delivered": "queued"}
    http = FakeHttp(answer)
    line = actions.deliver({"kind": "watchtower", "base": "http://wt", "dir": "/r", "name": "todo: x", "prompt": "/todo x"}, http)
    assert http.calls[1] == {"method": "POST", "url": "http://wt/api/sessions/s9/message",
                             "body": {"text": "/todo x", "from": "todo"}}
    assert "u9" in line


LIVE = {"sessions": [{"id": "s9", "name": "todo: x", "state": "active", "managed": True, "url": "u9"}]}


def test_watchtower_retries_while_the_input_box_is_hidden():
    refusals = [1, 1]

    def answer(c):
        if c["url"].endswith("/roster"):
            return 200, LIVE
        return (409, {"ok": False, "error": "the prompt input isn't visible"}) if refusals and refusals.pop() else (200, {"delivered": "now"})
    http = FakeHttp(answer)
    line = actions.deliver({"kind": "watchtower", "base": "http://wt", "dir": "/r", "name": "todo: x", "prompt": "/todo x"},
                           http, sleep=lambda s: None)
    assert len([c for c in http.calls if c["url"].endswith("/message")]) == 3
    assert "(now)" in line


def test_watchtower_doesnt_retry_other_refusals():
    http = FakeHttp(lambda c: (200, LIVE) if c["url"].endswith("/roster")
                    else (409, {"ok": False, "error": "the user is typing in this session"}))
    with pytest.raises(actions.ActionError, match="typing"):
        actions.deliver({"kind": "watchtower", "base": "http://wt", "dir": "/r", "name": "todo: x", "prompt": "/todo x"},
                        http, sleep=lambda s: None)
    assert len(http.calls) == 2


def test_watchtower_sends_a_long_prompt_once_idle():
    states = ["busy", "idle"]

    def answer(c):
        if c["url"].endswith("/roster"):
            return 200, {"sessions": []}
        if c["method"] == "GET":
            return 200, {"status": states.pop(0)}
        return 200, {"id": "s2", "url": "u2"}
    http = FakeHttp(answer)
    actions.deliver({"kind": "watchtower", "base": "http://wt", "dir": "/r", "name": "todo: x",
                     "prompt": "one\ntwo"}, http, sleep=lambda s: None)
    assert "initialPrompt" not in http.calls[1]["body"]
    assert http.calls[-1]["url"] == "http://wt/api/sessions/s2/message"


def test_watchtower_resumes_the_newest_stopped_session_with_the_resume_prompt():
    states = [{"state": "stopped", "status": "stopped"}, {"state": "active", "status": "idle"}]

    def answer(c):
        if c["url"].endswith("/roster"):
            return 200, {"sessions": [{"id": "old", "name": "todo: x", "state": "stopped", "url": "u-old", "lastActivity": 1},
                                      {"id": "new", "name": "todo: x", "state": "stopped", "url": "u-new", "lastActivity": 2}]}
        if c["method"] == "GET":
            return 200, states.pop(0)
        return 200, {"id": "new"} if c["url"].endswith("/resume") else {"delivered": "now"}
    http = FakeHttp(answer)
    line = actions.deliver({"kind": "watchtower", "base": "http://wt", "dir": "/r", "name": "todo: x", "prompt": "/todo x",
                            "resumePrompt": "/todo x: news"}, http, sleep=lambda s: None)
    assert [c["url"] for c in http.calls if c["method"] == "POST"] == \
        ["http://wt/api/sessions/new/resume", "http://wt/api/sessions/new/message"]
    assert http.calls[-1]["body"]["text"] == "/todo x: news"
    assert line.startswith("resumed")


def test_render_carries_the_resume_prompt_and_the_checkout_folder():
    it = {"id": "x", "title": "X", "status": "todo", "repo": "Acme/Web"}
    v = actions.item_vars("p", it, "", "tester", here={"dir": "/w/web", "repo": "acme/web"})
    req = actions.render({**TOWER, "dir": "{{item.dir}}", "resume": True, "resumePrompt": "again {{item.id}}"}, v)
    assert (req["dir"], req["resumePrompt"]) == ("/w/web", "again x")
    other = actions.item_vars("p", {**it, "repo": "acme/api"}, "", "tester", here={"dir": "/w/web", "repo": "acme/web"})
    assert (other["item.dir"], other["project.dir"]) == ("", "/w/web")


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(req, *a, **k):
        calls.append(req)
        return f'{req.get("method", "")} {req.get("url", "")} → 200'
    monkeypatch.setattr(actions, "deliver", fake)
    return calls


def test_a_cli_action_fires_on_its_move_and_logs(root, sent):
    team(root, [{**REST, "auto": [{"from": "*", "to": "in-progress"}]}])
    run_cli(root, ["start", "beta"])
    assert [r["url"] for r in sent] == ["https://hooks.test/beta"]
    assert json.loads(sent[0]["body"]) == {"title": "BETA", "from": "todo"}
    assert store.resolve_item(root, "beta")["log"][-1]["text"] == \
        "action Ping (todo → in-progress): POST https://hooks.test/beta → 200"


def test_server_actions_and_other_moves_stay_quiet(root, sent):
    team(root, [{**REST, "runner": "server", "auto": [{"from": "*", "to": "in-progress"}]},
                {**REST, "id": "other", "auto": [{"from": "*", "to": "review"}]}])
    run_cli(root, ["start", "beta"])
    run_cli(root, ["start", "beta"])
    assert sent == []


def test_todo_action_runs_a_cli_action_by_hand(root, sent):
    team(root, [REST])
    run_cli(root, ["action", "beta", "ping"])
    assert json.loads(sent[0]["body"])["from"] == ""
    assert "(manual)" in store.resolve_item(root, "beta")["log"][-1]["text"]


def test_todo_action_asks_the_server_to_run_a_server_action(root, monkeypatch, capsys):
    team(root, [{**REST, "runner": "server"}])
    asked = []
    monkeypatch.setattr(remote.Remote, "run_action",
                        lambda self, p, item, a: asked.append((p, item, a)) or {"done": True, "ok": True, "message": "sent"})
    run_cli(root, ["action", "beta", "ping"])
    assert asked == [("p", store.resolve_item(root, "beta")["uid"] or "beta", "ping")]
    assert "action Ping: sent" in capsys.readouterr().out


def test_unknown_action_lists_the_known_ones(root, capsys):
    team(root, [REST])
    with pytest.raises(SystemExit):
        run_cli(root, ["action", "beta", "nope"])
    assert "have: ping" in capsys.readouterr().err


def test_sync_keeps_the_projects_actions(tmp_path):
    server = FakeServer()
    server.actions = [REST]
    root = tmp_path / "a" / ".TODO"
    root.mkdir(parents=True)
    remote.save_sync_config(root, {"url": "http://fake", "project": "p", "deploy_step": True})
    sync.run_round(root, server.client("alice"))
    assert remote.sync_config(root)["actions"] == [REST]
