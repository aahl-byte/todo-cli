// Read models for the dashboard pages. Every entity carries its `versions`
// so actions can send the base they were rendered with.
import type { Db, Row } from "./db";
import { CHECK_KINDS, COMPLETE, PARKED, deriveCalcStatus } from "./model";

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
  versions: Record<string, number>;
  task_statuses: string[];
  open_questions: number;
  pending_pre: number;
  pending_post: number;
  jira_key: string | null;
  last_via: string | null;
  last_to: string | null;
}

async function cards(d: Db, key: string, where = "", params: unknown[] = []): Promise<Card[]> {
  const rows = await d.query(
    `select i.*, l.jira_key,
       coalesce((select array_agg(t.status order by t.phase nulls last, t.position, t.n) from tasks t where t.item_uid = i.uid), '{}') as task_statuses,
       (select count(*)::int from notes n where n.item_uid = i.uid and n.kind = 'clarification' and coalesce(n.meta->>'state', 'open') <> 'answered') as open_questions,
       (select count(*)::int from checks c where c.item_uid = i.uid and c.timing = 'pre-deploy' and c.status <> 'done') as pending_pre,
       (select count(*)::int from checks c where c.item_uid = i.uid and c.timing = 'post-deploy' and c.status <> 'done') as pending_post,
       (select h.via from status_history h where h.item_uid = i.uid order by h.n desc limit 1) as last_via,
       (select h.to_status from status_history h where h.item_uid = i.uid order by h.n desc limit 1) as last_to
     from items i left join jira_links l on l.item_uid = i.uid
     where i.project = $1 ${where}
     order by i.created, i.id`, [key, ...params]);
  return rows as Card[];
}

export interface BoardFilters {
  mine?: boolean;
  review?: boolean;
  developer?: string;
  qa?: string;
  type?: string;
  parked?: boolean;
}

export const COLUMNS = [
  { key: "requested", label: "Requested", statuses: ["requested"] },
  { key: "triage", label: "Triage", statuses: ["in-triage"] },
  { key: "ready", label: "Ready", statuses: ["todo"] },
  { key: "progress", label: "In progress", statuses: ["in-progress", "review", "blocked"] },
  { key: "qa", label: "QA", statuses: ["ready-for-qa", "in-qa"] },
  { key: "deploy", label: "Ready to deploy", statuses: ["ready-to-deploy"] },
  { key: "shipped", label: "Shipped", statuses: ["deployed", "done"] },
  { key: "parked", label: "Parked", statuses: PARKED },
];

const SHIPPED_DAYS = 14;

export function filterCards(all: Card[], f: BoardFilters, me: string): Card[] {
  return all.filter((c) =>
    (!f.mine || [c.developer, c.qa_assignee, c.creator].includes(me))
    && (!f.review || (c.status === "review" && c.last_to === "review" && c.last_via === "agent" && c.developer === me))
    && (!f.developer || c.developer === f.developer)
    && (!f.qa || c.qa_assignee === f.qa)
    && (!f.type || c.type === f.type));
}

export async function board(d: Db, p: Project, f: BoardFilters, me: string, now = Date.now()) {
  const all = filterCards(await cards(d, p.key), f, me);
  const cutoff = now - SHIPPED_DAYS * 864e5;
  return COLUMNS
    .filter((col) => (col.key !== "parked" || f.parked) && (col.key !== "deploy" || p.deploy_step))
    .map((col) => ({
      ...col,
      items: all.filter((c) => col.statuses.includes(c.status)
        && (col.key !== "shipped" || !c.completed || Date.parse(c.completed) >= cutoff)),
    }));
}

