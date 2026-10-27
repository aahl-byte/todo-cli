// Git facts: where each item's branches landed, which in-flight branches depend
// on others, and which overlap. The server computes them through GitHub's API,
// with the token that reads each repo (see github-token.ts), and stores them per item in git_facts, keeping the conflicts
// a CLI reports, since those need a checkout. Facts are never set by hand.
// Each branch's unlanded commits come from one compare against its effective
// target, less the commits of the long-lived branches (the default and tracked
// ones) that target lacks, listed once per target; pairs are related by
// intersecting those sets in memory. A failure
// never reads as "no edge": the stored facts stay, marked unknown.
// See docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §2.
import { db as appDb, type Db, type Row } from "./db";
import { repoAllowed, repoKey, repoRefusal } from "./checkouts";
import { githubApi } from "./github";
import { anyGithubToken, githubToken, pageGithub, serverGithubToken, tokenHash } from "./github-token";
import { later } from "./http";
import { itemBranches } from "./model";

export type Fetch = typeof fetch;
export type EdgeState = "waiting" | "landed" | "stale" | "unknown";
export interface PrFact { number: number; state: "draft" | "open" | "merged" | "closed"; base: string | null; head?: string; merge_commit?: string; url?: string }
export interface BranchFact {
  name: string; head?: string; gone?: boolean; pr?: PrFact; prs?: PrFact[]; pr_head?: string; target?: string; chain?: string[];
  landed?: string; in?: Record<string, boolean | null>; unknown?: string;
  /** The chain ended at a branch no open item owns. */
  orphan?: string;
  /** Blocks nothing: the PR's base is a branch nothing tracks, in a repo with no deploy branches. */
  hint?: string;
  /** Deleted, and its last merged PR carried this head: it has landed. */
  merged_gone?: boolean;
}
/** `id`/`item` name the other item; `branch` is its branch and `via` this item's. A plugin edge also carries `needs`. */
export interface Edge {
  id?: string; item?: string; branch?: string | null; via?: string | null; target?: string; state: EdgeState;
  source: "git" | "plugin"; evidence?: string; reason?: string; needs?: string; note?: string; shared?: number; commits?: string[]; mb?: string | null;
  /** B's PR base chain runs through A's branch. */
  chain?: boolean;
  /** These items wait on each other in a ring. */
  cycle?: string;
  /** The PR a dependency note names by URL. */
  pr?: PrFact;
}
/** `rewritten`: B still carries commits A dropped, after A's current work landed; `mb` is the newest of them. */
export interface Share {
  id: string; item?: string; branch: string; via: string; shared: number; commits: string[]; evidence: string; state?: "unknown"; reason?: string;
  rewritten?: boolean; mb?: string;
  /** The commit through which A's work reached T(B); the hint lasts until B holds it. */
  landing?: string | null;
}
export interface Hint { id: string; item?: string; branch: string; via: string; files: string[]; title?: string }
export interface GitFacts {
  repo?: string; branches?: BranchFact[]; needs?: Edge[]; needed_by?: Edge[]; shares?: Share[]; conflicts?: Hint[]; overlaps?: Hint[];
  waits_on?: string[]; notice?: string; error?: string; conflicts_by?: string; at?: string;
}

export const GUARDED = ["ready-to-deploy", "deployed"];
export const UNRESOLVED: string[] = ["waiting", "stale", "unknown"];
export const HINTS = {
  conflict: "whichever merges second merges the other in",
  shares: "can't tell which builds on which; base the dependent PR on the other branch, or merge one into the other",
};
const EDGE_STATES = ["waiting", "landed", "stale", "unknown"];
const CANT_LAND = ["cancelled", "deferred"];
const COMPLETE = ["done", "deployed"];
const OPEN_PR = ["open", "draft"];
const TIMEOUT_MS = 5_000;
const STALE_MS = 2 * 60_000;
const UNLANDED_CAP = 2_000;
const PAGE = 100;
const CACHE_LIMIT = 2_000;
const SHA_KEY = 12;
const SHOWN_COMMITS = 3;

// ── GitHub ────────────────────────────────────────────────────────────────────
export class NotFound extends Error {}

/** A bounded LRU of the few fields each compare is read for. */
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<void>>();
const signatures = new Map<string, string>();
const trackedTips = new Map<string, Record<string, string | undefined>>();

