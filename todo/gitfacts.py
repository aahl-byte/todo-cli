"""Git facts: where each item's branches landed, which in-flight branches
depend on others, and which conflict or overlap. They come from the repo's
local checkout (and each branch's PRs on GitHub), live in the item folder as
`git.yaml`, and are never set by hand. See
docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §2.

Each branch's unlanded commits U(X) are those in X but in neither T(X) nor a
long-lived branch (the default and tracked ones): one rev-list per branch, less
one per target and long-lived branch. Pairs are related only by intersecting
those sets in memory. A failure never reads
as "no edge": the previous state stays, marked unknown, and the next round
retries.
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

from . import checkout, statelock, store, yamlio
from .remote import RemoteError, remote_for, sync_config
from .util import now, to_str

FACTS_FILE = "git.yaml"
TIPS_FILE = "git-tips.json"
CACHE_FILE = "git-cache.json"
PLUGINS_FILE = ".todo-plugins/plugins.yaml"
POLL_EVERY = 30                 # seconds between ls-remote calls for one repo, so a command's two rounds share one
LOCAL_EVERY = 300               # a local-only store recomputes at most this often, at the end of a command
UNLANDED_CAP = 2000             # past this many unlanded commits a branch's relations are unknown
MERGE_TREE_GIT = (2, 38)
GUARDED = ("ready-to-deploy", "deployed")
UNRESOLVED = ("waiting", "stale", "unknown")
CANT_LAND = ("cancelled", "deferred")
COMPLETE = ("done", "deployed")
OPEN_PR = ("open", "draft")
HINT = "whichever merges second merges the other in"
SHARES_HINT = ("can't tell which builds on which; base the dependent PR on the other branch, "
               "or merge one into the other")
UNTRACKED_HINT = "{branch}'s PR is based on {base}; if {base} is long-lived, add it under track: in " + PLUGINS_FILE
API = "https://api.github.com"
SHOWN_COMMITS = 3
SHA_KEY = 12                    # cached commit sets keep this many hex digits per commit
_PR_URL = re.compile(r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)(?:[/?#]|$)", re.I)


class _GitHubError:
    def __repr__(self):
        return "GH_ERROR"


GH_ERROR = _GitHubError()       # gh_get's answer when GitHub failed, as opposed to None for "no token"


# ── git ───────────────────────────────────────────────────────────────────────
def _git(cwd: Path, *args: str, timeout: float = 60, stdin: str | None = None):
    try:
        return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=timeout,
                              input=stdin)
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
    """One repo's local checkout. Results computed from complete data are
    cached by the commits they compare."""

    def __init__(self, key: str, dir_: Path, cache: dict):
        self.key, self.dir, self.cache = key, dir_, cache
        self.tips: dict = {}
        self.default = "main"
        self.used: dict = {}
        self.fixed: set = set()             # tracked and default branches: never item-owned
        self.absent: set = set()            # commits not here at the start of the compute
        self.lost: set = set()              # commits a targeted fetch couldn't bring
        self.closed: dict = {}              # branch → PRs closed into a tracked branch that moved
        self.covered: set = set()           # the tracked branches `closed` was listed for

    def ls_remote(self) -> dict | None:
        """Branch tips, and the default branch from the remote's HEAD; None when unreachable."""
        out = _out(self.dir, "ls-remote", "--symref", "origin", "HEAD", "refs/heads/*", timeout=20)
        if out is None:
            return None
        tips, default = {}, None
        for line in out.splitlines():
            if line.startswith("ref: "):
                ref = line[len("ref: "):].split("\t")[0]
                default = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else None
                continue
            sha, _, ref = line.partition("\t")
            if ref.startswith("refs/heads/"):
                tips[ref[len("refs/heads/"):]] = sha
        self.default = default or ("master" if "main" not in tips and "master" in tips else "main")
        return tips

    def shallow(self) -> bool:
        return _out(self.dir, "rev-parse", "--is-shallow-repository") == "true"

    def missing(self, shas) -> set:
        """The commits not in the local object store, from one batch check."""
        shas = sorted({s for s in shas if s})
        if not shas:
            return set()
        r = _git(self.dir, "cat-file", "--batch-check", stdin="".join(s + "\n" for s in shas))
        if r is None or r.returncode != 0:
            return set(shas)
        return {line.split()[0] for line in r.stdout.splitlines() if line.endswith(" missing")}

    def fetch_if_needed(self, shas) -> bool:
        """Fetch when a commit is missing; False when one still is afterwards."""
        if not self.missing(shas):
            return True
        _git(self.dir, "fetch", "--quiet", "origin", timeout=120)
        return not self.missing(shas)

    def ensure(self, sha: str, number=None) -> bool:
        """Whether `sha` is here, fetching its PR's `refs/pull/<n>/head` once when it isn't."""
        if not sha or sha not in self.absent:
            return True
        if sha in self.lost or number is None:
            return False
        _git(self.dir, "fetch", "--quiet", "origin", f"refs/pull/{number}/head", timeout=60)
        if self.missing([sha]):
            self.lost.add(sha)
            return False
        self.absent.discard(sha)
        return True

    def track(self) -> list:
        """The `track:` list from the plugins file on the default branch; [] without one."""
        tip = self.tips.get(self.default)
        if not tip:
            return []

        def run():
            r = _git(self.dir, "show", f"{tip}:{PLUGINS_FILE}")
            if r is None:
                return None
            if r.returncode != 0:
                return []
            try:
                from ruamel.yaml import YAML
                doc = YAML(typ="safe").load(r.stdout)
            except Exception:  # noqa: BLE001 — a malformed file tracks nothing
                return []
            raw = doc.get("track") if isinstance(doc, dict) else None
            return [to_str(t) for t in raw if to_str(t)] if isinstance(raw, list) else []
        return self._cached("track", tip, run) or []

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

    def unlanded(self, tip: str, head: str) -> list | None:
        """U = tip..head, newest first, as short shas; None on failure or past the cap."""
        def run():
            out = _out(self.dir, "rev-list", f"--max-count={UNLANDED_CAP + 1}", f"{tip}..{head}")
            if out is None:
                return None
            shas = [s[:SHA_KEY] for s in out.split()]
            return None if len(shas) > UNLANDED_CAP else shas
        return self._cached("u", f"{tip}:{head}", run)

    def drift(self, target: str) -> dict | None:
        """Per long-lived branch on the remote other than `target`, its commits
        not in `target`, which a branch can carry without depending on anyone;
        None when one can't be listed."""
        out = {}
        for name in sorted(self.fixed - {target}):
            if name not in self.tips:
                continue
            got = [] if self.tips[name] == self.tips[target] else self.unlanded(self.tips[target], self.tips[name])
            if got is None:
                return None
            out[name] = set(got)
        return out

    def changed(self, tip: str, head: str) -> list | None:
        """Files `head` changes since its merge base with `tip`."""
        def run():
            out = _out(self.dir, "diff", "--name-only", f"{tip}...{head}")
            return None if out is None else sorted(set(out.splitlines()) - {""})
        return self._cached("diff", f"{tip}:{head}", run)

    def conflicts(self, a: str, b: str) -> list | None:
        def run():
            r = _git(self.dir, "merge-tree", "--write-tree", "--name-only", "--no-messages", a, b)
            if r is None or r.returncode not in (0, 1):
                return None
            return sorted(set(r.stdout.splitlines()[1:]) - {""}) if r.returncode == 1 else []
        return self._cached("conflicts", f"{a}:{b}", run)


