// Read models for the dashboard pages. Every entity carries its `versions`
// so actions can send the base they were rendered with.
import type { Db, Row } from "./db";
import { CHECK_KINDS, COMPLETE, PARKED, PAST_TRIAGE, deriveCalcStatus } from "./model";
import { matchEntries, matches, type Entry } from "./filters";

export interface Project {
  key: string;
  name: string;
  deploy_step: boolean;
  seq: number;
}

export async function projects(d: Db): Promise<Project[]> {
  const rows = await d.query("select key, name, deploy_step, seq from projects order by key");
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }) as Project);
}

export async function project(d: Db, key: string): Promise<Project | null> {
  const [r] = await d.query("select key, name, deploy_step, seq from projects where key = $1", [key]);
  return r ? ({ ...r, seq: Number(r.seq) } as Project) : null;
}

export async function users(d: Db): Promise<{ handle: string; name: string | null }[]> {
  return d.query("select handle, name from users order by handle") as any;
}

export interface Card extends Row {
  uid: string;
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string | null;
  creator: string | null;
  developer: string | null;
  qa_assignee: string | null;
  created: string;
  completed: string | null;
  super_phase: number | null;
  versions: Record<string, number>;
  task_statuses: string[];
  task_phases: number[];
  open_questions: number;
  pending_pre: number;
  pending_post: number;
  jira_key: string | null;
  last_via: string | null;
  last_to: string | null;
  request_meta: { version: number; triaged: boolean } | null;
  extra: Record<string, any> | null;
}

async function cards(d: Db, key: string, where = "", params: unknown[] = []): Promise<Card[]> {
  const rows = await d.query(
    `select i.*, l.jira_key,
       coalesce((select array_agg(t.status order by t.phase nulls last, t.position, t.n) from tasks t where t.item_uid = i.uid and t.project = i.project), '{}') as task_statuses,
       coalesce((select array_agg(coalesce(t.phase, -1) order by t.phase nulls last, t.position, t.n) from tasks t where t.item_uid = i.uid and t.project = i.project), '{}') as task_phases,
       (select count(*)::int from notes n where n.item_uid = i.uid and n.project = i.project and n.kind = 'clarification' and coalesce(n.meta->>'state', 'open') <> 'answered') as open_questions,
       (select count(*)::int from checks c where c.item_uid = i.uid and c.project = i.project and c.timing = 'pre-deploy' and c.status <> 'done') as pending_pre,
       (select count(*)::int from checks c where c.item_uid = i.uid and c.project = i.project and c.timing = 'post-deploy' and c.status <> 'done') as pending_post,
       (select h.via from status_history h where h.item_uid = i.uid and h.project = i.project order by h.n desc limit 1) as last_via,
       (select jsonb_build_object('version', coalesce((n.meta->>'version')::int, 1), 'triaged', coalesce((n.meta->>'triaged')::boolean, false))
          from notes n where n.item_uid = i.uid and n.project = i.project and n.kind = 'ticket-request'
          order by coalesce((n.meta->>'version')::int, 1) desc, n.n desc limit 1) as request_meta,
       (select h.to_status from status_history h where h.item_uid = i.uid and h.project = i.project order by h.n desc limit 1) as last_to
     from items i left join jira_links l on l.item_uid = i.uid and l.project = i.project
     where i.project = $1 ${where}
     order by i.created, i.id`, [key, ...params]);
  return rows as Card[];
}

export interface BoardFilters {
  review?: boolean;
  entries?: Entry[];
  view?: "merged" | "tabs";
  tab?: number;
  type?: string;
  parked?: boolean;
}

export const COLUMNS = [
  { key: "requested", label: "Requested", statuses: ["requested"] },
  { key: "triage", label: "Triage", statuses: ["in-triage"] },
  { key: "ready", label: "Ready", statuses: ["todo"] },
  { key: "progress", label: "In progress", statuses: ["in-progress", "qa-rejected", "review", "blocked"] },
  { key: "qa", label: "QA", statuses: ["ready-for-qa", "in-qa"] },
  { key: "deploy", label: "Ready to deploy", statuses: ["ready-to-deploy"] },
  { key: "shipped", label: "Shipped", statuses: ["deployed", "done"] },
  { key: "parked", label: "Parked", statuses: PARKED },
];

const SHIPPED_DAYS = 14;

/** Cards past the type and review filters, before the role entries. */
function baseFilter<T extends Card>(all: T[], f: BoardFilters, me: string): T[] {
  return all.filter((c) =>
    (!f.review || (c.status === "review" && c.last_to === "review" && c.last_via === "agent" && c.developer === me))
    && (!f.type || c.type === f.type));
}