export function resetGitFactsCache(): void {
  cache.clear();
  inflight.clear();
  signatures.clear();
  trackedTips.clear();
  branchLists.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (cache.has(key)) {
    const v = cache.get(key) as T;
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const v = await load();
  cache.set(key, v);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return v;
}

/** A GitHub API GET with `token`; NotFound on a 404. */
async function get(path: string, f: Fetch, token: string | null): Promise<any> {
  const res = await f(githubApi() + path, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 404) throw new NotFound(path);
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

export const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => { if (e instanceof NotFound) return null; throw e; });

/** A repo's branches as GitHub lists them, the default first, for picking deploy branches. `visible` is false when GitHub says the
 * repo isn't there for the token that reads it, null when there's no token or it didn't answer. */
export interface RemoteBranches { names: string[]; default: string | null; visible: boolean | null }

const BRANCH_LIST_MS = 5 * 60_000;
const branchLists = new Map<string, { at: number; value: RemoteBranches }>();

/** The repo's branches as the project's token sees them: GitHub's first page of them, or, when GitHub fails otherwise than saying
 * the repo isn't there, the tips the tick last polled with this same token; none without a token, or when the repo isn't there
 * for it. Kept a few minutes for each token. */
export async function remoteBranches(d: Pick<Db, "query">, project: string, repo: string, f: Fetch = fetch): Promise<RemoteBranches> {
  const auth = await githubToken(d, project, repo);
  if (!auth) return { names: [], default: null, visible: null };
  const at = `${repo}\x1f${tokenHash(auth.token)}`;
  const hit = branchLists.get(at);
  if (hit && Date.now() - hit.at < BRANCH_LIST_MS) return hit.value;
  let value: RemoteBranches;
  try {
    const def = String((await get(`/repos/${repo}`, f, auth.token)).default_branch ?? "") || null;
    const rows = (await get(`/repos/${repo}/branches?per_page=${PAGE}`, f, auth.token)) as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    value = { names: def ? [def, ...names.filter((n) => n !== def)] : names, default: def, visible: true };
  } catch (e) {
    if (e instanceof NotFound) value = { names: [], default: null, visible: false };
    else {
      const [poll] = await d.query("select tips from repo_polls where repo = $1 and polled_with = $2", [repo, tokenHash(auth.token)]);
      value = { names: Object.keys(poll?.tips ?? {}).sort(), default: null, visible: null };
    }
  }
  branchLists.set(at, { at: Date.now(), value });
  return value;
}

/** A repo's deploy branches in a project, as Settings → Automation (or `todo plugin deploy-branches`) set them. */
export async function deployBranches(d: Pick<Db, "query">, project: string, repo: string): Promise<string[]> {
  const [row] = await d.query("select track from plugin_configs where project = $1 and repo = $2", [project, repo]);
  return row?.track ?? [];
}

function prFact(pr: any): PrFact {
  const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  return { number: pr.number, state, base: pr.base?.ref ?? null, url: pr.html_url, ...(pr.head?.sha ? { head: pr.head.sha } : {}),
           ...(state === "merged" && pr.merge_commit_sha ? { merge_commit: pr.merge_commit_sha } : {}) };
}

class GitHubRepo {
  readonly key: string;
  constructor(readonly owner: string, readonly name: string, private f: Fetch, private token: string) { this.key = `${owner}/${name}`.toLowerCase(); }
  private get base() { return `/repos/${this.owner}/${this.name}`; }

  async defaultBranch(): Promise<string> {
    return (await get(this.base, this.f, this.token)).default_branch ?? "main";
  }
  /** Every branch's tip. */
  async tips(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (let page = 1; ; page++) {
      const rows = await get(`${this.base}/branches?per_page=${PAGE}&page=${page}`, this.f, this.token);
      for (const r of rows) out[r.name] = r.commit.sha;
      if (rows.length < PAGE) return out;
    }
  }
  /** The PRs most recently closed into `base`, by head branch, from one call. */
  async closedInto(base: string): Promise<Map<string, PrFact[]>> {
    const rows = await get(`${this.base}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${PAGE}`, this.f, this.token);
    const out = new Map<string, PrFact[]>();
    for (const r of rows as any[]) out.set(r.head?.ref, [...(out.get(r.head?.ref) ?? []), prFact(r)]);
    return out;
  }
  /** (current PR, every merged PR plus the open one): the current one is the open PR, else the newest. */
  async prs(branch: string): Promise<[PrFact | null, PrFact[]]> {
    const rows = await get(`${this.base}/pulls?head=${encodeURIComponent(`${this.owner}:${branch}`)}&state=all&per_page=${PAGE}`, this.f, this.token);
    const prs = (rows as any[]).map(prFact);
    return [prs.find((p) => OPEN_PR.includes(p.state)) ?? prs[0] ?? null,
            prs.filter((p) => p.state === "merged" || OPEN_PR.includes(p.state))];
  }
  /** U = tip..head, newest first as short shas, with the files head changes since their merge base; null past the cap or for an unknown commit. */
  unlanded(tip: string, head: string): Promise<{ shas: string[]; files: string[] } | null> {
    return cached(`u:${this.key}:${tip}:${head}`, async () => {
      const shas: string[] = [];
      let files: string[] = [];
      for (let page = 1; ; page++) {
        const c = await orNull(get(`${this.base}/compare/${tip}...${head}?per_page=${PAGE}&page=${page}`, this.f, this.token));
        if (!c) return null;
        const total = c.total_commits ?? c.ahead_by ?? 0;
        if (total > UNLANDED_CAP) return null;
        if (page === 1) files = (c.files ?? []).map((x: any) => String(x.filename));
        shas.push(...(c.commits ?? []).map((x: any) => String(x.sha).slice(0, SHA_KEY)));
        if (shas.length >= total || !(c.commits ?? []).length) return { shas: shas.reverse(), files: [...new Set(files)].sort() };
      }
    });
  }
  /** The files head changes since its merge base with tip; null for an unknown commit. */
  changed(tip: string, head: string): Promise<string[] | null> {
    return cached(`files:${this.key}:${tip}:${head}`, async () => {
      const c = await orNull(get(`${this.base}/compare/${tip}...${head}?per_page=1`, this.f, this.token));
      return c ? [...new Set<string>((c.files ?? []).map((x: any) => String(x.filename)))].sort() : null;
    });
  }
  /** Whether `sha` is an ancestor of `tip`; null for a commit GitHub doesn't know. */
  contains(tip: string, sha: string): Promise<boolean | null> {
    if (tip.startsWith(sha) || sha.startsWith(tip)) return Promise.resolve(true);
    return cached(`anc:${this.key}:${sha}:${tip}`, async () => {
      const c = await orNull(get(`${this.base}/compare/${sha}...${tip}`, this.f, this.token));
      return c ? c.status === "ahead" || c.status === "identical" : null;
    });
  }
}

// ── computing ─────────────────────────────────────────────────────────────────
interface ItemRow { uid: string; id: string; status: string; extra: Row | null }
type Facts = Required<Pick<GitFacts, "repo" | "branches" | "needs" | "needed_by" | "shares" | "overlaps">> & GitFacts;
/** `fixed`: tracked and default branches, never item-owned. `closed`: PRs recently closed into the tracked
 * branches in `covered`, which moved; an open PR with another base is refetched when `refetchOpen`. */
interface Ctx {
  gh: GitHubRepo; tips: Record<string, string>; def: string; track: string[]; fixed: Set<string>;
  /** The project's own GitHub token, which reads a PR a dependency names in another repo; `token` is null while it doesn't decrypt. */
  own: { given: boolean; token: string | null };
  closed: Map<string, PrFact[]>; covered: Set<string>; refetchOpen?: boolean;
}
type Key = string;
const keyOf = (uid: string, branch: string): Key => `${uid}\x1f${branch}`;

async function branchFacts(c: Ctx, it: ItemRow, old: GitFacts): Promise<BranchFact[]> {
  const before = new Map((old.branches ?? []).map((b) => [b.name, b]));
  const out: BranchFact[] = [];
  for (const name of itemBranches(it.extra)) {
    const o = before.get(name);
    const live = c.tips[name];
    const head = live ?? o?.head;
    let pr = o?.pr, prs = o?.prs ?? [], prHead = o?.pr_head;
    const open = !!pr && OPEN_PR.includes(pr.state);
    if (head && (prHead !== head || (c.refetchOpen && open && !c.covered.has(pr!.base ?? "")))) {
      const [cur, all] = await c.gh.prs(name);
      pr = cur ?? undefined;
      prs = all;
      prHead = head;
    } else if (open && c.covered.has(pr!.base ?? "")) {
      const hit = c.closed.get(name)?.find((p) => p.number === pr!.number);
      if (hit) {
        pr = hit;
        prs = [...(hit.state === "merged" ? [hit] : []), ...prs.filter((p) => p.number !== hit.number)];
      }
    }
    const b: BranchFact = { name, ...(head ? { head } : {}), ...(live ? {} : { gone: true }), ...(pr ? { pr } : {}),
                            ...(prs.length ? { prs } : {}), ...(prHead ? { pr_head: prHead } : {}) };
    const landed = prs.find((p) => p.state === "merged" && p.head === head && p.merge_commit)?.merge_commit ?? head;
    if (!live && head && landed !== head) b.merged_gone = true;
    if (landed) {
      b.landed = landed;
      if (c.track.length) {
        b.in = {};
        for (const t of c.track) b.in[t] = c.tips[t] ? await c.gh.contains(c.tips[t], landed) : null;
      }
    }
    out.push(b);
  }
  return out;
}

export const untrackedHint = (branch: string, base: string) =>
  `${branch}'s PR is based on ${base}; if ${base} is long-lived, add it to the repo's deploy branches on Settings → Automation`;

/** T(B): follow an open PR's base through branches open items own, to the first branch none owns. That branch is T(B)
 * when it's tracked, the default, or any other branch on the remote; an untracked one is an orphan beside deploy branches
 * and a hint without one. A base a cancelled or archived item lists, or one gone from the remote, ends the chain as an
 * orphan. With no open PR, the first tracked branch, else the default. */
function targets(c: Ctx, facts: Map<string, Facts>, owners: Map<string, string>, others: Map<string, ItemRow>): void {
  const byName = new Map<string, BranchFact>();
  for (const [uid, fx] of facts) for (const b of fx.branches) if (owners.get(b.name) === uid) byName.set(b.name, b);
  const fallback = c.track.find((t) => c.tips[t]) ?? c.def;
  for (const fx of facts.values()) {
    for (const b of fx.branches) {
      const chain: string[] = [], seen = new Set([b.name]);
      let cur = b, target = fallback;
      for (;;) {
        const base = cur.pr && OPEN_PR.includes(cur.pr.state) ? cur.pr.base : null;
        if (!base || seen.has(base)) break;
        if (c.fixed.has(base)) { target = base; break; }
        if (!owners.has(base)) {
          const untracked = !!c.tips[base] && !others.has(base);
          if (untracked) target = base;
          if (untracked && !c.track.length) b.hint = untrackedHint(b.name, base);
          else b.orphan = base;
          break;
        }
        chain.push(base);
        seen.add(base);
        cur = byName.get(base)!;
      }
      b.target = target;
      if (chain.length) b.chain = chain;
      if (!c.tips[target] && !b.unknown) b.unknown = `its target ${target} isn't on the remote`;
    }
  }
}

/** "B needs A" through B's PR base chain: landed once a merged PR of A's branch carried its head into T(B). */
/** Whether A's current work reached T(B), and the commit that carried it: through a merged PR that carried A's head (its
 * merge or squash commit), A's head itself, or A's finished item landed-in. Null when it couldn't be checked. */
async function reached(c: Ctx, dep: ItemRow, ab: BranchFact, tip: string, target: string): Promise<[boolean | null, string, string | null]> {
  for (const p of ab.prs ?? []) {
    if (p.state !== "merged" || p.head !== ab.head || !p.merge_commit) continue;
    const got = await c.gh.contains(tip, p.merge_commit);
    if (got === null) return [null, `couldn't check PR #${p.number}`, null];
    if (got) return [true, `${ab.name} landed through PR #${p.number} (${p.merge_commit.slice(0, 7)})`, p.merge_commit];
  }
  if (ab.head && (await c.gh.contains(tip, ab.head))) return [true, `${ab.name} is in ${target}`, ab.head];
  if (COMPLETE.includes(dep.status) && ab.in?.[target] === true) return [true, `${dep.id} is ${dep.status} and landed in ${target}`, ab.landed ?? null];
  return [false, "", null];
}

/** Whether B's head holds the commit through which A's work landed. */
async function mergedIn(c: Ctx, landing: string | null | undefined, bb: BranchFact): Promise<boolean> {
  return !!landing && !!bb.head && (await c.gh.contains(bb.head, landing)) === true;
}

async function chainState(c: Ctx, dep: ItemRow, ab: BranchFact, tip: string | undefined, target: string): Promise<[EdgeState, string]> {
  if (!tip) return ["unknown", "T(B) isn't on the remote"];
  const [got, why] = await reached(c, dep, ab, tip, target);
  if (got === null) return ["unknown", why];
  if (got) return ["landed", why];
  if (CANT_LAND.includes(dep.status)) return ["stale", `${dep.id} is ${dep.status}`];
  if (ab.pr?.state === "closed") return ["stale", `its PR #${ab.pr.number} closed unmerged`];
  return ["waiting", ""];
}

async function resolve(c: Ctx, dep: ItemRow, ab: BranchFact, tip: string, mb: string): Promise<[EdgeState, string]> {
  let covered = false;
  for (const p of ab.prs ?? []) {
    if (p.state !== "merged" || !p.head) continue;
    const carried = await c.gh.contains(p.head, mb);
    if (carried === null) return ["unknown", `couldn't check PR #${p.number}`];
    if (!carried) continue;
    covered = true;
    if (p.merge_commit) {
      const reached = await c.gh.contains(tip, p.merge_commit);
      if (reached === null) return ["unknown", `couldn't check PR #${p.number}`];
      if (reached) return ["landed", `${ab.name} landed through PR #${p.number} (${p.merge_commit.slice(0, 7)})`];
    }
  }
  if (CANT_LAND.includes(dep.status)) return ["stale", `${dep.id} is ${dep.status}`];
  if (ab.pr?.state === "closed" && !covered) return ["stale", `its PR #${ab.pr.number} closed unmerged`];
  return ["waiting", ""];
}

function relate(x: [ItemRow, BranchFact], y: [ItemRow, BranchFact], ux: Set<string>, uy: Set<string>) {
  const [xb, yb] = [x[1], y[1]];
  if (xb.chain?.includes(yb.name)) return [x, y] as const;
  if (yb.chain?.includes(xb.name)) return [y, x] as const;
  if (xb.head === yb.head) return null;
  if (ux.has(yb.head!.slice(0, SHA_KEY))) return [x, y] as const;
  if (uy.has(xb.head!.slice(0, SHA_KEY))) return [y, x] as const;
  return null;
}

function addPair(facts: Map<string, Facts>, b: ItemRow, a: ItemRow, e: Edge): void {
  facts.get(b.uid)!.needs.push(e);
  facts.get(a.uid)?.needed_by.push({ ...e, id: b.id, item: b.uid, branch: e.via, via: e.branch });
}

const commitEdge = (ai: ItemRow, ab: BranchFact, bb: BranchFact, state: EdgeState, why: string, common: string[]): Edge => {
  const n = common.length, shown = common.slice(0, SHOWN_COMMITS).map((s) => s.slice(0, 7));
  return { id: ai.id, item: ai.uid, branch: ab.name, via: bb.name, target: bb.target, state, source: "git", shared: n, commits: shown, mb: common[0] ?? null,
           evidence: why || `${bb.name} carries ${n} commit${n === 1 ? "" : "s"} of ${ab.name} not in ${bb.target}: ${shown.join(", ")}` };
};
const pairKey = (x: Key, y: Key) => [x, y].sort().join("\x1e");

/** B needs every item whose branch B's PR base chain runs through, shared commits or not; a chain ending at a branch no
 * open item owns needs that item (stale) or, owned by nobody, can't be checked. The chained pairs. */
async function chainEdges(c: Ctx, items: ItemRow[], facts: Map<string, Facts>, u: Map<Key, string[]>, others: Map<string, ItemRow>,
                          stored: Map<string, GitFacts>) {
  const owner = new Map<string, ItemRow>();
  for (const it of items) if (it.status !== "cancelled") for (const b of itemBranches(it.extra)) if (!c.fixed.has(b)) owner.set(b, it);
  const chained = new Set<string>();
  for (const bi of items) {
    if (bi.status === "cancelled") continue;
    for (const bb of facts.get(bi.uid)!.branches) {
      const tip = c.tips[bb.target!];
      for (const name of bb.chain ?? []) {
        const ai = owner.get(name)!;
        const ab = facts.get(ai.uid)!.branches.find((b) => b.name === name)!;
        chained.add(pairKey(keyOf(bi.uid, bb.name), keyOf(ai.uid, name)));
        const ub = u.get(keyOf(bi.uid, bb.name)), ua = new Set(u.get(keyOf(ai.uid, name)) ?? []);
        const common = ub && u.has(keyOf(ai.uid, name)) ? ub.filter((s) => ua.has(s)) : [];
        const [state, why] = common.length && tip ? await resolve(c, ai, ab, tip, common[0]) : await chainState(c, ai, ab, tip, bb.target!);
        addPair(facts, bi, ai, { ...commitEdge(ai, ab, bb, state, why || `${bb.name}'s PR is based on ${name}`, common), chain: true });
      }
      const name = bb.orphan;
      if (!name) continue;
      const dep = others.get(name);
      if (dep) {
        const ab = facts.get(dep.uid)?.branches.find((b) => b.name === name) ?? stored.get(dep.uid)?.branches?.find((b) => b.name === name) ?? { name };
        let [state, why] = await chainState(c, dep, ab, tip, bb.target!);
        if (state !== "landed" && state !== "unknown") {
          [state, why] = ["stale", `${bb.name}'s PR is based on ${name}, whose item ${dep.id} is ${dep.extra?.archived ? "archived" : dep.status}`];
        }
        addPair(facts, bi, dep, { id: dep.id, item: dep.uid, branch: name, via: bb.name, target: bb.target, state, source: "git", chain: true, evidence: why });
        if (facts.has(dep.uid)) chained.add(pairKey(keyOf(bi.uid, bb.name), keyOf(dep.uid, name)));
      } else {
        facts.get(bi.uid)!.needs.push({ needs: `branch:${name}`, branch: name, via: bb.name, target: bb.target, state: "unknown", source: "git", chain: true,
                                        reason: `PR based on ${name}, which no item tracks`, evidence: "add the branch to its item, or retarget the PR" });
      }
    }
  }
  return chained;
}

/** Per long-lived branch on the remote other than `target`, its commits not in `target`, which a branch can carry without
 * depending on anyone; null when one can't be listed. */
async function drift(c: Ctx, target: string): Promise<Map<string, Set<string>> | null> {
  const out = new Map<string, Set<string>>();
  for (const name of [...c.fixed].sort()) {
    if (name === target || !c.tips[name]) continue;
    const got = c.tips[name] === c.tips[target] ? { shas: [] } : await c.gh.unlanded(c.tips[target], c.tips[name]);
    if (!got) return null;
    out.set(name, new Set(got.shas));
  }
  return out;
}

/** The files a branch changes against T(B), and the long-lived branches whose commits T(B) lacks it carries. */
interface Changed { files: string[]; carries: string[] }

async function relations(c: Ctx, items: ItemRow[], facts: Map<string, Facts>, stored: Map<string, GitFacts>, others: Map<string, ItemRow>) {
  const byUid = new Map(items.map((it) => [it.uid, it]));
  const u = new Map<Key, string[]>(), files = new Map<Key, Changed>(), branch = new Map<Key, BranchFact>();
  for (const it of items) {
    for (const b of facts.get(it.uid)!.branches) {
      branch.set(keyOf(it.uid, b.name), b);
      if (c.fixed.has(b.name) || b.unknown || !b.head || b.merged_gone) continue;
      const got = await c.gh.unlanded(c.tips[b.target!], b.head);
      if (!got) { b.unknown = `couldn't list its commits not in ${b.target} (or more than ${UNLANDED_CAP})`; continue; }
      const landed = await drift(c, b.target!);
      if (!landed) { b.unknown = `couldn't list the long-lived branches' commits not in ${b.target} (or more than ${UNLANDED_CAP})`; continue; }
      const carries = [...landed].filter(([, shas]) => got.shas.some((s) => shas.has(s))).map(([name]) => name);
      u.set(keyOf(it.uid, b.name), got.shas.filter((s) => ![...landed.values()].some((shas) => shas.has(s))));
      files.set(keyOf(it.uid, b.name), { files: got.files, carries });
    }
  }
  const chained = await chainEdges(c, items, facts, u, others, stored);
  const index = new Map<string, Key[]>();
  for (const [k, shas] of u) for (const s of shas) index.set(s, [...(index.get(s) ?? []), k]);
  const pairs = new Set<string>();
  for (const keys of index.values()) {
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const [x, y] = [keys[i], keys[j]].sort();
      if (x.split("\x1f")[0] !== y.split("\x1f")[0]) pairs.add(`${x}\x1e${y}`);
    }
  }
  const side = (k: Key): [ItemRow, BranchFact] => [byUid.get(k.split("\x1f")[0])!, branch.get(k)!];
  for (const p of pairs) {
    if (chained.has(p)) continue;
    const [xk, yk] = p.split("\x1e");
    const x = side(xk), y = side(yk);
    const ux = new Set(u.get(xk)), uy = new Set(u.get(yk));
    const rel = relate(x, y, ux, uy);
    if (!rel) {
      for (const [[pi, pb], [qi, qb], up, uq] of [[x, y, u.get(xk)!, uy], [y, x, u.get(yk)!, ux]] as const) {
        const common = up.filter((s) => uq.has(s));
        facts.get(pi.uid)!.shares.push({ id: qi.id, item: qi.uid, branch: qb.name, via: pb.name, shared: common.length,
                                         commits: common.slice(0, SHOWN_COMMITS).map((s) => s.slice(0, 7)), evidence: HINTS.shares });
      }
      continue;
    }
    const [[bi, bb], [ai, ab]] = rel;
    if (bi.status === "cancelled") continue;
    const ua = new Set(u.get(keyOf(ai.uid, ab.name)));
    const common = u.get(keyOf(bi.uid, bb.name))!.filter((s) => ua.has(s));
    const [state, why] = await resolve(c, ai, ab, c.tips[bb.target!], common[0]);
    addPair(facts, bi, ai, commitEdge(ai, ab, bb, state, why, common));
  }
  await carry(c, items, facts, stored, new Set([...pairs, ...chained]), u);
  return files;
}

