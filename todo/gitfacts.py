"""Git facts: where each item's branches landed, which in-flight branches
depend on others, and which conflict or overlap. They come from the repo's
local checkout (and each branch's PR on GitHub), live in the item folder as
`git.yaml`, and are never set by hand. See
docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §2.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from itertools import combinations
from pathlib import Path

from . import checkout, store, yamlio
from .remote import RemoteError, remote_for, sync_config, sync_dir
from .util import now, to_str

FACTS_FILE = "git.yaml"
TIPS_FILE = "git-tips.json"
CACHE_FILE = "git-cache.json"
PLUGINS_FILE = ".todo-plugins/plugins.yaml"
POLL_EVERY = 30                 # seconds between ls-remote calls for one repo, so a command's two rounds share one
LOCAL_EVERY = 300               # a local-only store recomputes at most this often, at the end of a command
MERGE_TREE_GIT = (2, 38)
GUARDED = ("ready-to-deploy", "deployed")
UNRESOLVED = ("waiting", "stale")
CANT_LAND = ("cancelled", "deferred")
HINT = "whichever merges second merges the other in"
API = "https://api.github.com"
SHOWN_COMMITS = 3
_PR_URL = re.compile(r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)(?:[/?#]|$)", re.I)


# ── git ───────────────────────────────────────────────────────────────────────
def _git(cwd: Path, *args: str, timeout: float = 60):
    try:
        return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def _out(cwd: Path, *args: str, timeout: float = 60) -> str | None:
    r = _git(cwd, *args, timeout=timeout)
    return r.stdout.strip() if r is not None and r.returncode == 0 else None


def git_version() -> tuple:
    try:
        out = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return (0, 0)
    m = re.search(r"(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


class Repo:
    """One repo's local checkout, with results cached by the commits they compare."""

    def __init__(self, key: str, dir_: Path, cache: dict):
        self.key, self.dir, self.cache = key, dir_, cache
        self.tips: dict = {}
        self.used: dict = {}

    def ls_remote(self) -> dict | None:
        out = _out(self.dir, "ls-remote", "--heads", "origin", timeout=20)
        if out is None:
            return None
        tips = {}
        for line in out.splitlines():
            sha, _, ref = line.partition("\t")
            if ref.startswith("refs/heads/"):
                tips[ref[len("refs/heads/"):]] = sha
        return tips

    def has(self, sha: str) -> bool:
        r = _git(self.dir, "cat-file", "-e", f"{sha}^{{commit}}")
        return r is not None and r.returncode == 0

    def fetch_if_needed(self, shas) -> None:
        if any(not self.has(s) for s in shas):
            _git(self.dir, "fetch", "--quiet", "origin", timeout=120)

    def default_branch(self) -> str:
        ref = _out(self.dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        if ref and ref.startswith("origin/"):
            return ref[len("origin/"):]
        return "master" if "main" not in self.tips and "master" in self.tips else "main"

    def track(self, default: str) -> list:
        """The `track:` list from the plugins file on the default branch; [] without one."""
        text = _out(self.dir, "show", f"{self.tips.get(default) or 'origin/' + default}:{PLUGINS_FILE}")
        if not text:
            return []
        try:
            from ruamel.yaml import YAML
            doc = YAML(typ="safe").load(text)
        except Exception:  # noqa: BLE001 — a malformed file tracks nothing
            return []
        raw = doc.get("track") if isinstance(doc, dict) else None
        return [to_str(t) for t in raw if to_str(t)] if isinstance(raw, list) else []

    def _cached(self, kind: str, key: str, compute):
        bucket = self.cache.setdefault(kind, {})
        if key in bucket:
            value = bucket[key]
        else:
            value = compute()
            if value is None:
                return None
            bucket[key] = value
        self.used.setdefault(kind, {})[key] = value
        return value

    def is_ancestor(self, sha: str, tip: str) -> bool | None:
        def run():
            r = _git(self.dir, "merge-base", "--is-ancestor", sha, tip)
            return None if r is None or r.returncode not in (0, 1) else r.returncode == 0
        return self._cached("anc", f"{sha}:{tip}", run)

    def merge_base(self, a: str, b: str) -> str | None:
        def run():
            r = _git(self.dir, "merge-base", a, b)
            return None if r is None or r.returncode not in (0, 1) else r.stdout.strip()
        return self._cached("mb", f"{a}:{b}", run) or None

    def shared(self, tip: str, mb: str) -> dict:
        """The commits of `mb` not in `tip`: how many, and the newest few."""
        def run():
            count = _out(self.dir, "rev-list", "--count", f"{tip}..{mb}")
            shas = _out(self.dir, "log", "--format=%h", "--abbrev=7", f"-n{SHOWN_COMMITS}", f"{tip}..{mb}")
            return None if count is None else {"count": int(count), "commits": (shas or "").split()}
        return self._cached("shared", f"{tip}:{mb}", run) or {"count": 0, "commits": []}

    def conflicts(self, a: str, b: str) -> list | None:
        def run():
            r = _git(self.dir, "merge-tree", "--write-tree", "--name-only", "--no-messages", a, b)
            if r is None or r.returncode not in (0, 1):
                return None
            return sorted(set(r.stdout.splitlines()[1:]) - {""}) if r.returncode == 1 else []
        return self._cached("conflicts", f"{a}:{b}", run)

    def changed(self, base: str, head: str) -> list:
        def run():
            out = _out(self.dir, "diff", "--name-only", base, head)
            return None if out is None else sorted(set(out.splitlines()) - {""})
        return self._cached("diff", f"{base}:{head}", run) or []


# ── GitHub ────────────────────────────────────────────────────────────────────
_token: list = []


def _github_token() -> str | None:
    if not _token:
        tok = os.environ.get("GITHUB_TOKEN", "").strip()
        if not tok and shutil.which("gh"):
            try:
                tok = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                tok = ""
        _token.append(tok or None)
    return _token[0]


def gh_get(path: str):
    """GitHub REST GET; None with no token or on any failure."""
    tok = _github_token()
    if not tok:
        return None
    req = urllib.request.Request(API + path, headers={
        "accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        "authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read() or b"null")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _pr_fields(pr: dict) -> dict:
    state = "merged" if pr.get("merged_at") else "closed" if pr.get("state") == "closed" else \
        "draft" if pr.get("draft") else "open"
    out = {"number": pr.get("number"), "state": state, "base": (pr.get("base") or {}).get("ref"),
           "url": pr.get("html_url")}
    if state == "merged" and pr.get("merge_commit_sha"):
        out["merge_commit"] = pr["merge_commit_sha"]
    return out


def branch_pr(repo_key: str, branch: str):
    """The branch's PR (an open one first, else the newest); {} with none; None when GitHub can't tell."""
    owner = repo_key.split("/")[0]
    rows = gh_get(f"/repos/{repo_key}/pulls?head={urllib.parse.quote(owner, safe='')}:"
                  f"{urllib.parse.quote(branch, safe='')}&state=all&per_page=20")
    if not isinstance(rows, list):
        return None
    if not rows:
        return {}
    return _pr_fields(next((r for r in rows if r.get("state") == "open"), rows[0]))


def url_pr(url: str):
    m = _PR_URL.match(url or "")
    if not m:
        return None
    pr = gh_get(f"/repos/{m.group(1)}/{m.group(2)}/pulls/{m.group(3)}")
    return _pr_fields(pr) if isinstance(pr, dict) and pr.get("number") else None


def _gh_in(repo_key: str, sha: str, branch: str) -> bool | None:
    got = gh_get(f"/repos/{repo_key}/compare/{sha}...{urllib.parse.quote(branch, safe='')}")
    return got.get("status") in ("ahead", "identical") if isinstance(got, dict) else None


# ── storage ───────────────────────────────────────────────────────────────────
def _item_dir(root: Path, it: dict) -> Path:
    return root / it["folder"] / it["id"]


def load(root: Path, it: dict) -> dict:
    """The item's last computed facts; {} when it has none."""
    f = _item_dir(root, it) / FACTS_FILE
    if not f.is_file():
        return {}
    try:
        data = yamlio.read(f)
    except Exception:  # noqa: BLE001 — an unreadable file is recomputed
        return {}
    return data if isinstance(data, dict) else {}


def _save(root: Path, it: dict, facts: dict) -> None:
    f = _item_dir(root, it) / FACTS_FILE
    if not facts:
        f.unlink(missing_ok=True)
        return
    from ruamel.yaml import YAML
    y = YAML()
    y.default_flow_style = None
    yamlio.write_atomic(f, yamlio.dump(y, facts))


def _state_dir(root: Path) -> Path:
    return sync_dir(root) if sync_config(root) else root


def _state_file(root: Path, name: str) -> Path:
    return _state_dir(root) / (name if sync_config(root) else "." + name)


def _read_json(f: Path) -> dict:
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(f: Path, data: dict) -> None:
    f.parent.mkdir(exist_ok=True)
    yamlio.write_atomic(f, json.dumps(data, sort_keys=True))


# ── where each repo is checked out ────────────────────────────────────────────
def _store_dirs(root: Path) -> list:
    """Folders that may hold the store's own repo: the project around an
    in-repo store, or a linked store's repo."""
    out = []
    real = root.resolve()
    if (real.parent / ".git").exists():
        out.append(real.parent)
    meta = real.parent / "meta.yaml"
    if meta.is_file():
        try:
            linked = (yamlio.read(meta) or {}).get("linked_from")
        except Exception:  # noqa: BLE001
            linked = None
        if linked:
            out.append(Path(str(linked)))
    return out


def _store_repo(root: Path) -> tuple:
    """(repo key, folder) for the store's own repo, or ("", None)."""
    for d in _store_dirs(root):
        here = checkout.local(d)
        if here["repo"] and (Path(here["dir"]) / ".git").exists():
            return here["repo"], Path(here["dir"])
    return "", None


def repo_dir(root: Path, key: str) -> Path | None:
    """A local checkout of `key`: the store's own repo, then the one around the working directory."""
    own, d = _store_repo(root)
    if own == key:
        return d
    here = checkout.local()
    return Path(here["dir"]) if here["repo"] == key else None


def _groups(root: Path, items: list) -> dict:
    """Items by repo key; an item with no repo belongs to the store's own repo."""
    own = None
    out: dict = {}
    for it in items:
        key = checkout.repo_key(it.get("repo"))
        if not key:
            if own is None:
                own = _store_repo(root)[0]
            key = own
        if key:
            out.setdefault(key, []).append(it)
    return out


def _archived(root: Path, it: dict) -> bool:
    if it["folder"] == store.ARCHIVED:
        return True
    try:
        return bool((yamlio.read(_item_dir(root, it) / store.ITEM_FILE) or {}).get("archived"))
    except Exception:  # noqa: BLE001
        return False


# ── computing ─────────────────────────────────────────────────────────────────
def _branch_facts(repo: Repo, it: dict, old: dict, default: str, track: list, fetch_pr: bool) -> list:
    out = []
    for name in it["branches"]:
        o = old.get(name) or {}
        head = repo.tips.get(name)
        gone = head is None
        head = head or o.get("head")
        pr = o.get("pr")
        if fetch_pr and (not pr or pr.get("state") != "merged"):
            got = branch_pr(repo.key, name)
            if got is not None:
                pr = got or None
        b = {"name": name}
        if head:
            b["head"] = head
            b["first"] = o.get("first") or head
        if gone:
            b["gone"] = True
        if pr:
            b["pr"] = pr
        b["target"] = (pr or {}).get("base") or default
        landed = (pr or {}).get("merge_commit") or head
        if landed:
            b["landed"] = landed
            if track:
                b["in"] = {t: bool(repo.is_ancestor(landed, repo.tips[t])) for t in track if t in repo.tips}
        out.append(b)
    return out


def _state(repo: Repo, dep: dict, branch: dict, tip: str | None) -> tuple:
    """(state, why) of an edge onto `branch` of item `dep`, landing in the branch whose tip is `tip`."""
    pr = branch.get("pr") or {}
    if tip and branch.get("landed") and repo.is_ancestor(branch["landed"], tip):
        return "landed", ""
    if dep["status"] in CANT_LAND:
        return "stale", f'{dep["id"]} is {dep["status"]}'
    if pr.get("state") == "closed":
        return "stale", f'its PR #{pr.get("number")} closed unmerged'
    return "waiting", ""


def _git_edges(repo: Repo, items: list, facts: dict) -> list:
    """(B, B's branch, A, A's branch, edge) for each B that carries unlanded commits of A."""
    edges = []
    for b_it in items:
        if b_it["status"] == "cancelled":
            continue
        for bb in facts[b_it["id"]]["branches"]:
            tip = repo.tips.get(bb["target"])
            if not bb.get("head") or not tip:
                continue
            for a_it in items:
                if a_it is b_it:
                    continue
                for ab in facts[a_it["id"]]["branches"]:
                    if not ab.get("head") or ab["name"] == bb["name"]:
                        continue
                    mb = repo.merge_base(ab["head"], bb["head"])
                    if not mb or mb == bb["head"] or repo.is_ancestor(mb, tip) is not False:
                        continue
                    state, why = _state(repo, a_it, ab, tip)
                    sh = repo.shared(tip, mb)
                    n = sh["count"]
                    evidence = why or (f'{bb["name"]} carries {n} commit{"s" if n != 1 else ""} of {ab["name"]} '
                                       f'not in {bb["target"]}: {", ".join(sh["commits"])}')
                    if state == "landed":
                        evidence = f'{ab["name"]} landed in {bb["target"]} ({ab["landed"][:7]})'
                    edges.append((b_it, bb, a_it, ab, {
                        "id": a_it["id"], "item": a_it.get("uid"), "branch": ab["name"], "via": bb["name"],
                        "target": bb["target"], "state": state, "source": "git", "evidence": evidence,
                        "shared": n, "commits": sh["commits"]}))
    pairs = {(b["id"], bb["name"], a["id"], ab["name"]) for b, bb, a, ab, _ in edges}
    return [(b, bb, a, ab, e) for b, bb, a, ab, e in edges
            if (a["id"], ab["name"], b["id"], bb["name"]) not in pairs or _cut_from(repo, bb, ab)]


def _cut_from(repo: Repo, bb: dict, ab: dict) -> bool:
    """For two branches that each carry the other's unlanded commits, whether
    B was cut from A, so not A from B: B's first-seen head isn't in A's. When
    neither is in the other, both edges stay."""
    fa, fb = ab.get("first"), bb.get("first")
    return not (fa and fb and fa != fb and repo.is_ancestor(fb, fa))


def _note_edges(root: Path, repo: Repo, it: dict, notes: list, items: list, facts: dict, default: str) -> list:
    """Edges from plugin-made dependency notes: (needed item or None, its branch or None, edge)."""
    out = []
    by_branch = {b: x for x in items for b in x["branches"]}
    own = facts[it["id"]]["branches"]
    for n in notes:
        m = n.get("meta") or {}
        needs = to_str(m.get("needs")).strip()
        target = to_str(m.get("in")).strip() or (own[0]["target"] if own else default)
        tip = repo.tips.get(target)
        edge = {"needs": needs, "target": target, "source": "plugin", "note": n.get("uid"),
                "evidence": to_str(m.get("because")).strip() or n["text"].strip()}
        dep, branches = None, []
        if needs.startswith("item:"):
            ref = needs[len("item:"):]
            dep = next((x for x in items if ref in (x["id"], x.get("uid"))), None)
            if dep is None:
                dep = next((x for x in store.list_todos(root) if ref in (x["id"], x.get("uid"))), None)
            branches = (facts.get(dep["id"]) or load(root, dep)).get("branches") or [] if dep else []
        elif needs.startswith("branch:"):
            name = needs[len("branch:"):]
            dep = by_branch.get(name)
            if dep is not None:
                branches = [b for b in facts[dep["id"]]["branches"] if b["name"] == name]
            else:
                head = repo.tips.get(name)
                branches = [{"name": name, "head": head, "landed": head}] if head else []
            edge["branch"] = name
        elif _PR_URL.match(needs):
            edge.update(_pr_edge(repo, needs, target, m))
            out.append((None, None, edge))
            continue
        if dep is not None:
            edge.update({"id": dep["id"], "item": dep.get("uid")})
        states = [_state(repo, dep, b, tip) if dep is not None else
                  (("landed", "") if tip and b.get("landed") and repo.is_ancestor(b["landed"], tip) else ("waiting", ""))
                  for b in branches]
        if not states:
            edge["state"] = "stale" if dep is not None and dep["status"] in CANT_LAND else "waiting"
        elif all(s == "landed" for s, _ in states):
            edge["state"] = "landed"
        else:
            edge["state"] = "stale" if any(s == "stale" for s, _ in states) else "waiting"
        out.append((dep, branches[0] if len(branches) == 1 else None, edge))
    return out


def _pr_edge(repo: Repo, url: str, target: str, meta: dict) -> dict:
    pr = url_pr(url)
    if pr is None:
        return {"state": "waiting"}
    if pr["state"] == "closed":
        return {"state": "stale", "pr": pr}
    if pr["state"] != "merged":
        return {"state": "waiting", "pr": pr}
    sha, key = pr.get("merge_commit"), checkout.repo_key(url.split("/pull/")[0])
    if not to_str(meta.get("in")).strip() or not sha:
        return {"state": "landed", "pr": pr}
    landed = repo.is_ancestor(sha, repo.tips[target]) if key == repo.key and target in repo.tips \
        else _gh_in(key, sha, target)
    return {"state": "landed" if landed else "waiting", "pr": pr}


def _hints(repo: Repo, items: list, facts: dict, notice: list) -> None:
    """Conflicts and overlaps between live branches of different items."""
    live = [(it, b) for it in items if it["status"] != "cancelled"
            for b in facts[it["id"]]["branches"]
            if b.get("head") and not b.get("gone") and (b.get("pr") or {}).get("state") not in ("merged", "closed")]
    can_merge_tree = git_version() >= MERGE_TREE_GIT
    if not can_merge_tree and live:
        notice.append("conflicts need git 2.38 or newer; skipped")
    for (a_it, ab), (b_it, bb) in combinations(live, 2):
        if a_it is b_it:
            continue
        pair = ((a_it, ab, b_it, bb), (b_it, bb, a_it, ab))
        files = repo.conflicts(ab["head"], bb["head"]) if can_merge_tree else None
        if files:
            for x, xb, y, yb in pair:
                facts[x["id"]]["conflicts"].append(
                    {"id": y["id"], "item": y.get("uid"), "branch": yb["name"], "via": xb["name"], "files": files})
        mb = repo.merge_base(ab["head"], bb["head"])
        if not mb:
            continue
        common = sorted(set(repo.changed(mb, ab["head"])) & set(repo.changed(mb, bb["head"])))
        if common:
            for x, xb, y, yb in pair:
                facts[x["id"]]["overlaps"].append(
                    {"id": y["id"], "item": y.get("uid"), "branch": yb["name"], "via": xb["name"], "files": common})


def _compute(root: Path, repo: Repo, items: list, fetch_pr) -> dict:
    """Every item's facts in one repo, by item id."""
    default = repo.default_branch()
    track = repo.track(default)
    facts = {}
    for it in items:
        old = {b.get("name"): b for b in load(root, it).get("branches") or [] if isinstance(b, dict)}
        facts[it["id"]] = {"repo": repo.key, "branches": _branch_facts(repo, it, old, default, track, fetch_pr(it)),
                           "needs": [], "needed_by": [], "conflicts": [], "overlaps": []}
    for b_it, bb, a_it, ab, e in _git_edges(repo, items, facts):
        facts[b_it["id"]]["needs"].append(e)
        facts[a_it["id"]]["needed_by"].append({**e, "id": b_it["id"], "item": b_it.get("uid"),
                                               "branch": bb["name"], "via": ab["name"]})
    for it in items:
        if it["status"] == "cancelled":
            continue
        full = store.get_item(root, it["id"]) or {"notes": []}
        notes = [n for n in full["notes"] if n["kind"] == "dependency"]
        for dep, dep_branch, e in _note_edges(root, repo, it, notes, items, facts, default):
            facts[it["id"]]["needs"].append(e)
            if dep is not None and dep["id"] in facts:
                facts[dep["id"]]["needed_by"].append({**e, "id": it["id"], "item": it.get("uid"),
                                                      "branch": (it["branches"] or [None])[0],
                                                      "via": dep_branch["name"] if dep_branch else None})
    notice: list = []
    _hints(repo, items, facts, notice)
    for it in items:
        f = facts[it["id"]]
        f["waits_on"] = sorted({e.get("id") or e.get("needs") for e in f["needs"] if e["state"] in UNRESOLVED})
        if notice:
            f["notice"] = notice[0]
        if not f["branches"] and not f["needs"] and not f["needed_by"]:
            facts[it["id"]] = {}
    return facts


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "at"}


# ── when facts recompute ─────────────────────────────────────────────────────
def _recorded(root: Path, it: dict) -> list:
    return [b.get("name") for b in load(root, it).get("branches") or [] if isinstance(b, dict)]


def on_round(root: Path, remote=None, project: str | None = None, *, force: bool = False,
             repos: set | None = None) -> list:
    """Recompute the repos whose branches moved (one ls-remote each) or whose
    items' branches changed; with `force`, every repo asked for. Posts what
    changed to the server when given one. Returns the ids of changed items."""
    items = [it for it in store.list_todos(root) if not _archived(root, it)]
    groups = _groups(root, items)
    tips_file, cache_file = _state_file(root, TIPS_FILE), _state_file(root, CACHE_FILE)
    state = _read_json(tips_file)
    cache = _read_json(cache_file)
    used: dict = {}
    changed = []
    for key, group in groups.items():
        if repos is not None and key not in repos:
            continue
        if not any(it["branches"] or load(root, it) for it in group) and not force:
            continue
        saved = state.get(key) or {}
        touched = {it["id"] for it in group if it["branches"] != _recorded(root, it)}
        if not force and not touched and time.time() - saved.get("at", 0) < POLL_EVERY:
            continue
        d = repo_dir(root, key)
        if d is None:
            continue
        repo = Repo(key, d, cache)
        tips = repo.ls_remote()
        if tips is None:
            continue
        old_tips = saved.get("tips") or {}
        moved = {n for n in set(tips) | set(old_tips) if tips.get(n) != old_tips.get(n)}
        state[key] = {"at": time.time(), "tips": tips}
        if not (force or touched or moved):
            continue
        repo.tips = tips
        repo.fetch_if_needed(tips.values())
        wide = force or bool(moved - {b for it in group for b in it["branches"]})
        fresh = _compute(root, repo, group, lambda it: wide or it["id"] in touched or bool(moved & set(it["branches"])))
        for kind, bucket in repo.used.items():
            used.setdefault(kind, {}).update(bucket)
        stamp = now()
        for it in group:
            new = fresh.get(it["id"], {})
            if _strip(new) != _strip(load(root, it)):
                _save(root, it, {"at": stamp, **new} if new else {})
                changed.append(it["id"])
    if used:
        _write_json(cache_file, used)
    unposted = set(state.get("unposted") or []) | set(changed) if sync_config(root) else set()
    if remote is not None and unposted:
        unposted = _post(root, remote, project, unposted)
    state["unposted"] = sorted(unposted)
    _write_json(tips_file, state)
    return changed


def _post(root: Path, remote, project, ids: set) -> set:
    """Send facts for `ids`; the ids still to send."""
    facts = []
    for item_id in sorted(ids):
        it = store.get_item(root, item_id)
        if it is not None and it.get("uid"):
            facts.append({"item_uid": it["uid"], "data": load(root, it)})
    if not facts:
        return set()
    try:
        remote.git_facts(project, facts)
    except (RemoteError, AttributeError):
        return ids
    return set()


def refresh(root: Path, items=None) -> list:
    """Recompute now, for the repos of `items` (every repo when None). A
    synced store posts the results in its next round."""
    repos = None
    if items is not None:
        repos = set(_groups(root, [it for it in items if not _archived(root, it)]))
    return on_round(root, force=True, repos=repos)


def post_pending(root: Path) -> None:
    """Post the facts a synced store hasn't sent yet."""
    cfg = sync_config(root)
    r = remote_for(root) if cfg else None
    f = _state_file(root, TIPS_FILE)
    state = _read_json(f)
    if r is None or not state.get("unposted"):
        return
    state["unposted"] = sorted(_post(root, r, cfg.get("project"), set(state["unposted"])))
    _write_json(f, state)


def maybe_local(root: Path) -> None:
    """A local-only store's recompute, at most every LOCAL_EVERY seconds."""
    if sync_config(root) is not None or not root.is_dir():
        return
    f = _state_file(root, TIPS_FILE)
    state = _read_json(f)
    if time.time() - state.get("local_at", 0) < LOCAL_EVERY:
        return
    state["local_at"] = time.time()
    _write_json(f, state)
    try:
        on_round(root)
    except Exception as e:  # noqa: BLE001 — facts must never break a command
        print(f"git facts: skipped ({type(e).__name__}: {e})", file=sys.stderr)


# ── reading facts ─────────────────────────────────────────────────────────────
def view(root: Path, it: dict) -> dict:
    """The item's facts, with each edge's state brought up to date with item
    statuses and any dependency note not yet checked added as waiting."""
    facts = dict(load(root, it))
    items = {x["id"]: x for x in store.list_todos(root)}
    needs = []
    for e in facts.get("needs") or []:
        dep = items.get(e.get("id"))
        if e.get("state") == "waiting" and dep is not None and dep["status"] in CANT_LAND:
            e = {**e, "state": "stale", "evidence": f'{dep["id"]} is {dep["status"]}'}
        needs.append(e)
    seen = {e.get("note") for e in needs if e.get("note")}
    for n in it.get("notes") or []:
        if n["kind"] == "dependency" and n.get("uid") not in seen:
            m = n.get("meta") or {}
            needs.append({"needs": to_str(m.get("needs")), "target": to_str(m.get("in")) or None,
                          "state": "waiting", "source": "plugin", "note": n.get("uid"),
                          "evidence": (to_str(m.get("because")) or n["text"]).strip() + " (not yet checked)"})
    if needs or facts:
        facts["needs"] = needs
        facts["waits_on"] = sorted({e.get("id") or e.get("needs") for e in needs if e["state"] in UNRESOLVED})
    return facts


def unresolved(root: Path, it: dict) -> list:
    """The item's waiting or stale edges; facts that say so are rechecked first."""
    it = store.get_item(root, it["id"]) or it
    edges = [e for e in view(root, it).get("needs") or [] if e["state"] in UNRESOLVED]
    if edges:
        try:
            refresh(root, [it])
        except Exception:  # noqa: BLE001 — keep the stored facts
            return edges
        edges = [e for e in view(root, it).get("needs") or [] if e["state"] in UNRESOLVED]
    return edges


def waits(root: Path, items: list) -> dict:
    """`{item id: [ids it waits on]}` for items with an unresolved edge."""
    out = {}
    for it in items:
        w = load(root, it).get("waits_on") or []
        if w:
            out[it["id"]] = list(w)
    return out


def describe(e: dict) -> str:
    """One line for an edge: what it needs, its state, and the evidence."""
    who = e.get("id") or e.get("needs") or "?"
    where = f' ({e["branch"]})' if e.get("branch") else ""
    why = f' — {e["evidence"]}' if e.get("evidence") else ""
    return f'{who}{where} {e["state"]}{why}'


def from_checks(root: Path) -> list:
    """`(item id, check)` for every prereq-branch check in the store."""
    out = []
    for it in store.list_todos(root):
        for c in it["checks"]:
            if c["kind"] == "prereq-branch":
                out.append((it["id"], c))
    return out