export function filterCards<T extends Card>(all: T[], f: BoardFilters, me: string): T[] {
  return matchEntries(baseFilter(all, f, me), f.entries ?? [], f.view ?? "merged", f.tab ?? 0);
}

/** How many cards each entry's tab would show. */
export function tabCounts(all: Card[], f: BoardFilters, me: string): number[] {
  const base = baseFilter(all, f, me);
  return (f.entries ?? []).map((e) => base.filter((c) => matches(c, e)).length);
}

export async function board(d: Db, p: Project, f: BoardFilters, me: string, now = Date.now()) {
  const every = await cards(d, p.key);
  const cutoff = now - SHIPPED_DAYS * 864e5;
  const visible = every.filter((c) => (f.parked || !PARKED.includes(c.status))
    && (!["deployed", "done"].includes(c.status) || !c.completed || Date.parse(c.completed) >= cutoff));
  return { columns: columns(filterCards(every, f, me), p, f, cutoff), counts: tabCounts(visible, f, me) };
}

function columns(all: Card[], p: Project, f: BoardFilters, cutoff: number) {
  return COLUMNS
    .filter((col) => (col.key !== "parked" || f.parked) && (col.key !== "deploy" || p.deploy_step))
    .map((col) => ({
      ...col,
      // Rejected work leads its column: it's waiting on someone.
      items: all.filter((c) => col.statuses.includes(c.status)
        && (col.key !== "shipped" || !c.completed || Date.parse(c.completed) >= cutoff))
        .sort((a, b) => Number(b.status === "qa-rejected") - Number(a.status === "qa-rejected")),
    }));
}

/** Everything the item page shows, as plain rows with their versions. */
export async function item(d: Db, key: string, id: string) {
  const [it] = await cards(d, key, "and i.id = $2", [id]);
  if (!it) return null;
  const [tasks, notes, logs, checks, history] = await Promise.all([
    d.query("select * from tasks where project = $2 and item_uid = $1 order by phase nulls last, position, n", [it.uid, key]),
    d.query("select * from notes where project = $2 and item_uid = $1 order by n", [it.uid, key]),
    d.query("select * from logs where project = $2 and item_uid = $1 order by n", [it.uid, key]),
    d.query("select * from checks where project = $2 and item_uid = $1 order by n", [it.uid, key]),
    d.query("select * from status_history where project = $2 and item_uid = $1 order by n", [it.uid, key]),
  ]);
  const by = (k: string) => notes.filter((n) => n.kind === k);
  const lastBlock = [...history].reverse().find((h) => h.to_status === "blocked");
  return {
    item: {
      ...it,
      calc_status: deriveCalcStatus(tasks.map((t) => t.status)) ?? it.calc_status,
      blocked_from: it.status === "blocked" ? lastBlock?.from_status ?? null : null,
    },
    ...requestView(by("ticket-request"), it.status),
    questions: by("clarification"),
    comments: notes.filter((n) => n.kind === "comment" || n.kind === "qa-rejection"),
    notes: by("context"),
    links: by("link"),
    logs,
    tasks,
    checks,
    history,
    bounces: bounceCount(history),
    related: await related(d, key, it.uid),
    phaseTitles: phaseTitles(it.extra),
    choices: await choices(d, key),
  };
}

/** Phase titles from `extra.phases`, keyed by phase number. */
export function phaseTitles(extra: Row | null | undefined): Record<string, string> {
  const raw = extra?.phases;
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string" && v.trim()) as [string, string][]);
}

/** Items related to this one, from either side, once each. Each row lists the
 * relation notes behind it, so removing it from either item removes them all. */
async function related(d: Db, key: string, uid: string) {
  const rows = await d.query(
    `select n.uid as note_uid, n.item_uid as note_item_uid, n.versions as note_versions,
            i.uid, i.id, i.title, i.status, i.developer
       from notes n join items i on i.project = n.project
        and i.uid = case when n.item_uid = $2 then n.meta->>'item' else n.item_uid end
      where n.project = $1 and n.kind = 'relation' and (n.item_uid = $2 or n.meta->>'item' = $2)
      order by n.ts, n.uid`, [key, uid]);
  const out = new Map<string, Row>();
  for (const r of rows) {
    const note = { uid: r.note_uid, item_uid: r.note_item_uid, versions: r.note_versions };
    const cur = out.get(r.uid);
    if (cur) cur.notes.push(note);
    else out.set(r.uid, { uid: r.uid, id: r.id, title: r.title, status: r.status, developer: r.developer, notes: [note] });
  }
  return [...out.values()];
}

/** App and section values already used in the project, for pickers. */
export async function choices(d: Db, key: string) {
  const rows = await d.query(
    `select distinct extra->>'app' as app, extra->>'section' as section from items
      where project = $1 and coalesce(extra->>'app', '') <> '' order by 1, 2`, [key]);
  const apps: Record<string, string[]> = {};
  for (const r of rows) {
    apps[r.app] ??= [];
    if (r.section) apps[r.app].push(r.section);
  }
  return apps;
}