/** Previous git edges and shares this compute didn't find again: unknown when a side couldn't be read, landed once the shared commits reached the dependent's target. */
async function carry(c: Ctx | null, items: ItemRow[], facts: Map<string, Facts>, stored: Map<string, GitFacts>, related: Set<string>,
                     u: Map<Key, string[]> = new Map(), failure?: string) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const branch = new Map<Key, BranchFact>();
  for (const [uid, fx] of facts) for (const b of fx.branches) branch.set(keyOf(uid, b.name), b);
  for (const it of items) {
    if (it.status === "cancelled") continue;
    const old = stored.get(it.uid) ?? {};
    for (const e of old.needs ?? []) {
      const dep = e.source === "git" && e.id ? byId.get(e.id) : undefined;
      if (!dep) continue;
      const me = keyOf(it.uid, e.via ?? ""), other = keyOf(dep.uid, e.branch ?? "");
      if (!branch.has(me) || !branch.has(other) || related.has([me, other].sort().join("\x1e"))) continue;
      const why = failure ?? branch.get(me)!.unknown ?? branch.get(other)!.unknown;
      if (why || !c) { addPair(facts, it, dep, { ...e, state: "unknown", reason: why ?? "not checked" }); continue; }
      const target = branch.get(me)!.target!, tip = c.tips[target], dependency = branch.get(other)!;
      if (!dependency.merged_gone && e.mb && u.get(me)?.includes(e.mb)) {
        await rewritten(c, facts, it, dep, e, dependency, branch.get(me)!, target, tip);
        continue;
      }
      const landed = !tip ? false : dependency.merged_gone ? await c.gh.contains(tip, dependency.landed!)
        : e.mb ? await c.gh.contains(tip, e.mb) : false;
      if (landed === null) addPair(facts, it, dep, { ...e, state: "unknown", reason: "couldn't check its shared commits" });
      else if (landed) addPair(facts, it, dep, { ...e, state: "landed", target: branch.get(me)!.target, evidence: `the shared commits are in ${branch.get(me)!.target}` });
    }
    for (const s of old.shares ?? []) {
      const other = byId.get(s.id);
      if (!other) continue;
      const me = keyOf(it.uid, s.via), them = keyOf(other.uid, s.branch);
      if (!branch.has(me) || !branch.has(them) || related.has([me, them].sort().join("\x1e"))) continue;
      if (s.rewritten) {
        if (c && s.mb && u.get(me)?.includes(s.mb) && !(await mergedIn(c, s.landing, branch.get(me)!))) facts.get(it.uid)!.shares.push(s);
        continue;
      }
      const why = failure ?? branch.get(me)!.unknown ?? branch.get(them)!.unknown;
      if (why) facts.get(it.uid)!.shares.push({ ...s, state: "unknown", reason: why });
    }
  }
}