# ── GitHub ────────────────────────────────────────────────────────────────────
_token: list = []


def github_token() -> str | None:
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
    """GitHub REST GET: the parsed body, None with no token, GH_ERROR when GitHub failed."""
    tok = github_token()
    if not tok:
        return None
    req = urllib.request.Request(API + path, headers={
        "accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        "authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read() or b"null")
    except (urllib.error.URLError, OSError, ValueError):
        return GH_ERROR


def _pr_fields(pr: dict) -> dict:
    state = "merged" if pr.get("merged_at") else "closed" if pr.get("state") == "closed" else \
        "draft" if pr.get("draft") else "open"
    out = {"number": pr.get("number"), "state": state, "base": (pr.get("base") or {}).get("ref"),
           "url": pr.get("html_url")}
    head = (pr.get("head") or {}).get("sha")
    if head:
        out["head"] = head
    if state == "merged" and pr.get("merge_commit_sha"):
        out["merge_commit"] = pr["merge_commit_sha"]
    return out


def branch_prs(repo_key: str, branch: str):
    """(current PR, every merged PR plus the open one): the current one is the
    open PR, else the newest. None with no token; GH_ERROR when GitHub failed."""
    owner = repo_key.split("/")[0]
    rows = gh_get(f"/repos/{repo_key}/pulls?head={urllib.parse.quote(owner, safe='')}:"
                  f"{urllib.parse.quote(branch, safe='')}&state=all&per_page=100")
    if rows is None or rows is GH_ERROR:
        return rows
    if not isinstance(rows, list):
        return GH_ERROR
    prs = [_pr_fields(r) for r in rows]
    current = next((p for p in prs if p["state"] in OPEN_PR), prs[0] if prs else None)
    return current, [p for p in prs if p["state"] == "merged" or p["state"] in OPEN_PR]


def is_pr_url(url: str) -> bool:
    return bool(_PR_URL.match(url or ""))


def url_pr(url: str):
    m = _PR_URL.match(url or "")
    if not m:
        return None
    pr = gh_get(f"/repos/{m.group(1)}/{m.group(2)}/pulls/{m.group(3)}")
    if pr is GH_ERROR:
        return GH_ERROR
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


state_file = statelock.state_file


def read_json(f: Path) -> dict:
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


_write_json = statelock.write_json


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


def store_repo(root: Path) -> tuple:
    """(repo key, folder) for the store's own repo, or ("", None)."""
    for d in _store_dirs(root):
        here = checkout.local(d)
        if here["repo"] and (Path(here["dir"]) / ".git").exists():
            return here["repo"], Path(here["dir"])
    return "", None


def repo_dir(root: Path, key: str) -> Path | None:
    """A local checkout of `key`: the store's own repo, then the one around the working directory."""
    own, d = store_repo(root)
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
                own = store_repo(root)[0]
            key = own
        if key:
            out.setdefault(key, []).append(it)
    return out


def is_archived(root: Path, it: dict) -> bool:
    if it["folder"] == store.ARCHIVED:
        return True
    try:
        return bool((yamlio.read(_item_dir(root, it) / store.ITEM_FILE) or {}).get("archived"))
    except Exception:  # noqa: BLE001
        return False


# ── computing ─────────────────────────────────────────────────────────────────
def _branch_facts(repo: Repo, it: dict, old: dict, fetch_prs, track: list) -> list:
    """Each branch's head, PRs and landed-in; `unknown` says why something
    couldn't be read. `fetch_prs` is "force", True (when the head moved since
    the last fetch) or False."""
    out = []
    for name in it["branches"]:
        o = old.get(name) or {}
        live = repo.tips.get(name)
        head = live or o.get("head")
        b = {"name": name}
        if head:
            b["head"] = head
        if live is None:
            b["gone"] = True
        pr, prs = o.get("pr"), o.get("prs") or []
        if "pr_head" in o:
            b["pr_head"] = o["pr_head"]
        if head and (fetch_prs == "force" or (fetch_prs and o.get("pr_head") != head)):
            got = branch_prs(repo.key, name)
            if got is GH_ERROR:
                b["unknown"] = "GitHub didn't answer for its PRs"
            elif got is not None:
                (pr, prs), b["pr_head"] = got, head
        elif pr and pr.get("state") in OPEN_PR and pr.get("base") in repo.covered:
            hit = next((p for p in repo.closed.get(name, []) if p["number"] == pr["number"]), None)
            if hit:
                pr = hit
                prs = ([hit] if hit["state"] == "merged" else []) + [p for p in prs if p["number"] != hit["number"]]
        if pr:
            b["pr"] = pr
        if prs:
            b["prs"] = prs
        landed = next((p.get("merge_commit") for p in prs if p["state"] == "merged" and p.get("head") == head
                       and p.get("merge_commit")), None) or head
        if live is None and head and landed != head:
            b["merged_gone"] = True             # its last merged PR carried this head: it has landed
        if landed:
            b["landed"] = landed
            if track:
                b["in"] = {t: repo.is_ancestor(landed, repo.tips[t]) if t in repo.tips else None for t in track}
        out.append(b)
    return out


def _targets(repo: Repo, facts: dict, owners: dict, track: list, others: dict) -> None:
    """T(B) per branch: follow an open PR's base through branches open items
    own, to the first branch none owns. That branch is T(B) when it's tracked,
    the default, or any other branch on the remote; an untracked one is an
    orphan beside a `track:` list and a hint without one. A base a cancelled
    or archived item lists, or one gone from the remote, ends the chain as an
    orphan. With no open PR, T(B) is the first tracked branch on the remote,
    else the default branch."""
    by_name = {b["name"]: b for i, fx in facts.items() for b in fx["branches"] if owners.get(b["name"]) == i}
    fallback = next((t for t in track if t in repo.tips), None) or repo.default
    for fx in facts.values():
        for b in fx["branches"]:
            chain, cur, seen, target = [], b, {b["name"]}, fallback
            while True:
                pr = cur.get("pr") or {}
                if pr.get("state") not in OPEN_PR or not pr.get("base"):
                    break
                base = pr["base"]
                if base in seen:
                    break
                if base in repo.fixed:
                    target = base
                    break
                if base not in owners:
                    untracked = base in repo.tips and base not in others
                    if untracked:
                        target = base
                    if untracked and not track:
                        b["hint"] = UNTRACKED_HINT.format(branch=b["name"], base=base)
                    else:
                        b["orphan"] = base
                    break
                chain.append(base)
                seen.add(base)
                cur = by_name[base]
            b["target"] = target
            if chain:
                b["chain"] = chain
            if target not in repo.tips and "unknown" not in b:
                b["unknown"] = f"its target {target} isn't on the remote"


def _relate(x: tuple, y: tuple, ux: set, uy: set):
    """Who needs whom between two related branches: (dependent, dependency), or None when it's ambiguous."""
    xb, yb = x[1], y[1]
    if yb["name"] in (xb.get("chain") or []):
        return x, y
    if xb["name"] in (yb.get("chain") or []):
        return y, x
    if xb["head"] == yb["head"]:
        return None
    if yb["head"][:SHA_KEY] in ux:
        return x, y
    if xb["head"][:SHA_KEY] in uy:
        return y, x
    return None


def _resolve(repo: Repo, dep: dict, ab: dict, tip: str, mb: str) -> tuple:
    """(state, why) of "B needs A" while they still share unlanded commits:
    landed through a merged PR of A's branch that carried the shared commits
    and reached B's target; stale when A can't land; else waiting."""
    covered = False
    for p in ab.get("prs") or []:
        if p["state"] != "merged" or not p.get("head"):
            continue
        if not repo.ensure(p["head"], p["number"]):
            return "unknown", f'PR #{p["number"]}\'s head commit isn\'t available from origin'
        carried = repo.is_ancestor(mb, p["head"])
        if carried is None:
            return "unknown", f'couldn\'t check PR #{p["number"]}'
        if not carried:
            continue
        covered = True
        if p.get("merge_commit"):
            reached = repo.is_ancestor(p["merge_commit"], tip)
            if reached is None:
                return "unknown", f'couldn\'t check PR #{p["number"]}'
            if reached:
                return "landed", f'{ab["name"]} landed through PR #{p["number"]} ({p["merge_commit"][:7]})'
    if dep["status"] in CANT_LAND:
        return "stale", f'{dep["id"]} is {dep["status"]}'
    pr = ab.get("pr") or {}
    if pr.get("state") == "closed" and not covered:
        return "stale", f'its PR #{pr.get("number")} closed unmerged'
    return "waiting", ""


def _edge(a_it: dict, ab: dict, bb: dict, state: str, why: str, shared: list) -> dict:
    n = len(shared)
    evidence = why or (f'{bb["name"]} carries {n} commit{"s" if n != 1 else ""} of {ab["name"]} '
                       f'not in {bb["target"]}: {", ".join(s[:7] for s in shared[:SHOWN_COMMITS])}')
    return {"id": a_it["id"], "item": a_it.get("uid"), "branch": ab["name"], "via": bb["name"],
            "target": bb["target"], "state": state, "source": "git", "evidence": evidence,
            "shared": n, "commits": [s[:7] for s in shared[:SHOWN_COMMITS]], "mb": shared[0] if shared else None}


def _mirror(e: dict, b_it: dict, bb: dict, ab: dict) -> dict:
    return {**e, "id": b_it["id"], "item": b_it.get("uid"), "branch": bb["name"], "via": ab["name"]}


def _reached(repo: Repo, dep: dict, ab: dict, tip: str, target: str) -> tuple:
    """Whether A's current work reached T(B): (True, why, the commit that
    carried it), (False, "", None), or (None, why, None) when it couldn't be
    checked. Through a merged PR that carried A's head (its merge or squash
    commit), A's head itself, or A's finished item landed-in."""
    for p in ab.get("prs") or []:
        if p["state"] == "merged" and p.get("head") == ab.get("head") and p.get("merge_commit"):
            reached = repo.is_ancestor(p["merge_commit"], tip)
            if reached is None:
                return None, f'couldn\'t check PR #{p["number"]}', None
            if reached:
                return True, f'{ab["name"]} landed through PR #{p["number"]} ({p["merge_commit"][:7]})', p["merge_commit"]
    if ab.get("head") and repo.is_ancestor(ab["head"], tip):
        return True, f'{ab["name"]} is in {target}', ab["head"]
    if dep["status"] in COMPLETE and (ab.get("in") or {}).get(target) is True:
        return True, f'{dep["id"]} is {dep["status"]} and landed in {target}', ab.get("landed")
    return False, "", None


def _chain_state(repo: Repo, dep: dict, ab: dict, tip: str | None, target: str = "") -> tuple:
    """(state, why) of "B needs A" through B's PR base chain: landed once A's
    current work reached T(B)."""
    if not tip:
        return "unknown", "T(B) isn't on the remote"
    reached, why, _ = _reached(repo, dep, ab, tip, target)
    if reached is None:
        return "unknown", why
    if reached:
        return "landed", why
    if dep["status"] in CANT_LAND:
        return "stale", f'{dep["id"]} is {dep["status"]}'
    if (ab.get("pr") or {}).get("state") == "closed":
        return "stale", f'its PR #{ab["pr"].get("number")} closed unmerged'
    return "waiting", ""


def _pr_for_head(b: dict):
    return next((p["number"] for p in [b.get("pr") or {}] + (b.get("prs") or []) if p.get("head") == b.get("head")), None)


def _unlanded(repo: Repo, items: list, facts: dict) -> dict:
    """U per branch that can be read, less the commits already on a long-lived
    branch; branches that can't be read get `unknown`."""
    u: dict = {}
    for it in items:
        for b in facts[it["id"]]["branches"]:
            if b["name"] in repo.fixed or "unknown" in b or not b.get("head") or b.get("merged_gone"):
                continue
            if not repo.ensure(b["head"], _pr_for_head(b)):
                b["unknown"], b["lost"] = "its head commit isn't available from origin", True
                continue
            got = repo.unlanded(repo.tips[b["target"]], b["head"])
            if got is None:
                b["unknown"] = f"couldn't list its commits not in {b['target']} (or more than {UNLANDED_CAP})"
                continue
            drift = repo.drift(b["target"])
            if drift is None:
                b["unknown"] = (f"couldn't list the long-lived branches' commits not in {b['target']} "
                                f"(or more than {UNLANDED_CAP})")
                continue
            landed = set().union(*drift.values())
            u[(it["id"], b["name"])] = [s for s in got if s not in landed]
    return u


def _chain_edges(repo: Repo, items: list, facts: dict, u: dict, others: dict) -> set:
    """B needs every item whose branch B's PR base chain runs through, shared
    commits or not; a chain ending at a branch no open item owns needs that
    item (stale) or, owned by nobody, can't be checked. The chained pairs."""
    owner = {b: it for it in items if it["status"] != "cancelled" for b in it["branches"] if b not in repo.fixed}
    branch = {(i, b["name"]): b for i in facts for b in facts[i]["branches"]}
    chained = set()
    for b_it in items:
        if b_it["status"] == "cancelled":
            continue
        for bb in facts[b_it["id"]]["branches"]:
            tip = repo.tips.get(bb["target"])
            for name in bb.get("chain") or []:
                a_it = owner[name]
                ab = branch[(a_it["id"], name)]
                chained.add(tuple(sorted(((b_it["id"], bb["name"]), (a_it["id"], name)))))
                ub, ua = u.get((b_it["id"], bb["name"])), u.get((a_it["id"], name))
                common = [x for x in ub if x in set(ua)] if ub is not None and ua is not None else []
                state, why = (_resolve(repo, a_it, ab, tip, common[0]) if common and tip
                              else _chain_state(repo, a_it, ab, tip, bb["target"]))
                e = {**_edge(a_it, ab, bb, state, why or f'{bb["name"]}\'s PR is based on {name}', common), "chain": True}
                facts[b_it["id"]]["needs"].append(e)
                facts[a_it["id"]]["needed_by"].append(_mirror(e, b_it, bb, ab))
            name = bb.get("orphan")
            if not name:
                continue
            dep, ab = others.get(name, (None, None))
            if dep is not None:
                ab = next((x for x in (facts.get(dep["id"]) or {}).get("branches") or [] if x["name"] == name), ab)
                state, why = _chain_state(repo, dep, ab, tip, bb["target"]) if tip else ("unknown", "T(B) isn't on the remote")
                if state not in ("landed", "unknown"):
                    state, why = "stale", f'{bb["name"]}\'s PR is based on {name}, whose item {dep["id"]} is ' + (
                        "archived" if dep["folder"] == store.ARCHIVED else dep["status"])
                e = {"id": dep["id"], "item": dep.get("uid"), "branch": name, "via": bb["name"], "target": bb["target"],
                     "state": state, "source": "git", "evidence": why, "chain": True}
                facts[b_it["id"]]["needs"].append(e)
                if dep["id"] in facts:
                    facts[dep["id"]]["needed_by"].append(_mirror(e, b_it, bb, {"name": name}))
                    chained.add(tuple(sorted(((b_it["id"], bb["name"]), (dep["id"], name)))))
            else:
                facts[b_it["id"]]["needs"].append({
                    "needs": f"branch:{name}", "branch": name, "via": bb["name"], "target": bb["target"], "state": "unknown",
                    "source": "git", "chain": True, "reason": f"PR based on {name}, which no item tracks",
                    "evidence": "add the branch to its item, or retarget the PR"})
    return chained


def _git_relations(repo: Repo, items: list, facts: dict, prev: dict, others: dict) -> None:
    """Needs, needed-by and shares between branches of different items: chain
    edges first, then the other pairs from intersecting their unlanded
    commits; carried over where a side couldn't be read or was rewritten."""
    by_id = {it["id"]: it for it in items}
    u = _unlanded(repo, items, facts)
    chained = _chain_edges(repo, items, facts, u, others)
    index: dict = {}
    for key, shas in u.items():
        for x in shas:
            index.setdefault(x, []).append(key)
    shared: dict = {}
    for keys in index.values():
        for x, y in combinations(keys, 2):
            if x[0] != y[0]:
                shared.setdefault(tuple(sorted((x, y))), True)
    branch = {(i, b["name"]): b for i in facts for b in facts[i]["branches"]}
    related = set(chained)
    for (xk, yk) in shared:
        if (xk, yk) in chained:
            continue
        xi, yi = by_id[xk[0]], by_id[yk[0]]
        x, y = (xi, branch[xk]), (yi, branch[yk])
        ux, uy = set(u[xk]), set(u[yk])
        related.add((xk, yk))
        rel = _relate(x, y, ux, uy)
        if rel is None:
            for (pi, pb), (qi, qb), up, uq in ((x, y, u[xk], uy), (y, x, u[yk], ux)):
                common = [c for c in up if c in uq]
                facts[pi["id"]]["shares"].append({
                    "id": qi["id"], "item": qi.get("uid"), "branch": qb["name"], "via": pb["name"], "shared": len(common),
                    "commits": [c[:7] for c in common[:SHOWN_COMMITS]], "evidence": SHARES_HINT})
            continue
        (b_it, bb), (a_it, ab) = rel
        if b_it["status"] == "cancelled":
            continue
        common = [c for c in u[(b_it["id"], bb["name"])] if c in set(u[(a_it["id"], ab["name"])])]
        state, why = _resolve(repo, a_it, ab, repo.tips[bb["target"]], common[0])
        e = _edge(a_it, ab, bb, state, why, common)
        facts[b_it["id"]]["needs"].append(e)
        facts[a_it["id"]]["needed_by"].append(_mirror(e, b_it, bb, ab))
    _carry(repo, items, facts, prev, u, related)


def _carry(repo: Repo, items: list, facts: dict, prev: dict, u: dict, related: set) -> None:
    """Previous git edges and shares that this round didn't find again: kept
    as unknown when a side couldn't be read, as landed when the shared commits
    are now in the dependent's target."""
    by_id = {it["id"]: it for it in items}
    branch = {(i, b["name"]): b for i in facts for b in facts[i]["branches"]}

    def unknown_of(key):
        b = branch.get(key)
        return b.get("unknown") if b is not None else None

    for it in items:
        if it["status"] == "cancelled":
            continue
        old = prev.get(it["id"]) or {}
        for e in old.get("needs") or []:
            if e.get("source") != "git" or not e.get("id") or e.get("id") not in by_id:
                continue
            me, other = (it["id"], e.get("via")), (e["id"], e.get("branch"))
            if me not in branch or other not in branch or tuple(sorted((me, other))) in related:
                continue
            why = unknown_of(me) or unknown_of(other)
            dep = by_id[e["id"]]
            if why:
                _add_pair(facts, it, dep, {**e, "state": "unknown", "reason": why, "target": branch[me].get("target")})
                continue
            tip = repo.tips.get(branch[me]["target"])
            mb = e.get("mb")
            if branch[other].get("merged_gone") and tip:
                landed = repo.is_ancestor(branch[other]["landed"], tip)
            elif mb and mb in set(u.get(me) or ()):
                _rewritten(repo, facts, it, dep, e, branch[other], branch[me], branch[me]["target"], tip)
                continue
            else:
                landed = repo.is_ancestor(mb, tip) if mb and tip else False
            if landed is None:
                _add_pair(facts, it, dep, {**e, "state": "unknown", "reason": "couldn't check its shared commits"})
            elif landed:
                _add_pair(facts, it, dep, {**e, "state": "landed", "target": branch[me]["target"],
                                           "evidence": f'the shared commits are in {branch[me]["target"]}'})
        for s in old.get("shares") or []:
            me, other = (it["id"], s.get("via")), (s.get("id"), s.get("branch"))
            if me not in branch or other not in branch or tuple(sorted((me, other))) in related:
                continue
            if s.get("rewritten"):
                if s.get("mb") in set(u.get(me) or ()) and not _merged_in(repo, s.get("landing"), branch[me]):
                    facts[it["id"]]["shares"].append(s)
                continue
            why = unknown_of(me) or unknown_of(other)
            if why:
                facts[it["id"]]["shares"].append({**s, "state": "unknown", "reason": why})


def _rewritten(repo: Repo, facts: dict, b_it: dict, a_it: dict, e: dict, ab: dict, bb: dict, target: str,
               tip: str | None) -> None:
    """B still carries commits A dropped when it was rewritten: B waits until
    A's current work reaches T(B), then keeps a hint to merge it in until B
    holds the commit that carried it."""
    mb, old = e["mb"], f'{e.get("via")} still carries its old commits ({e["mb"][:7]})'
    reached, why, landing = _reached(repo, a_it, ab, tip, target) if tip else (None, "T(B) isn't on the remote", None)
    if reached:
        if _merged_in(repo, landing, bb):
            return
        facts[b_it["id"]]["shares"].append({
            "id": a_it["id"], "item": a_it.get("uid"), "branch": e.get("branch"), "via": e.get("via"), "shared": 1,
            "commits": [mb[:7]], "mb": mb, "rewritten": True, "landing": landing,
            "evidence": f'{e.get("branch")} was rewritten and has landed in {target}, but {old}: merge {target} into {e.get("via")}'})
    elif reached is None:
        _add_pair(facts, b_it, a_it, {**e, "state": "unknown", "reason": why, "target": target})
    else:
        _add_pair(facts, b_it, a_it, {**e, "state": "waiting", "target": target,
                                      "evidence": f'{e.get("branch")} was rewritten, and {old}'})


def _merged_in(repo: Repo, landing: str | None, bb: dict) -> bool:
    """Whether B's head holds the commit through which A's work landed."""
    return bool(landing and bb.get("head") and repo.is_ancestor(landing, bb["head"]))


def _add_pair(facts: dict, b_it: dict, a_it: dict, e: dict) -> None:
    facts[b_it["id"]]["needs"].append(e)
    if a_it["id"] in facts:
        facts[a_it["id"]]["needed_by"].append({**e, "id": b_it["id"], "item": b_it.get("uid"),
                                               "branch": e.get("via"), "via": e.get("branch")})


def _note_edges(root: Path, repo: Repo, it: dict, notes: list, items: list, facts: dict, all_items: list) -> list:
    """Edges from plugin-made dependency notes: (needed item or None, its branch or None, edge)."""
    out = []
    by_branch = {b: x for x in items for b in x["branches"]}
    own = facts[it["id"]]["branches"]
    for n in notes:
        m = n.get("meta") or {}
        needs = to_str(m.get("needs")).strip()
        target = to_str(m.get("in")).strip() or (own[0].get("target") if own else None) or repo.default
        tip = repo.tips.get(target)
        edge = {"needs": needs, "target": target, "source": "plugin", "note": n.get("uid"),
                "evidence": to_str(m.get("because")).strip() or n["text"].strip()}
        dep, branches = None, []
        if needs.startswith("item:"):
            ref = needs[len("item:"):]
            dep = next((x for x in all_items if ref in (x["id"], x.get("uid"))), None)
            branches = ((facts.get(dep["id"]) or load(root, dep)).get("branches") or []) if dep else []
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
        edge["state"] = _note_state(repo, dep, branches, tip)
        out.append((dep, branches[0] if len(branches) == 1 else None, edge))
    return out


def _note_state(repo: Repo, dep: dict | None, branches: list, tip: str | None) -> str:
    if dep is not None and dep["status"] in CANT_LAND:
        return "stale"
    if dep is not None and not dep["branches"]:
        return "landed" if dep["status"] in COMPLETE else "waiting"
    if not branches or not tip:
        return "waiting"
    states = [repo.is_ancestor(b["landed"], tip) if b.get("landed") else False for b in branches]
    if any(s is None for s in states):
        return "unknown"
    return "landed" if all(states) else "waiting"


def _pr_edge(repo: Repo, url: str, target: str, meta: dict) -> dict:
    pr = url_pr(url)
    if pr is GH_ERROR:
        return {"state": "unknown", "reason": "GitHub didn't answer for the PR"}
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
    if landed is None:
        return {"state": "unknown", "reason": f'couldn\'t check PR #{pr["number"]} against {target}', "pr": pr}
    return {"state": "landed" if landed else "waiting", "pr": pr}


def _changed(repo: Repo, b: dict) -> set | None:
    """Files B changes against T(B); when it carries commits of a long-lived
    branch that T(B) lacks, only those it also changes against that branch."""
    tip = repo.tips[b["target"]]
    files = repo.changed(tip, b["head"])
    if not files:
        return None
    files, carried = set(files), set(repo.unlanded(tip, b["head"]) or ())
    for name, commits in (repo.drift(b["target"]) or {}).items():
        if commits & carried:
            also = repo.changed(repo.tips[name], b["head"])
            if also is None:
                return None
            files &= set(also)
    return files


def _hints(repo: Repo, items: list, facts: dict, notice: list) -> None:
    """Conflicts and overlaps between live, unrelated branches of different
    items: files both change, and merge-tree only where they do."""
    related = {frozenset(((it["id"], e.get("via")), (e.get("id"), e.get("branch"))))
               for it in items for k in ("needs", "shares") for e in facts[it["id"]][k]}
    live = []
    for it in items:
        if it["status"] == "cancelled":
            continue
        for b in facts[it["id"]]["branches"]:
            if "unknown" in b or b.get("gone") or not b.get("head") or (b.get("pr") or {}).get("state") in ("merged", "closed"):
                continue
            files = _changed(repo, b)
            if files:
                live.append((it, b, files))
    can_merge_tree = git_version() >= MERGE_TREE_GIT
    if not can_merge_tree and live:
        notice.append("conflicts need git 2.38 or newer; skipped")
    for (a_it, ab, af), (b_it, bb, bf) in combinations(live, 2):
        if a_it is b_it or frozenset(((a_it["id"], ab["name"]), (b_it["id"], bb["name"]))) in related:
            continue
        common = sorted(af & bf)
        if not common:
            continue
        pair = ((a_it, ab, b_it, bb), (b_it, bb, a_it, ab))
        files = repo.conflicts(ab["head"], bb["head"]) if can_merge_tree else None
        for x, xb, y, yb in pair:
            row = {"id": y["id"], "item": y.get("uid"), "branch": yb["name"], "via": xb["name"]}
            facts[x["id"]]["overlaps"].append({**row, "files": common})
            if files:
                facts[x["id"]]["conflicts"].append({**row, "files": files})


def _compute(root: Path, repo: Repo, items: list, fetch_prs, all_items: list, failure: str | None = None) -> dict:
    """Every item's facts in one repo, by item id. With `failure`, nothing
    could be read: every previous fact stays, its edges marked unknown."""
    prev = {it["id"]: load(root, it) for it in items}
    track = repo.track() if failure is None else []
    repo.fixed = set(track) | {repo.default}
    open_ids = {it["id"] for it in items if it["status"] != "cancelled"}
    owners = {b: it["id"] for it in items if it["id"] in open_ids for b in it["branches"] if b not in repo.fixed}
    facts = {}
    for it in items:
        old = {b.get("name"): b for b in prev[it["id"]].get("branches") or [] if isinstance(b, dict)}
        if failure is not None:
            branches = [{**(old.get(n) or {"name": n}), "unknown": failure} for n in it["branches"]]
        else:
            branches = _branch_facts(repo, it, old, fetch_prs(it), track)
        facts[it["id"]] = {"repo": repo.key, "branches": branches,
                           "needs": [], "needed_by": [], "shares": [], "conflicts": [], "overlaps": []}
    if failure is not None:
        _carry(repo, items, facts, prev, {}, set())
    else:
        others = _others(root, repo, items)
        _targets(repo, facts, owners, track, others)
        repo.absent = repo.missing([b.get("head") for f in facts.values() for b in f["branches"]]
                                   + [p.get("head") for f in facts.values() for b in f["branches"] for p in b.get("prs") or []])
        _git_relations(repo, items, facts, prev, others)
    for it in items:
        if it["status"] == "cancelled":
            continue
        full = store.get_item(root, it["id"]) or {"notes": []}
        notes = [n for n in full["notes"] if n["kind"] == "dependency"]
        for dep, dep_branch, e in _note_edges(root, repo, it, notes, items, facts, all_items):
            if failure is not None:
                e = {**e, "state": "unknown", "reason": failure}
            facts[it["id"]]["needs"].append(e)
            if dep is not None and dep["id"] in facts:
                facts[dep["id"]]["needed_by"].append({**e, "id": it["id"], "item": it.get("uid"),
                                                      "branch": (it["branches"] or [None])[0],
                                                      "via": dep_branch["name"] if dep_branch else None})
    _cycles(facts)
    notice: list = [failure] if failure else []
    if failure is None:
        _hints(repo, items, facts, notice)
    for it in items:
        f = facts[it["id"]]
        f["waits_on"] = sorted({e.get("id") or e.get("needs") for e in f["needs"] if e["state"] in UNRESOLVED})
        if notice:
            f["notice"] = notice[0]
        if not f["branches"] and not f["needs"] and not f["needed_by"]:
            facts[it["id"]] = {}
    return facts


def _others(root: Path, repo: Repo, items: list) -> dict:
    """Branch → (the cancelled or archived item of this repo that lists it, its last branch facts)."""
    group = _groups(root, store.list_todos(root)).get(repo.key) or []
    out = {}
    for it in group:
        if it["status"] == "cancelled" or is_archived(root, it):
            last = {b.get("name"): b for b in load(root, it).get("branches") or [] if isinstance(b, dict)}
            for b in it["branches"]:
                if b not in repo.fixed:
                    out[b] = (it, last.get(b) or {"name": b})
    return out


def _and(names: list) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _arrow(e: dict) -> str:
    """`a1←b1`: the needed branch, then the one that needs it."""
    return f'{e.get("branch")}←{e.get("via")}'


def _cycles(facts: dict) -> None:
    """Label unresolved edges that make items wait on each other in a ring."""
    graph = {i: {e["id"] for e in f.get("needs") or [] if e.get("id") in facts and e["id"] != i
                 and e["state"] in UNRESOLVED} for i, f in facts.items()}
    index, low, stack, on, sccs, counter = {}, {}, [], set(), [], [0]

    def visit(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in graph[v]:
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            ring = []
            while True:
                w = stack.pop()
                on.discard(w)
                ring.append(w)
                if w == v:
                    break
            if len(ring) > 1:
                sccs.append(sorted(ring))

    for v in sorted(graph):
        if v not in index:
            visit(v)
    for ring in sccs:
        edges = [e for i in ring for e in facts[i]["needs"] if e.get("id") in ring and e["state"] in UNRESOLVED]
        text = (f'{_and(ring)} wait on each other through {_and([_arrow(e) for e in edges])}: '
                "merge them in one order, or split the items")
        for i in ring:
            for k in ("needs", "needed_by"):
                for e in facts[i][k]:
                    if e.get("id") in ring and e["state"] in UNRESOLVED:
                        e["cycle"] = text


def _strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "at"}


# ── when facts recompute ─────────────────────────────────────────────────────
def _recorded(root: Path, it: dict) -> list:
    return [b.get("name") for b in load(root, it).get("branches") or [] if isinstance(b, dict)]


def _relevant(root: Path, group: list, repo: Repo) -> set:
    """Branches whose move can change a fact: the items' own, their targets and
    PR bases, the default and tracked ones, and those dependency notes name."""
    names = {"HEAD", repo.default, *repo.track()}
    for it in group:
        names.update(it["branches"])
        f = load(root, it)
        for b in f.get("branches") or []:
            names.update(x for x in (b.get("target"), (b.get("pr") or {}).get("base")) if x)
            names.update(b.get("chain") or [])
            names.update((b.get("in") or {}).keys())
        for e in f.get("needs") or []:
            if e.get("source") == "plugin" and e.get("branch"):
                names.add(e["branch"])
        for n in (store.get_item(root, it["id"]) or {}).get("notes") or []:
            needs = to_str((n.get("meta") or {}).get("needs"))
            if n["kind"] == "dependency" and needs.startswith("branch:"):
                names.add(needs[len("branch:"):])
    return names


def _merged_into(repo: Repo, root: Path, group: list, moved_tracked: set) -> set:
    """For tracked branches that moved, the PRs recently closed into each, from
    one list call per branch; the items whose open PR that didn't cover."""
    repo.closed, repo.covered = {}, set()
    for t in sorted(moved_tracked):
        rows = gh_get(f"/repos/{repo.key}/pulls?state=closed&base={urllib.parse.quote(t, safe='')}"
                      "&sort=updated&direction=desc&per_page=100")
        if rows is None:
            return set()
        if isinstance(rows, list):
            repo.covered.add(t)
            for r in rows:
                repo.closed.setdefault((r.get("head") or {}).get("ref"), []).append(_pr_fields(r))
    return {it["id"] for it in group for b in load(root, it).get("branches") or []
            if (b.get("pr") or {}).get("state") in OPEN_PR and (b["pr"].get("base") not in repo.covered)}


def on_round(root: Path, remote=None, project: str | None = None, *, force: bool = False,
             repos: set | None = None, fetch_prs=True, prs_for: set | None = None,
             seen: dict | None = None) -> list:
    """Recompute the repos whose relevant branches moved (one ls-remote each)
    or whose items' branches changed; with `force`, every repo asked for. PRs
    are refetched for branches whose head moved since their last fetch, and
    for the items in `prs_for`; when a tracked branch moved, one list of the
    PRs closed into it stands in for refetching each open one. Posts what
    changed when given a server. Each repo's ls-remote answer goes into `seen`
    as `{tips, default, dir}`.
    Returns the ids of changed items."""
    all_items = [it for it in store.list_todos(root) if not is_archived(root, it)]
    groups = _groups(root, all_items)
    tips_file, cache_file = state_file(root, TIPS_FILE), state_file(root, CACHE_FILE)
    state = read_json(tips_file)
    cache = read_json(cache_file)
    started_unposted = set(state.get("unposted") or [])
    done: set = set()               # the repos whose entry this round rewrites
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
        if seen is not None:
            seen[key] = {"tips": tips, "default": repo.default, "dir": d}
        old_tips = saved.get("tips") or {}
        moved = {n for n in set(tips) | set(old_tips) if tips.get(n) != old_tips.get(n)}
        if saved.get("default") not in (None, repo.default):
            moved.add("HEAD")
        done.add(key)
        repo.tips = tips
        if not (force or touched or moved & _relevant(root, group, repo) or saved.get("incomplete")):
            state[key] = {**saved, "at": time.time(), "tips": tips, "default": repo.default}
            continue
        failure = None
        if repo.shallow():
            failure = "this checkout is a shallow clone; git facts need its full history"
        elif not repo.fetch_if_needed(tips.values()):
            failure = "fetching from origin didn't bring every branch's commits"
        repo.lost = set(saved.get("lost") or [])
        want = set(prs_for or ())
        moved_tracked = moved & set(repo.track()) if fetch_prs and failure is None else set()
        if moved_tracked:
            want |= _merged_into(repo, root, group, moved_tracked)   # a squash merge leaves the head where it was
        fresh = _compute(root, repo, group, lambda it: "force" if it["id"] in want else fetch_prs, all_items, failure)
        incomplete = failure is not None or any("unknown" in b and not b.get("lost")
                                                for f in fresh.values() for b in f.get("branches") or [])
        if not incomplete:
            for kind, bucket in repo.used.items():
                used.setdefault(kind, {}).update(bucket)
        state[key] = {"at": time.time(), "default": repo.default, "tips": old_tips if incomplete else tips,
                      **({"incomplete": True} if incomplete else {}), **({"lost": sorted(repo.lost)} if repo.lost else {})}
        stamp = now()
        for it in group:
            new = fresh.get(it["id"], {})
            if _strip(new) != _strip(load(root, it)):
                _save(root, it, {"at": stamp, **new} if new else {})
                changed.append(it["id"])
    unposted = started_unposted | set(changed) if sync_config(root) else set()
    if remote is not None and unposted:
        unposted = _post(root, remote, project, unposted)
    with statelock.locked(root):
        if used:
            _write_json(cache_file, used)
        fresh = read_json(tips_file)
        fresh.update({k: state[k] for k in done})
        fresh["unposted"] = sorted(unposted | (set(fresh.get("unposted") or []) - started_unposted))
        _write_json(tips_file, fresh)
    return changed


def _post(root: Path, remote, project, ids: set) -> set:
    """Send facts for `ids`; the ids still to send, which includes items the server doesn't have yet."""
    facts = []
    for item_id in sorted(ids):
        it = store.get_item(root, item_id)
        if it is not None and it.get("uid"):
            facts.append({"item_uid": it["uid"], "data": load(root, it)})
    if not facts:
        return set()
    try:
        got = remote.git_facts(project, facts)
    except (RemoteError, AttributeError):
        return ids
    skipped = set(got.get("skipped") or []) if isinstance(got, dict) else set()
    return {i for i in ids if (store.get_item(root, i) or {}).get("uid") in skipped}


def refresh(root: Path, items=None) -> list:
    """Recompute now, for the repos of `items` (every repo when None), refetching
    the PRs of those items and of the items they're related to."""
    repos, prs_for = None, None
    if items is None:
        return on_round(root, force=True, fetch_prs="force")
    if items is not None:
        items = [it for it in items if not is_archived(root, it)]
        repos = set(_groups(root, items))
        prs_for = {it["id"] for it in items}
        for it in items:
            f = load(root, it)
            prs_for.update(e["id"] for k in ("needs", "needed_by", "shares") for e in f.get(k) or [] if e.get("id"))
    return on_round(root, force=True, repos=repos, prs_for=prs_for)


def post_pending(root: Path) -> None:
    """Post the facts a synced store hasn't sent yet."""
    cfg = sync_config(root)
    r = remote_for(root) if cfg else None
    f = state_file(root, TIPS_FILE)
    sending = set(read_json(f).get("unposted") or [])
    if r is None or not sending:
        return
    left = _post(root, r, cfg.get("project"), sending)
    with statelock.locked(root):
        state = read_json(f)
        state["unposted"] = sorted(left | (set(state.get("unposted") or []) - sending))
        _write_json(f, state)


def maybe_local(root: Path, seen: dict | None = None) -> None:
    """A local-only store's recompute, at most every LOCAL_EVERY seconds, from
    local git alone: PRs wait for `todo refresh`. `seen` gets each repo's tips."""
    if sync_config(root) is not None or not root.is_dir():
        return
    f = state_file(root, TIPS_FILE)
    with statelock.locked(root):
        state = read_json(f)
        if time.time() - state.get("local_at", 0) < LOCAL_EVERY:
            return
        state["local_at"] = time.time()
        _write_json(f, state)
    try:
        on_round(root, fetch_prs=False, seen=seen)
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
                          "state": "unknown", "source": "plugin", "note": n.get("uid"),
                          "evidence": (to_str(m.get("because")) or n["text"]).strip(), "reason": "not checked yet"})
    if needs or facts:
        facts["needs"] = needs
        facts["waits_on"] = sorted({e.get("id") or e.get("needs") for e in needs if e["state"] in UNRESOLVED})
    return facts


