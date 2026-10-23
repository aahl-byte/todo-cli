// Git facts: where each item's branches landed, which in-flight branches depend
// on others, and which overlap. The server computes them through GitHub's API
// (GITHUB_TOKEN) and stores them per item in git_facts, keeping the conflicts
// the CLI reports, since those need a checkout. Facts are never set by hand.
// See docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §2.
import type { Db, Row } from "./db";
import { repoKey } from "./checkouts";
import { itemBranches } from "./model";

export type Fetch = typeof fetch;
export type EdgeState = "waiting" | "landed" | "stale";
export interface PrFact { number: number; state: "draft" | "open" | "merged" | "closed"; base: string | null; merge_commit?: string; url?: string }
export interface BranchFact { name: string; head?: string; gone?: boolean; pr?: PrFact; target: string; landed?: string; in?: Record<string, boolean> }
/** `id`/`item` name the other item; `branch` is its branch and `via` this item's. A plugin edge also carries `needs`. */
export interface Edge {
  id?: string; item?: string; branch?: string | null; via?: string | null; target?: string; state: EdgeState;
  source: "git" | "plugin"; evidence?: string; needs?: string; note?: string; shared?: number; commits?: string[];
}
export interface Hint { id: string; item?: string; branch: string; via: string; files: string[] }
export interface GitFacts {
  repo?: string; branches?: BranchFact[]; needs?: Edge[]; needed_by?: Edge[]; conflicts?: Hint[]; overlaps?: Hint[];
  waits_on?: string[]; notice?: string; at?: string;
}

export const GUARDED = ["ready-to-deploy", "deployed"];
export const UNRESOLVED: string[] = ["waiting", "stale"];
const CANT_LAND = ["cancelled", "deferred"];
const API = "https://api.github.com";
const PLUGINS_FILE = ".todo-plugins/plugins.yaml";
const TIMEOUT_MS = 5_000;
const FRESH_MS = 2 * 60_000;
const CACHE_LIMIT = 5_000;
const SHOWN_COMMITS = 3;

// ── GitHub, cached: by commit pair for compares, briefly for everything else ──
const cache = new Map<string, { at: number; ttl: number; value: Promise<any> }>();
const computed = new Map<string, { at: number; value: Promise<void> }>();

export function resetGitFactsCache(): void {
  cache.clear();
  computed.clear();
}

/** A GitHub GET; null on 404. */
function gh(path: string, fetchImpl: Fetch, ttl = FRESH_MS): Promise<any> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (cache.size > CACHE_LIMIT) cache.clear();
  const entry = { at: Date.now(), ttl, value: Promise.resolve<any>(null) };
  entry.value = (async () => {
    const token = process.env.GITHUB_TOKEN;
    const res = await fetchImpl(API + path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (res.status === 404) {
      entry.ttl = Math.min(ttl, FRESH_MS);
      return null;
    }
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    return res.json();
  })();
  entry.value.catch(() => cache.delete(path));
  cache.set(path, entry);
  return entry.value;
}

const segments = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/** The `track:` list of a plugins file, flow (`[a, b]`) or block style. */
export function trackList(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^track\s*:/.test(l));
  if (at < 0) return [];
  const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");
  const rest = lines[at].replace(/^track\s*:\s*/, "").replace(/\s+#.*$/, "").trim();
  if (rest.startsWith("[")) return rest.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  if (rest) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
    if (m) out.push(unquote(m[1]));
    else if (l.trim() && !l.trim().startsWith("#")) break;
  }
  return out;
}

function prFact(pr: any): PrFact {
  const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  return { number: pr.number, state, base: pr.base?.ref ?? null, url: pr.html_url,
           ...(state === "merged" && pr.merge_commit_sha ? { merge_commit: pr.merge_commit_sha } : {}) };
}

class GitHubRepo {
  private heads = new Map<string, Promise<string | null>>();
  constructor(readonly owner: string, readonly name: string, private f: Fetch) {}
  private get base() { return `/repos/${this.owner}/${this.name}`; }