/** B still carries commits A dropped when it was rewritten: B waits until A's current work reaches T(B), then keeps a
 * hint to merge it in until B holds the commit that carried it. */
async function rewritten(c: Ctx, facts: Map<string, Facts>, b: ItemRow, a: ItemRow, e: Edge, ab: BranchFact, bb: BranchFact, target: string,
                         tip: string | undefined) {
  const mb = e.mb!, old = `${e.via} still carries its old commits (${mb.slice(0, 7)})`;
  const [got, why, landing] = tip ? await reached(c, a, ab, tip, target) : [null, "T(B) isn't on the remote", null] as const;
  if (got) {
    if (await mergedIn(c, landing, bb)) return;
    facts.get(b.uid)!.shares.push({ id: a.id, item: a.uid, branch: e.branch ?? ab.name, via: e.via ?? "", shared: 1, commits: [mb.slice(0, 7)], mb,
                                    rewritten: true, landing,
                                    evidence: `${e.branch} was rewritten and has landed in ${target}, but ${old}: merge ${target} into ${e.via}` });
  } else if (got === null) {
    addPair(facts, b, a, { ...e, state: "unknown", reason: why, target });
  } else {
    addPair(facts, b, a, { ...e, state: "waiting", target, evidence: `${e.branch} was rewritten, and ${old}` });
  }
}