export type ItemView = NonNullable<Awaited<ReturnType<typeof item>>>;

const versionOf = (n: Row) => Number(n.meta?.version ?? 1);

/** The current request (highest version), every version newest first, the last
 * triaged version, and whether the current one went past triage untriaged. */
export function requestView(notes: Row[], status: string) {
  const versions = [...notes].sort((a, b) => versionOf(b) - versionOf(a) || b.n - a.n);
  const current = versions[0] ?? null;
  const lastTriaged = versions.find((v) => v.meta?.triaged) ?? null;
  const untriaged = !!current && PAST_TRIAGE.includes(status) && !current.meta?.triaged;
  return {
    request: current,
    requestVersions: versions,
    triagedVersion: lastTriaged ? versionOf(lastTriaged) : null,
    untriaged,
  };
}

export function bounceCount(history: Row[]): number {
  return history.filter((h) => h.to_status === "qa-rejected" || (h.from_status === "in-qa" && h.to_status === "in-progress")).length;
}

async function withHistory(d: Db, rows: Card[]) {
  const out = [];
  for (const c of rows) {
    const history = await d.query("select * from status_history where project = $2 and item_uid = $1 order by n", [c.uid, c.project]);
    const links = await d.query(
      "select * from notes where project = $2 and item_uid = $1 and kind = 'link' and meta->>'type' in ('preview', 'qa-handoff') order by n", [c.uid, c.project]);
    const entered = [...history].reverse().find((h) => h.to_status === c.status)?.ts ?? c.created;
    out.push({ ...c, bounces: bounceCount(history), links, entered, history });
  }
  return out;
}

export async function qaQueue(d: Db, key: string, me: string, f: BoardFilters = {}) {
  const all = await withHistory(d, await cards(d, key, "and i.status in ('ready-for-qa', 'in-qa', 'qa-rejected')"));
  const counts = tabCounts(all.filter((r) => r.status !== "qa-rejected"), f, me);
  const rows = filterCards(all, f, me);
  const ready = rows.filter((r) => r.status === "ready-for-qa").sort((a, b) => a.entered.localeCompare(b.entered));
  const inQa = rows.filter((r) => r.status === "in-qa")
    .sort((a, b) => Number(b.qa_assignee === me) - Number(a.qa_assignee === me) || a.entered.localeCompare(b.entered));
  // What I sent back and is still waiting on a fix, whatever the filters.
  const awaitingFix = all.filter((r) => r.status === "qa-rejected" && [...r.history].reverse().find((h) => h.to_status === "qa-rejected")?.by === me);
  return { ready, inQa, awaitingFix, counts };
}

export async function deployPlan(d: Db, key: string) {
  const ready = await cards(d, key, "and i.status = 'ready-to-deploy'");
  const deployed = await cards(d, key, "and i.status = 'deployed'");
  const all = await d.query("select id, status from items where project = $1", [key]);
  const complete = new Set(all.filter((r) => COMPLETE.includes(r.status)).map((r) => r.id));
  const ids = new Set(all.map((r) => r.id));
  const checksFor = async (uids: string[]): Promise<Row[]> => uids.length
    ? d.query("select c.*, i.id as item_id, i.title as item_title from checks c join items i on i.uid = c.item_uid and i.project = c.project where c.project = $2 and c.item_uid = any($1::text[]) order by i.created, i.id, c.n", [uids, key])
    : [];
  const readyChecks = await checksFor(ready.map((r) => r.uid));
  const after = (await checksFor(deployed.map((r) => r.uid))).filter((c) => c.timing === "post-deploy" && c.status !== "done");
  const warn = (c: Row): Row => ({
    ...c, warning: c.kind === "prereq-branch" && c.payload && ids.has(c.payload) && !complete.has(c.payload) ? "not deployed" : null,
  });
  const kindOrder = (c: Row) => CHECK_KINDS.indexOf(c.kind as (typeof CHECK_KINDS)[number]);
  // Each ticket's checks: pre before post, then in the order a deploy runs them.
  const byTicket = ready.map((it) => ({
    item: it,
    checks: readyChecks.filter((c) => c.item_uid === it.uid).map(warn)
      .sort((a, b) => Number(a.timing !== "pre-deploy") - Number(b.timing !== "pre-deploy") || kindOrder(a) - kindOrder(b) || a.n - b.n),
  }));
  const afterByTicket = deployed
    .map((it) => ({ item: it, checks: after.filter((c) => c.item_uid === it.uid) }))
    .filter((t) => t.checks.length);
  return { ready, afterDeploy: after, byTicket, afterByTicket };
}