  async defaultBranch(): Promise<string> {
    return (await gh(this.base, this.f))?.default_branch ?? "main";
  }
  async track(branch: string): Promise<string[]> {
    const file = await gh(`${this.base}/contents/${PLUGINS_FILE}?ref=${encodeURIComponent(branch)}`, this.f);
    return file?.content ? trackList(Buffer.from(file.content, "base64").toString("utf8")) : [];
  }
  /** A branch's head commit, or null once it is deleted. */
  head(branch: string): Promise<string | null> {
    if (!this.heads.has(branch)) {
      this.heads.set(branch, gh(`${this.base}/branches/${segments(branch)}`, this.f).then((b) => b?.commit?.sha ?? null));
    }
    return this.heads.get(branch)!;
  }
  /** The branch's PR (an open one first, else the newest); null with none; undefined when GitHub can't tell. */
  async pr(branch: string): Promise<PrFact | null | undefined> {
    try {
      const rows = await gh(`${this.base}/pulls?head=${encodeURIComponent(`${this.owner}:${branch}`)}&state=all&per_page=20`, this.f);
      if (!Array.isArray(rows)) return undefined;
      return rows.length ? prFact(rows.find((r) => r.state === "open") ?? rows[0]) : null;
    } catch {
      return undefined;
    }
  }
  compare(base: string, head: string): Promise<any> {
    return gh(`${this.base}/compare/${base}...${head}`, this.f, Infinity).catch(() => null);
  }
  /** Whether `sha` is an ancestor of `tip`; null when GitHub can't tell. */
  async contains(tip: string, sha: string): Promise<boolean | null> {
    const c = await this.compare(sha, tip);
    return c ? c.status === "ahead" || c.status === "identical" : null;
  }
}

// ── computing ─────────────────────────────────────────────────────────────────
interface ItemRow { uid: string; id: string; status: string; extra: Row | null }
type Facts = Required<Pick<GitFacts, "repo" | "branches" | "needs" | "needed_by" | "overlaps">> & GitFacts;

async function edgeState(gh: GitHubRepo, dep: ItemRow, b: BranchFact, tip: string | null): Promise<[EdgeState, string]> {
  if (tip && b.landed && (await gh.contains(tip, b.landed))) return ["landed", ""];
  if (CANT_LAND.includes(dep.status)) return ["stale", `${dep.id} is ${dep.status}`];
  if (b.pr?.state === "closed") return ["stale", `its PR #${b.pr.number} closed unmerged`];
  return ["waiting", ""];
}

async function branchFacts(gh: GitHubRepo, it: ItemRow, old: GitFacts, def: string, track: string[]): Promise<BranchFact[]> {
  const before = new Map((old.branches ?? []).map((b) => [b.name, b]));
  const out: BranchFact[] = [];
  for (const name of itemBranches(it.extra)) {
    const o = before.get(name);
    const live = await gh.head(name);
    const head = live ?? o?.head;
    let pr = o?.pr;
    if (pr?.state !== "merged") {
      const got = await gh.pr(name);
      if (got !== undefined) pr = got ?? undefined;
    }
    const b: BranchFact = { name, ...(head ? { head } : {}), ...(live ? {} : { gone: true }), ...(pr ? { pr } : {}), target: pr?.base ?? def };
    const landed = pr?.merge_commit ?? head;
    if (landed) {
      b.landed = landed;
      if (track.length) {
        b.in = {};
        for (const t of track) {
          const tip = await gh.head(t);
          if (tip) b.in[t] = !!(await gh.contains(tip, landed));
        }
      }
    }
    out.push(b);
  }
  return out;
}