async function noteEdges(c: Ctx, it: ItemRow, notes: Row[], items: ItemRow[], all: ItemRow[], facts: Map<string, Facts>,
                         stored: Map<string, GitFacts>, f: Fetch) {
  const out: { dep: ItemRow | null; depBranch: BranchFact | null; e: Edge }[] = [];
  const own = facts.get(it.uid)!.branches;
  for (const n of notes) {
    const needs = String(n.meta?.needs ?? "").trim();
    const target = String(n.meta?.in ?? "").trim() || own[0]?.target || c.def;
    const tip = c.tips[target];
    const e: Edge = { needs, target, source: "plugin", note: n.uid, state: "waiting",
                      evidence: String(n.meta?.because ?? "").trim() || String(n.text ?? "").trim() };
    let dep: ItemRow | null = null;
    let branches: BranchFact[] = [];
    if (needs.startsWith("item:")) {
      const ref = needs.slice(5);
      dep = all.find((x) => x.id === ref || x.uid === ref) ?? null;
      if (dep) branches = (facts.get(dep.uid) ?? stored.get(dep.uid))?.branches ?? [];
    } else if (needs.startsWith("branch:")) {
      const name = needs.slice(7);
      e.branch = name;
      dep = items.find((x) => itemBranches(x.extra).includes(name)) ?? null;
      if (dep) branches = facts.get(dep.uid)!.branches.filter((b) => b.name === name);
      else if (c.tips[name]) branches = [{ name, head: c.tips[name], landed: c.tips[name] }];
    } else if (/^https?:\/\//.test(needs)) {
      Object.assign(e, await prEdge(needs, n.meta?.in ? target : null, f, c.own));
      out.push({ dep: null, depBranch: null, e });
      continue;
    }
    if (dep) Object.assign(e, { id: dep.id, item: dep.uid });
    e.state = await noteState(c, dep, branches, tip);
    out.push({ dep, depBranch: branches.length === 1 ? branches[0] : null, e });
  }
  return out;
}

async function noteState(c: Ctx, dep: ItemRow | null, branches: BranchFact[], tip: string | undefined): Promise<EdgeState> {
  if (dep && CANT_LAND.includes(dep.status)) return "stale";
  if (dep && !itemBranches(dep.extra).length) return COMPLETE.includes(dep.status) ? "landed" : "waiting";
  if (!branches.length || !tip) return "waiting";
  const states = await Promise.all(branches.map((b) => b.landed ? c.gh.contains(tip, b.landed) : Promise.resolve(false)));
  if (states.some((s) => s === null)) return "unknown";
  return states.every(Boolean) ? "landed" : "waiting";
}

/** A dependency on a PR by URL, in any repo: landed once merged, and once its merge commit is in `into` when that's named.
 * Unknown when GitHub can't answer, and when todo has no token that reads the PR's repo: the project's own, or the server's for
 * an owner it reads. */