export async function item(d: Db, key: string, id: string) {
  const [it] = await cards(d, key, "and i.id = $2", [id]);
  if (!it) return null;
  const [tasks, notes, logs, checks, history] = await Promise.all([
    d.query("select * from tasks where item_uid = $1 order by phase nulls last, position, n", [it.uid]),
    d.query("select * from notes where item_uid = $1 order by n", [it.uid]),
    d.query("select * from logs where item_uid = $1 order by n", [it.uid]),
    d.query("select * from checks where item_uid = $1 order by n", [it.uid]),
    d.query("select * from status_history where item_uid = $1 order by n", [it.uid]),
  ]);
  const phases = new Map<string, Row[]>();
  for (const t of tasks) {
    const k = t.phase === null ? "unphased" : String(t.phase);
    if (!phases.has(k)) phases.set(k, []);
    phases.get(k)!.push(t);
  }
  const by = (k: string) => notes.filter((n) => n.kind === k);
  const clarifications = by("clarification");
  return {
    item: { ...it, calc_status: deriveCalcStatus(tasks.map((t) => t.status)) ?? it.calc_status },
    phases: [...phases.entries()].map(([phase, rows]) => ({
      phase: phase === "unphased" ? null : Number(phase),
      tasks: rows,
      done: rows.filter((t) => COMPLETE.includes(t.status)).length,
    })),
    requests: by("ticket-request"),
    openQuestions: clarifications.filter((n) => n.meta?.state !== "answered"),
    answered: clarifications.filter((n) => n.meta?.state === "answered"),
    context: by("context"),
    comments: notes.filter((n) => n.kind === "comment" || n.kind === "qa-rejection"),
    links: by("link"),
    logs,
    checks,
    history,
    bounces: bounceCount(history),
  };
}

export function bounceCount(history: Row[]): number {
  return history.filter((h) => h.from_status === "in-qa" && h.to_status === "in-progress").length;
}

async function withHistory(d: Db, rows: Card[]) {
  const out = [];
  for (const c of rows) {
    const history = await d.query("select * from status_history where item_uid = $1 order by n", [c.uid]);
    const links = await d.query(
      "select * from notes where item_uid = $1 and kind = 'link' and meta->>'type' in ('preview', 'qa-handoff') order by n", [c.uid]);
    const entered = [...history].reverse().find((h) => h.to_status === c.status)?.ts ?? c.created;
    out.push({ ...c, bounces: bounceCount(history), links, entered });
  }
  return out;
}

export async function qaQueue(d: Db, key: string, me: string) {
  const rows = await withHistory(d, await cards(d, key, "and i.status in ('ready-for-qa', 'in-qa')"));
  const ready = rows.filter((r) => r.status === "ready-for-qa").sort((a, b) => a.entered.localeCompare(b.entered));
  const inQa = rows.filter((r) => r.status === "in-qa")
    .sort((a, b) => Number(b.qa_assignee === me) - Number(a.qa_assignee === me) || a.entered.localeCompare(b.entered));
  return { ready, inQa };
}

export async function deployPlan(d: Db, key: string) {
  const ready = await cards(d, key, "and i.status = 'ready-to-deploy'");
  const deployed = await cards(d, key, "and i.status = 'deployed'");
  const all = await d.query("select id, status from items where project = $1", [key]);
  const complete = new Set(all.filter((r) => COMPLETE.includes(r.status)).map((r) => r.id));
  const ids = new Set(all.map((r) => r.id));
  const checksFor = async (uids: string[]): Promise<Row[]> => uids.length
    ? d.query("select c.*, i.id as item_id from checks c join items i on i.uid = c.item_uid where c.item_uid = any($1::text[]) order by i.created, i.id, c.n", [uids])
    : [];
  const readyChecks = await checksFor(ready.map((r) => r.uid));
  const group = (timing: string) => CHECK_KINDS.map((kind) => ({
    kind,
    checks: readyChecks.filter((c) => c.timing === timing && c.kind === kind).map((c): Row => ({
      ...c,
      warning: kind === "prereq-branch" && c.payload && ids.has(c.payload) && !complete.has(c.payload) ? "not deployed" : null,
    })),
  })).filter((g) => g.checks.length);
  const after = (await checksFor(deployed.map((r) => r.uid))).filter((c) => c.timing === "post-deploy" && c.status !== "done");
  return { ready, pre: group("pre-deploy"), post: group("post-deploy"), afterDeploy: after };
}