async function gitEdges(gh: GitHubRepo, items: ItemRow[], facts: Map<string, Facts>) {
  const edges: { b: ItemRow; bb: BranchFact; a: ItemRow; ab: BranchFact; e: Edge }[] = [];
  for (const b of items) {
    if (b.status === "cancelled") continue;
    for (const bb of facts.get(b.uid)!.branches) {
      const tip = await gh.head(bb.target);
      if (!bb.head || !tip) continue;
      for (const a of items) {
        if (a === b) continue;
        for (const ab of facts.get(a.uid)!.branches) {
          if (!ab.head || ab.name === bb.name) continue;
          const mb: string | undefined = (await gh.compare(ab.head, bb.head))?.merge_base_commit?.sha;
          if (!mb || mb === bb.head || (await gh.contains(tip, mb)) !== false) continue;
          const [state, why] = await edgeState(gh, a, ab, tip);
          const shared = await gh.compare(tip, mb);
          const n: number = shared?.ahead_by ?? 0;
          const commits: string[] = (shared?.commits ?? []).slice(-SHOWN_COMMITS).reverse().map((c: any) => String(c.sha).slice(0, 7));
          const evidence = state === "landed" ? `${ab.name} landed in ${bb.target} (${ab.landed!.slice(0, 7)})`
            : why || `${bb.name} carries ${n} commit${n === 1 ? "" : "s"} of ${ab.name} not in ${bb.target}: ${commits.join(", ")}`;
          edges.push({ b, bb, a, ab, e: { id: a.id, item: a.uid, branch: ab.name, via: bb.name, target: bb.target, state,
                                          source: "git", evidence, shared: n, commits } });
        }
      }
    }
  }
  const pairs = new Set(edges.map(({ b, bb, a, ab }) => `${b.uid}\x1f${bb.name}\x1f${a.uid}\x1f${ab.name}`));
  // Both carry the other's commits: a PR based on the other branch says which way it runs.
  return edges.filter(({ b, bb, a, ab }) => !(pairs.has(`${a.uid}\x1f${ab.name}\x1f${b.uid}\x1f${bb.name}`)
    && ab.pr?.base === bb.name && bb.pr?.base !== ab.name));
}

async function noteEdges(gh: GitHubRepo, it: ItemRow, notes: Row[], items: ItemRow[], all: ItemRow[], facts: Map<string, Facts>,
                         stored: Map<string, GitFacts>, def: string, f: Fetch) {
  const out: { dep: ItemRow | null; depBranch: BranchFact | null; e: Edge }[] = [];
  const own = facts.get(it.uid)!.branches;
  for (const n of notes) {
    const needs = String(n.meta?.needs ?? "").trim();
    const target = String(n.meta?.in ?? "").trim() || own[0]?.target || def;
    const tip = await gh.head(target);
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
      else {
        const head = await gh.head(name);
        if (head) branches = [{ name, head, landed: head, target }];
      }
    } else if (/^https?:\/\//.test(needs)) {
      Object.assign(e, await prEdge(needs, n.meta?.in ? target : null, f));
      out.push({ dep: null, depBranch: null, e });
      continue;
    }
    if (dep) Object.assign(e, { id: dep.id, item: dep.uid });
    const states = await Promise.all(branches.map(async (b) => dep ? (await edgeState(gh, dep, b, tip))[0]
      : tip && b.landed && (await gh.contains(tip, b.landed)) ? "landed" : "waiting"));
    e.state = !states.length ? (dep && CANT_LAND.includes(dep.status) ? "stale" : "waiting")
      : states.every((s) => s === "landed") ? "landed" : states.includes("stale") ? "stale" : "waiting";
    out.push({ dep, depBranch: branches.length === 1 ? branches[0] : null, e });
  }
  return out;
}