async function prEdge(url: string, into: string | null, f: Fetch, own: Ctx["own"]): Promise<Partial<Edge>> {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i);
  if (!m) return { state: "waiting" };
  const [, owner, name, number] = m;
  const token = own.given ? own.token : serverGithubToken(`${owner}/${name}`.toLowerCase());
  if (!token) {
    return { state: "unknown", reason: `todo has no GitHub token that reads ${owner}/${name}; give the project one on Settings → Automation` };
  }
  const raw = await get(`/repos/${owner}/${name}/pulls/${number}`, f, token).catch(() => null);
  if (!raw?.number) return { state: "unknown", reason: "GitHub didn't answer for the PR" };
  const pr = prFact(raw);
  if (pr.state === "closed") return { state: "stale", pr };
  if (pr.state !== "merged") return { state: "waiting", pr };
  if (!into || !pr.merge_commit) return { state: "landed", pr };
  const c = await get(`/repos/${owner}/${name}/compare/${pr.merge_commit}...${encodeURIComponent(into)}`, f, token).catch(() => null);
  if (!c?.status) return { state: "unknown", reason: `couldn't check PR #${pr.number} against ${into}`, pr };
  return { state: c.status === "ahead" || c.status === "identical" ? "landed" : "waiting", pr };
}

/** Files B changes against T(B); when it carries commits of a long-lived branch that T(B) lacks, only those it also changes
 * against that branch. */
async function changedFiles(c: Ctx, b: BranchFact, got: Changed): Promise<string[]> {
  let out = got.files;
  for (const name of got.carries) {
    const also = await c.gh.changed(c.tips[name], b.head!);
    if (!also) return [];
    out = out.filter((f) => also.includes(f));
  }
  return out;
}

/** Files both of two live, unrelated branches change: the overlap hint. */
async function overlaps(c: Ctx, items: ItemRow[], facts: Map<string, Facts>, changed: Map<Key, Changed>): Promise<void> {
  const related = new Set<string>();
  for (const it of items) {
    for (const e of [...facts.get(it.uid)!.needs, ...facts.get(it.uid)!.shares]) {
      const other = items.find((x) => x.id === e.id);
      if (other) related.add([keyOf(it.uid, e.via ?? ""), keyOf(other.uid, e.branch ?? "")].sort().join("\x1e"));
    }
  }
  const live: { it: ItemRow; b: BranchFact; files: Set<string> }[] = [];
  for (const it of items) {
    if (it.status === "cancelled") continue;
    for (const b of facts.get(it.uid)!.branches) {
      const got = changed.get(keyOf(it.uid, b.name));
      if (b.unknown || b.gone || !b.head || b.pr?.state === "merged" || b.pr?.state === "closed" || !got?.files.length) continue;
      const files = await changedFiles(c, b, got);
      if (files.length) live.push({ it, b, files: new Set(files) });
    }
  }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i], y = live[j];
      if (x.it === y.it || related.has([keyOf(x.it.uid, x.b.name), keyOf(y.it.uid, y.b.name)].sort().join("\x1e"))) continue;
      const common = [...x.files].filter((f) => y.files.has(f)).sort();
      if (!common.length) continue;
      facts.get(x.it.uid)!.overlaps.push({ id: y.it.id, item: y.it.uid, branch: y.b.name, via: x.b.name, files: common });
      facts.get(y.it.uid)!.overlaps.push({ id: x.it.id, item: x.it.uid, branch: x.b.name, via: y.b.name, files: common });
    }
  }
}

async function computeRepo(c: Ctx, items: ItemRow[], all: ItemRow[], stored: Map<string, GitFacts>, notes: Row[], others: Map<string, ItemRow>, f: Fetch) {
  const owners = new Map<string, string>();
  for (const it of items) if (it.status !== "cancelled") for (const b of itemBranches(it.extra)) if (!c.fixed.has(b)) owners.set(b, it.uid);
  const facts = new Map<string, Facts>();
  for (const it of items) {
    facts.set(it.uid, { repo: c.gh.key, branches: await branchFacts(c, it, stored.get(it.uid) ?? {}),
                        needs: [], needed_by: [], shares: [], overlaps: [] });
  }
  targets(c, facts, owners, others);
  const files = await relations(c, items, facts, stored, others);
  for (const it of items) {
    if (it.status === "cancelled") continue;
    for (const { dep, depBranch, e } of await noteEdges(c, it, notes.filter((n) => n.item_uid === it.uid), items, all, facts, stored, f)) {
      facts.get(it.uid)!.needs.push(e);
      if (dep && facts.has(dep.uid)) {
        facts.get(dep.uid)!.needed_by.push({ ...e, id: it.id, item: it.uid, branch: itemBranches(it.extra)[0] ?? null, via: depBranch?.name ?? null });
      }
    }
  }
  await overlaps(c, items, facts, files);
  cycles(items, facts);
  for (const fx of facts.values()) fx.waits_on = waitsOn(fx.needs);
  return facts;
}