def _blockers(root: Path, it: dict) -> list:
    f = view(root, it)
    edges = [e for e in f.get("needs") or [] if e["state"] in UNRESOLVED]
    own = [{"needs": b["name"], "state": "unknown", "source": "git", "reason": b["unknown"]}
           for b in f.get("branches") or [] if b.get("unknown") and b.get("name") in it["branches"]]
    return edges + own


def unresolved(root: Path, it: dict) -> list:
    """What stops the item staging: waiting, stale or unknown edges, and its own
    branches that couldn't be read. Facts that say so are rechecked first, and
    a synced store posts the recheck straight away."""
    it = store.get_item(root, it["id"]) or it
    edges = _blockers(root, it)
    if edges:
        try:
            refresh(root, [it])
            post_pending(root)
        except Exception:  # noqa: BLE001 — keep the stored facts
            return edges
        edges = _blockers(root, it)
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
    if e.get("state") == "unknown":
        why += f' (unknown: {e.get("reason") or "not computed"})'
    if e.get("cycle"):
        why += f'; {e["cycle"]}'
    return f'{who}{where} {e["state"]}{why}'


def from_checks(root: Path) -> list:
    """`(item id, check)` for every prereq-branch check in the store."""
    out = []
    for it in store.list_todos(root):
        for c in it["checks"]:
            if c["kind"] == "prereq-branch":
                out.append((it["id"], c))
    return out