/** A dependency on a PR by URL: landed once merged (into `into`, when named). */
async function prEdge(url: string, into: string | null, f: Fetch): Promise<Partial<Edge>> {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i);
  if (!m) return { state: "waiting" };
  const repo = new GitHubRepo(m[1], m[2], f);
  const raw = await gh(`/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, f).catch(() => null);
  if (!raw) return { state: "waiting" };
  const pr = prFact(raw);
  if (pr.state === "closed") return { state: "stale" };
  if (pr.state !== "merged") return { state: "waiting" };
  if (!into || !pr.merge_commit) return { state: "landed" };
  const tip = await repo.head(into);
  return { state: tip && (await repo.contains(tip, pr.merge_commit)) ? "landed" : "waiting" };
}

async function overlaps(gh: GitHubRepo, items: ItemRow[], facts: Map<string, Facts>): Promise<void> {
  const live = items.filter((it) => it.status !== "cancelled").flatMap((it) => facts.get(it.uid)!.branches
    .filter((b) => b.head && !b.gone && b.pr?.state !== "merged" && b.pr?.state !== "closed").map((b) => ({ it, b })));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i], y = live[j];
      if (x.it === y.it) continue;
      const [ofY, ofX] = await Promise.all([gh.compare(x.b.head!, y.b.head!), gh.compare(y.b.head!, x.b.head!)]);
      const files = (c: any) => new Set<string>((c?.files ?? []).map((f: any) => f.filename));
      const inX = files(ofX);
      const common = [...files(ofY)].filter((f) => inX.has(f)).sort();
      if (!common.length) continue;
      facts.get(x.it.uid)!.overlaps.push({ id: y.it.id, item: y.it.uid, branch: y.b.name, via: x.b.name, files: common });
      facts.get(y.it.uid)!.overlaps.push({ id: x.it.id, item: x.it.uid, branch: x.b.name, via: y.b.name, files: common });
    }
  }
}

async function computeRepo(key: string, items: ItemRow[], all: ItemRow[], stored: Map<string, GitFacts>, notes: Row[], f: Fetch) {
  const [owner, name] = key.split("/");
  const gh = new GitHubRepo(owner, name, f);
  const def = await gh.defaultBranch();
  const track = await gh.track(def);
  const facts = new Map<string, Facts>();
  for (const it of items) {
    facts.set(it.uid, { repo: key, branches: await branchFacts(gh, it, stored.get(it.uid) ?? {}, def, track),
                        needs: [], needed_by: [], overlaps: [] });
  }
  for (const { b, bb, a, ab, e } of await gitEdges(gh, items, facts)) {
    facts.get(b.uid)!.needs.push(e);
    facts.get(a.uid)!.needed_by.push({ ...e, id: b.id, item: b.uid, branch: bb.name, via: ab.name });
  }
  for (const it of items) {
    if (it.status === "cancelled") continue;
    const mine = notes.filter((n) => n.item_uid === it.uid);
    for (const { dep, depBranch, e } of await noteEdges(gh, it, mine, items, all, facts, stored, def, f)) {
      facts.get(it.uid)!.needs.push(e);
      if (dep && facts.has(dep.uid)) {
        facts.get(dep.uid)!.needed_by.push({ ...e, id: it.id, item: it.uid, branch: itemBranches(it.extra)[0] ?? null,
                                             via: depBranch?.name ?? null });
      }
    }
  }
  await overlaps(gh, items, facts);
  for (const fx of facts.values()) {
    fx.waits_on = [...new Set(fx.needs.filter((e) => UNRESOLVED.includes(e.state)).map((e) => e.id ?? e.needs ?? "?"))].sort();
  }
  return facts;
}

/** Recompute every item's facts in the project from GitHub, keeping the CLI's conflicts. */
export async function computeProject(d: Db, project: string, fetchImpl: Fetch = fetch): Promise<void> {
  const all = (await d.query<ItemRow>("select uid, id, status, extra from items where project = $1 order by created, id", [project]))
    .filter((it) => !it.extra?.archived);
  const stored = new Map<string, GitFacts>((await d.query("select item_uid, data from git_facts where project = $1", [project]))
    .map((r) => [r.item_uid, r.data ?? {}]));
  const notes = await d.query("select uid, item_uid, text, meta from notes where project = $1 and kind = 'dependency' order by n", [project]);
  const groups = new Map<string, ItemRow[]>();
  for (const it of all) {
    const key = repoKey(it.extra?.repo);
    if (key) groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  for (const [key, items] of groups) {
    if (!items.some((it) => itemBranches(it.extra).length || stored.has(it.uid) || notes.some((n) => n.item_uid === it.uid))) continue;
    const facts = await computeRepo(key, items, all, stored, notes, fetchImpl);
    for (const it of items) {
      const prev = stored.get(it.uid) ?? {};
      const fx = facts.get(it.uid)!;
      const empty = !fx.branches.length && !fx.needs.length && !fx.needed_by.length && !prev.conflicts?.length;
      if (empty) {
        await d.query("delete from git_facts where project = $1 and item_uid = $2", [project, it.uid]);
        continue;
      }
      const data: GitFacts = { ...fx, conflicts: prev.conflicts ?? [], ...(prev.notice ? { notice: prev.notice } : {}),
                               at: new Date().toISOString() };
      await saveFacts(d, project, it.uid, data, "server");
    }
  }
}

async function saveFacts(d: Db, project: string, itemUid: string, data: GitFacts, by: string): Promise<void> {
  await d.query(
    `insert into git_facts (project, item_uid, data, computed_by, at) values ($1, $2, $3::jsonb, $4, now())
     on conflict (project, item_uid) do update set data = excluded.data, computed_by = excluded.computed_by, at = excluded.at`,
    [project, itemUid, JSON.stringify(data), by]);
}

/** Store facts a CLI computed, for the project's own items; the number stored. */
export async function recordFacts(d: Db, project: string, handle: string, facts: unknown[]): Promise<number> {
  let n = 0;
  for (const f of facts as { item_uid?: unknown; data?: unknown }[]) {
    if (typeof f?.item_uid !== "string" || !f.data || typeof f.data !== "object" || Array.isArray(f.data)) continue;
    const [hit] = await d.query("select 1 from items where project = $1 and uid = $2", [project, f.item_uid]);
    if (!hit) continue;
    await saveFacts(d, project, f.item_uid, f.data as GitFacts, handle);
    n += 1;
  }
  return n;
}

export async function storedFacts(d: Db, project: string, itemUid: string): Promise<GitFacts> {
  const [row] = await d.query("select data from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  return row?.data ?? {};
}

/** An item's facts for its page: recomputed from GitHub at most every couple of minutes per project, when a token allows. */
export async function itemGitFacts(d: Db, project: string, itemUid: string, fetchImpl: Fetch = fetch): Promise<GitFacts> {
  if (process.env.GITHUB_TOKEN) {
    const hit = computed.get(project);
    if (!hit || Date.now() - hit.at >= FRESH_MS) {
      const value = computeProject(d, project, fetchImpl).catch(() => undefined);
      computed.set(project, { at: Date.now(), value });
    }
    await computed.get(project)!.value;
  }
  return storedFacts(d, project, itemUid);
}

/** The item's waiting or stale edges, plus any dependency note its facts haven't checked yet. */
export async function unresolvedEdges(d: Pick<Db, "query">, project: string, itemUid: string): Promise<Edge[]> {
  const [row] = await d.query("select data from git_facts where project = $1 and item_uid = $2", [project, itemUid]);
  const needs: Edge[] = Array.isArray(row?.data?.needs) ? row.data.needs : [];
  const checked = new Set(needs.map((e) => e.note).filter(Boolean));
  const notes = await d.query("select uid, text, meta from notes where project = $1 and item_uid = $2 and kind = 'dependency'", [project, itemUid]);
  return [
    ...needs.filter((e) => UNRESOLVED.includes(e.state)),
    ...notes.filter((n) => !checked.has(n.uid)).map((n): Edge => ({
      needs: n.meta?.needs, state: "waiting", source: "plugin", note: n.uid, evidence: n.meta?.because ?? n.text })),
  ];
}