const and = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Label the unresolved edges that make items wait on each other in a ring. */
function cycles(items: ItemRow[], facts: Map<string, Facts>): void {
  const byId = new Map(items.map((it) => [it.id, it.uid]));
  const graph = new Map<string, string[]>();
  for (const it of items) {
    graph.set(it.id, [...new Set(facts.get(it.uid)!.needs.filter((e) => e.id && byId.has(e.id) && e.id !== it.id && UNRESOLVED.includes(e.state)).map((e) => e.id!))]);
  }
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), rings: string[][] = [];
  let n = 0;
  const visit = (v: string) => {
    index.set(v, n); low.set(v, n); n++;
    stack.push(v); on.add(v);
    for (const w of graph.get(v)!) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const ring: string[] = [];
      for (let w = ""; w !== v;) { w = stack.pop()!; on.delete(w); ring.push(w); }
      if (ring.length > 1) rings.push(ring.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  for (const ring of rings) {
    const inRing = (e: Edge) => !!e.id && ring.includes(e.id) && UNRESOLVED.includes(e.state);
    const edges = ring.flatMap((id) => facts.get(byId.get(id)!)!.needs.filter(inRing));
    const text = `${and(ring)} wait on each other through ${and(edges.map((e) => `${e.branch}←${e.via}`))}: merge them in one order, or split the items`;
    for (const id of ring) for (const e of [...facts.get(byId.get(id)!)!.needs, ...facts.get(byId.get(id)!)!.needed_by]) if (inRing(e)) e.cycle = text;
  }
}

const waitsOn = (needs: Edge[]) => [...new Set(needs.filter((e) => UNRESOLVED.includes(e.state)).map((e) => e.id ?? e.needs ?? "?"))].sort();

/** The stored facts with every edge marked unknown, for a compute that couldn't finish. */
function failed(old: GitFacts, why: string): GitFacts {
  const mark = <T extends { state?: string }>(xs: T[] | undefined) => (xs ?? []).map((x) => (x.state === "landed" || x.state === undefined || UNRESOLVED.includes(x.state) ? { ...x, state: "unknown" as const, reason: why } : x));
  const needs = mark(old.needs) as Edge[];
  return { ...old, needs, needed_by: mark(old.needed_by) as Edge[], shares: mark(old.shares) as Share[], waits_on: waitsOn(needs), error: why };
}

/** Recompute every item's facts in the project from GitHub, keeping the CLI's conflicts; with `only`, just that repo's.
 * A repo the project may not use is never read. */
export async function computeProject(d: Db, project: string, fetchImpl: Fetch = fetch, only?: string): Promise<void> {
  const own = await pageGithub(d, project);
  const everything = await d.query<ItemRow>("select uid, id, status, extra from items where project = $1 order by created, id", [project]);
  const all = everything.filter((it) => !it.extra?.archived);
  const stored = new Map<string, GitFacts>((await d.query("select item_uid, data from git_facts where project = $1", [project]))
    .map((r) => [r.item_uid, r.data ?? {}]));
  const notes = await d.query("select uid, item_uid, text, meta from notes where project = $1 and kind = 'dependency' order by n", [project]);
  const groups = new Map<string, ItemRow[]>();
  for (const it of all) {
    const key = repoKey(it.extra?.repo);
    if (key) groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  for (const [key, items] of groups) {
    if (only !== undefined && key !== only) continue;
    if (!(await repoAllowed(d, project, key))) continue;
    if (!items.some((it) => itemBranches(it.extra).length || stored.has(it.uid) || notes.some((n) => n.item_uid === it.uid))) continue;
    const auth = await githubToken(d, project, key);
    if (!auth) continue;
    const [owner, name] = key.split("/");
    const gh = new GitHubRepo(owner, name, fetchImpl, auth.token);
    let facts: Map<string, Facts>;
    try {
      const [def, tips] = await Promise.all([gh.defaultBranch(), gh.tips()]);
      const track = await deployBranches(d, project, key);
      const sig = signature(items, notes, stored, tips, def, track);
      if (signatures.get(`${project}\x1f${key}`) === sig) continue;
      const last = trackedTips.get(`${project}\x1f${key}`);
      const moved = track.filter((t) => tips[t] && (!last || last[t] !== tips[t]));
      const closed = new Map<string, PrFact[]>();
      for (const t of moved) for (const [ref, prs] of await gh.closedInto(t)) closed.set(ref, [...(closed.get(ref) ?? []), ...prs]);
      const fixed = new Set([...track, def]);
      const others = new Map<string, ItemRow>();
      for (const it of everything) {
        if (repoKey(it.extra?.repo) !== key || (it.status !== "cancelled" && !it.extra?.archived)) continue;
        for (const b of itemBranches(it.extra)) if (!fixed.has(b)) others.set(b, it);
      }
      facts = await computeRepo({ gh, tips, def, track, fixed, closed, covered: new Set(moved), refetchOpen: moved.length > 0, own },
                                items, all, stored, notes, others, fetchImpl);
      signatures.set(`${project}\x1f${key}`, sig);
      trackedTips.set(`${project}\x1f${key}`, Object.fromEntries(track.map((t) => [t, tips[t]])));
    } catch (e) {
      const why = `GitHub: ${e instanceof Error ? e.message : String(e)}`;
      for (const it of items) if (stored.has(it.uid)) await saveFacts(d, project, it.uid, failed(stored.get(it.uid)!, why), "server");
      continue;
    }
    for (const it of items) {
      const prev = stored.get(it.uid) ?? {};
      const fx = facts.get(it.uid)!;
      if (!fx.branches.length && !fx.needs.length && !fx.needed_by.length && !prev.conflicts?.length) {
        await d.query("delete from git_facts where project = $1 and item_uid = $2", [project, it.uid]);
        continue;
      }
      await saveFacts(d, project, it.uid, { ...fx, conflicts: prev.conflicts ?? [], ...(prev.conflicts_by ? { conflicts_by: prev.conflicts_by } : {}),
                                            ...(prev.notice ? { notice: prev.notice } : {}), at: new Date().toISOString() }, "server");
    }
  }
}

/** What a compute depends on: the tips of the branches that matter, the items' statuses and branches, and their dependency notes. */
function signature(items: ItemRow[], notes: Row[], stored: Map<string, GitFacts>, tips: Record<string, string>, def: string, track: string[]): string {
  const names = new Set<string>([def, ...track]);
  for (const it of items) {
    for (const b of itemBranches(it.extra)) names.add(b);
    for (const n of notes) if (n.item_uid === it.uid && String(n.meta?.needs ?? "").startsWith("branch:")) names.add(String(n.meta.needs).slice(7));
    for (const b of stored.get(it.uid)?.branches ?? []) {
      for (const n of [b.target, b.pr?.base, ...(b.chain ?? []), ...Object.keys(b.in ?? {})]) if (n) names.add(n);
    }
  }
  return JSON.stringify({
    def, tips: [...names].sort().map((n) => [n, tips[n] ?? null]),
    items: items.map((it) => [it.uid, it.status, itemBranches(it.extra), stored.has(it.uid)]),
    notes: notes.filter((n) => items.some((it) => it.uid === n.item_uid)).map((n) => [n.uid, n.item_uid, n.meta?.needs, n.meta?.in]),
  });
}

async function saveFacts(d: Db, project: string, itemUid: string, data: GitFacts, by: string, at = "now()"): Promise<void> {
  await d.query(
    `insert into git_facts (project, item_uid, data, computed_by, at) values ($1, $2, $3::jsonb, $4, ${at})
     on conflict (project, item_uid) do update set data = excluded.data, computed_by = excluded.computed_by, at = excluded.at`,
    [project, itemUid, JSON.stringify(data), by]);
}

// ── posted facts ──────────────────────────────────────────────────────────────
const TOP_KEYS = new Set(["repo", "branches", "needs", "needed_by", "shares", "conflicts", "overlaps", "waits_on", "notice", "at"]);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
const listOf = (v: unknown, ok: (x: Record<string, any>) => boolean) => v === undefined || (Array.isArray(v) && v.every((x) => isObj(x) && ok(x)));

/** Whether a posted facts object has the shape the CLI writes. */
export function validFacts(data: unknown): data is GitFacts {
  if (!isObj(data) || Object.keys(data).some((k) => !TOP_KEYS.has(k))) return false;
  const hint = (x: Record<string, any>) => typeof x.id === "string" && typeof x.branch === "string" && strs(x.files);
  return listOf(data.branches, (b) => typeof b.name === "string" && (b.in === undefined || isObj(b.in)))
    && listOf(data.needs, (e) => EDGE_STATES.includes(e.state)) && listOf(data.needed_by, (e) => EDGE_STATES.includes(e.state))
    && listOf(data.shares, (s) => typeof s.id === "string" && typeof s.branch === "string")
    && listOf(data.conflicts, hint) && listOf(data.overlaps, hint)
    && (data.waits_on === undefined || strs(data.waits_on))
    && ["repo", "notice", "at"].every((k) => data[k] === undefined || typeof data[k] === "string");
}

export class BadFacts extends Error {}

/** Store facts a CLI computed, for the project's own items. Where todo has a GitHub token for the item's repo the server
 * computes the rest itself and keeps only the CLI's conflicts; elsewhere it keeps them whole. */
export async function recordFacts(d: Db, project: string, handle: string, facts: unknown[]): Promise<{ stored: number; skipped: string[] }> {
  if (!facts.every((f) => isObj(f) && typeof f.item_uid === "string" && validFacts(f.data))) throw new BadFacts("malformed git facts");
  const skipped: string[] = [];
  let stored = 0;
  let computed = false;
  for (const { item_uid, data } of facts as { item_uid: string; data: GitFacts }[]) {
    const [hit] = await d.query("select extra from items where project = $1 and uid = $2", [project, item_uid]);
    if (!hit) { skipped.push(item_uid); continue; }
    const repo = repoKey(hit.extra?.repo);
    const own = !!repo && !!(await githubToken(d, project, repo));
    computed ||= own;
    if (own) {
      const prev = await storedFacts(d, project, item_uid);
      const [row] = await d.query("select 1 from git_facts where project = $1 and item_uid = $2", [project, item_uid]);
      await saveFacts(d, project, item_uid, { ...prev, conflicts: data.conflicts ?? [], conflicts_by: handle,
                                              ...(data.notice ? { notice: data.notice } : {}) }, "server",
                      row ? "coalesce((select at from git_facts where project = $1 and item_uid = $2), now())" : "'epoch'");
    } else {
      await saveFacts(d, project, item_uid, data, handle);
    }
    stored += 1;
  }
  if (computed) scheduleRecompute(d, project);
  return { stored, skipped };
}

// ── reading facts ─────────────────────────────────────────────────────────────
export async function storedFacts(d: Db, project: string, itemUid: string): Promise<GitFacts> {
  const [row] = await d.query("select data from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  return row?.data ?? {};
}

/** Recompute the project (or one repo of it) after the response, one compute at a time for each. */
export function scheduleRecompute(d: Db, project: string, fetchImpl: Fetch = fetch, repo?: string): Promise<void> {
  const key = repo === undefined ? project : `${project}\x1f${repo}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = computeProject(d, project, fetchImpl, repo).catch(() => undefined).finally(() => inflight.delete(key));
  inflight.set(key, run);
  later(() => run);
  return run;
}

/** The compute running for a project, if any. */
export function recomputing(project: string): Promise<void> | undefined {
  return inflight.get(project);
}

/** An item's stored facts for its page, with the hint texts. A row older than a couple of minutes schedules a recompute; the page never waits for it. */
export async function itemGitFacts(d: Db, project: string, itemUid: string, fetchImpl: Fetch = fetch):
    Promise<GitFacts & { hints: typeof HINTS; blocked?: string }> {
  const [it] = await d.query("select extra from items where project = $1 and uid = $2", [project, itemUid]);
  const blocked = await repoRefusal(d, project, it?.extra?.repo);
  if (blocked) return { hints: HINTS, blocked };
  const [row] = await d.query("select data, extract(epoch from now() - at) * 1000 as age from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  const repo = repoKey(it?.extra?.repo);
  if ((!row || Number(row.age) >= STALE_MS) && repo && (await githubToken(d, project, repo))) void scheduleRecompute(d, project, fetchImpl);
  return { ...(await withTitles(d, project, row?.data ?? {})), hints: HINTS };
}

/** The other items' titles on each conflict and overlap, for showing them by name. */
async function withTitles(d: Db, project: string, facts: GitFacts): Promise<GitFacts> {
  const hints = [...(facts.conflicts ?? []), ...(facts.overlaps ?? [])];
  const uids = [...new Set(hints.map((h) => h.item).filter((u): u is string => !!u))];
  if (!uids.length) return facts;
  const rows = await d.query("select uid, title from items where project = $1 and uid = any($2)", [project, uids]);
  const title = new Map<string, string>(rows.map((r) => [String(r.uid), String(r.title)]));
  const named = (hs?: Hint[]) => hs?.map((h) => (h.item && title.has(h.item) ? { ...h, title: title.get(h.item) } : h));
  return { ...facts, conflicts: named(facts.conflicts), overlaps: named(facts.overlaps) };
}

/** Recompute every project whose items list branches in a repo todo has a GitHub token for, for a cron tick. */
export async function recomputeAll(d: Db, fetchImpl: Fetch = fetch): Promise<string[]> {
  if (!(await anyGithubToken(d))) return [];
  const rows = await d.query(
    `select project, extra->>'repo' as repo from items where jsonb_array_length(coalesce(extra->'branches', '[]'::jsonb)) > 0
      group by 1, 2 order by 1, 2`);
  const due: string[] = [];
  for (const r of rows) {
    const repo = repoKey(r.repo);
    if (due.includes(r.project) || !repo || !(await githubToken(d, r.project, repo))) continue;
    due.push(r.project);
  }
  for (const project of due) await scheduleRecompute(d, project, fetchImpl);
  return due;
}

export function describeEdge(e: Edge): string {
  return `${e.id ?? e.needs ?? "?"}${e.branch ? ` (${e.branch})` : ""} ${e.state}`;
}

/** For a stage the guard refused: the edges it saw and when its facts were computed. It schedules a
 * recheck of the item's repo, since a CLI may have seen the dependency land first. */
export async function refusal(d: Pick<Db, "query">, project: string, itemUid: string): Promise<{ edges: string[]; facts_at: string | null }> {
  const [row] = await d.query("select at from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  const edges = (await unresolvedEdges(d, project, itemUid)).map(describeEdge);
  later(async () => {
    const fresh = await appDb();
    const [it] = await fresh.query("select extra from items where project = $1 and uid = $2", [project, itemUid]);
    signatures.delete(`${project}\x1f${repoKey(it?.extra?.repo)}`);
    await scheduleRecompute(fresh, project);
  });
  return { edges, facts_at: row?.at ? new Date(row.at).toISOString() : null };
}

/** What stops the item staging: waiting, stale or unknown edges, its own branches that couldn't be read, and dependency notes not checked yet. */
export async function unresolvedEdges(d: Pick<Db, "query">, project: string, itemUid: string): Promise<Edge[]> {
  const [row] = await d.query("select data from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  const data: GitFacts = isObj(row?.data) ? row.data : {};
  const needs: Edge[] = Array.isArray(data.needs) ? data.needs : [];
  const checked = new Set(needs.map((e) => e.note).filter(Boolean));
  const notes = await d.query("select uid, text, meta from notes where project = $1 and item_uid = $2 and kind = 'dependency'", [project, itemUid]);
  return [
    ...needs.filter((e) => UNRESOLVED.includes(e.state)),
    ...(Array.isArray(data.branches) ? data.branches : []).filter((b) => b.unknown)
      .map((b): Edge => ({ needs: b.name, state: "unknown", source: "git", reason: b.unknown })),
    ...notes.filter((n) => !checked.has(n.uid)).map((n): Edge => ({
      needs: n.meta?.needs, state: "unknown", source: "plugin", note: n.uid, reason: "not checked yet", evidence: n.meta?.because ?? n.text })),
  ];
}
