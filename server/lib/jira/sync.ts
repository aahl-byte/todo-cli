// Polling half of the Jira bridge, for when Jira can't reach us with webhooks.
// One pass imports active issues not seen before, replays the changelog and
// comments of linked ones through the webhook handler, and mirrors sub-tasks
// as tasks. Every op id derives from Jira ids, so a repeated pass is a no-op.
import type { Db } from "../db";
import { applyOps, type Op } from "../apply";
import { addUser } from "../auth";
import { adfToText } from "./adf";
import { JiraClient, type Fetch } from "./client";
import { jiraConfig, jiraReadOnly } from "./config";
import { handleFor, handleWebhook, jiraPriority, jiraUid } from "./inbound";
import { inboundRules, inboundStatus, statusSet, type InboundRules } from "./rules";

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface SyncResult { imported: number; events: number; comments: number; tasks: number; users: number }

const FIELDS = ["summary", "description", "status", "assignee", "reporter", "issuetype", "priority", "parent",
                "created", "updated", "comment"];
/** Overlap between passes, so an issue updated mid-pass is seen again. */
const OVERLAP_MINUTES = 2;
const TASK_STATUS: Record<string, string> = { requested: "todo", todo: "todo", "in-triage": "todo", "in-progress": "in-progress",
  blocked: "blocked", review: "review", "ready-for-qa": "review", "in-qa": "review", "qa-rejected": "in-progress",
  "ready-to-deploy": "review", deployed: "done", done: "done" };

const isBug = (f: any) => ["bug", "defect"].includes(String(f?.issuetype?.name ?? "").toLowerCase());

/** Issues to mirror: active work, meaning a mapped status that isn't done. */
export function defaultJql(jiraProject: string, map: Record<string, string>, rules: InboundRules | null): string {
  const scope = rules
    ? ` AND status in (${Object.keys(rules.statuses).map((k) => `"${k}"`).join(", ")})`
    : map.requested ? ` AND status != "${map.requested}"` : "";
  return `project = "${jiraProject}" AND issuetype not in (Epic, subTaskIssueTypes()) AND statusCategory != Done${scope}`;
}

/** Whether an issue falls in the active scope `defaultJql` selects. */
function inScope(f: any, map: Record<string, string>, rules: InboundRules | null): boolean {
  if (f.statusCategory?.key === "done" || f.status?.statusCategory?.key === "done") return false;
  const name = String(f.status?.name ?? "");
  if (rules) return statusSet(rules, name) !== null;
  return !map.requested || name.toLowerCase() !== map.requested.toLowerCase();
}

/** The todo status a Jira status maps to; ties go to the earliest in `map`'s lifecycle order. */
function todoStatus(map: Record<string, string>, jiraStatus: string): string | undefined {
  return Object.keys(map).find((k) => map[k].toLowerCase() === jiraStatus.toLowerCase());
}

async function search(jira: JiraClient, jql: string, fields: string[]): Promise<any[]> {
  const out: any[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jira.call("POST", "/rest/api/3/search/jql", { jql, fields, maxResults: 100, nextPageToken });
    out.push(...(page.issues ?? []));
    nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
  } while (nextPageToken);
  return out;
}

async function allComments(jira: JiraClient, issue: any): Promise<any[]> {
  const c = issue.fields?.comment;
  if (c && (c.comments?.length ?? 0) >= (c.total ?? 0)) return c.comments ?? [];
  const out: any[] = [];
  for (let at = 0; ; at += 100) {
    const page = await jira.call("GET", `/rest/api/3/issue/${issue.key}/comment?startAt=${at}&maxResults=100&orderBy=created`);
    out.push(...(page.comments ?? []));
    if (out.length >= (page.total ?? 0) || !page.comments?.length) return out;
  }
}

async function changelog(jira: JiraClient, key: string): Promise<any[]> {
  const out: any[] = [];
  for (let at = 0; ; at += 100) {
    const page = await jira.call("GET", `/rest/api/3/issue/${key}/changelog?startAt=${at}&maxResults=100`);
    out.push(...(page.values ?? []));
    if (page.isLast !== false || !page.values?.length) return out;
  }
}

const slugName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "user";

/** A user for this Jira account, made on first sight with password `<handle>-test`. */
async function ensureUser(db: Db, p: Person): Promise<boolean> {
  if (!p?.accountId || !p.displayName) return false;
  const [known] = await db.query("select 1 from users where jira_account_id = $1", [p.accountId]);
  if (known) return false;
  const base = slugName(p.displayName);
  let handle = base;
  for (let i = 2; (await db.query("select 1 from users where handle = $1", [handle])).length; i++) handle = `${base}-${i}`;
  await addUser(db, handle, p.displayName, `${handle}-test`);
  await db.query("update users set jira_account_id = $2 where handle = $1", [handle, p.accountId]);
  return true;
}

export async function syncJira(db: Db, projectKey: string, opts: { createUsers?: boolean; fetchImpl?: Fetch } = {}):
    Promise<SyncResult> {
  if (!jiraReadOnly()) throw new Error("Polling Jira needs JIRA_READ_ONLY=1: writing back while polling isn't supported.");
  const cfg = jiraConfig();
  if (!cfg) throw new Error("Jira is not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
  const [p] = await db.query("select * from projects where key = $1", [projectKey]);
  if (!p?.jira_project) throw new Error(`Project ${projectKey} has no jira_project.`);
  const jira = new JiraClient(cfg, opts.fetchImpl);
  const map: Record<string, string> = p.jira_status_map ?? {};
  const startedAt = new Date();
  const since = p.jira_synced_at ? new Date(p.jira_synced_at) : null;
  const window = since ? ` AND updated >= -${Math.ceil((startedAt.getTime() - since.getTime()) / 60_000) + OVERLAP_MINUTES}m` : "";
  const out: SyncResult = { imported: 0, events: 0, comments: 0, tasks: 0, users: 0 };
  const meet = async (who: Person) => { if (opts.createUsers && await ensureUser(db, who)) out.users++; };

  const imported: string[] = [];
  const rules = inboundRules(p.jira_inbound);
  const active = defaultJql(p.jira_project, map, rules);
  // Later passes look at everything that changed, so linked issues that left
  // the active scope (moved to Done, say) still bring their last moves.
  const issues = await search(jira, window
    ? `project = "${p.jira_project}" AND issuetype not in (Epic, subTaskIssueTypes())${window} ORDER BY updated ASC`
    : `${active} ORDER BY updated ASC`, FIELDS);
  for (const issue of issues) {
    const f = issue.fields ?? {};
    const [link] = await db.query("select * from jira_links where jira_key = $1", [issue.key]);
    if (!link && !inScope(f, map, rules)) continue;
    for (const who of [f.reporter, f.assignee]) await meet(who);
    if (!link) {
      if (await importIssue(db, projectKey, map, rules, issue)) { out.imported++; imported.push(issue.key); }
    } else {
      const done = Number(link.replayed_through ?? 0);
      const entries = (await changelog(jira, issue.key)).filter((e) => Date.parse(e.created) > done)
        .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
      for (const e of entries) {
        await meet(e.author);
        const at = Date.parse(e.created);
        await handleWebhook(db, { webhookEvent: "jira:issue_updated", timestamp: at, user: e.author, issue,
                                  changelog: { id: `cl-${e.id}`, items: e.items ?? [] } }, { fetchImpl: opts.fetchImpl });
        await db.query("update jira_links set replayed_through = greatest(coalesce(replayed_through, 0), $2) where jira_key = $1", [issue.key, at]);
        out.events++;
      }
    }
    for (const c of await allComments(jira, issue)) {
      await meet(c.author);
      const r = await handleWebhook(db, { webhookEvent: "comment_created", issue, comment: c }, { fetchImpl: opts.fetchImpl });
      if (r.handled && (r.results as any[])?.some((x) => x.status === "applied" && !x.duplicate)) out.comments++;
    }
  }
  out.tasks = await syncSubtasks(db, jira, projectKey, p.jira_project, map, rules, window, imported, meet);
  await db.query("update projects set jira_synced_at = $2 where key = $1", [projectKey, startedAt.toISOString()]);
  return out;
}

/** Create the item, its request and its link, as the issue stands now. */
async function importIssue(db: Db, project: string, map: Record<string, string>, rules: InboundRules | null, issue: any): Promise<boolean> {
  const f = issue.fields ?? {};
  const uid = jiraUid("item", issue.key);
  const summary = String(f.summary ?? issue.key);
  const description = adfToText(f.description);
  const creator = (await handleFor(db, f.reporter)) ?? "jira-bridge";
  const jiraStatus = String(f.status?.name ?? "");
  const status = (rules ? inboundStatus(rules, null, null, jiraStatus) : todoStatus(map, jiraStatus)) ?? "requested";
  const epic = f.parent?.fields?.issuetype?.name === "Epic" ? f.parent.fields.summary : undefined;
  const ops: Op[] = [
    { op_id: `jira:${issue.key}:create`, op: "create", entity: "item", uid, item_uid: uid,
      data: { id: issue.key.toLowerCase(), title: summary, type: isBug(f) ? "bug" : "feature", status,
              priority: jiraPriority(f.priority?.name), creator, developer: await handleFor(db, f.assignee),
              created: f.created ? new Date(f.created).toISOString() : undefined,
              ...(epic ? { extra: { epic } } : {}) } },
    { op_id: `jira:${issue.key}:request`, op: "create", entity: "note", uid: jiraUid("request", issue.key), item_uid: uid,
      data: { n: 1, kind: "ticket-request", text: description ? `${summary}\n\n${description}` : summary,
              meta: { jira_key: issue.key }, source: "jira", ts: f.created ? new Date(f.created).toISOString() : undefined } },
  ];
  const results = await applyOps(db, project, ops, { handle: creator, unconditional: true, bridge: true });
  if (results[0].status !== "applied" || results[0].duplicate) return false;
  const at = f.updated ? Date.parse(f.updated) : Date.now();
  // History before the import is already reflected in the item as created.
  await db.query(
    `insert into jira_links (project, item_uid, jira_key, last_event_at, last_assignee_at, replayed_through)
     values ($1, $2, $3, $4, $4, $4) on conflict do nothing`, [project, uid, issue.key, at]);
  return true;
}

/** Sub-tasks of linked issues, as tasks on the parent item. */
async function syncSubtasks(db: Db, jira: JiraClient, project: string, jiraProject: string, map: Record<string, string>, rules: InboundRules | null,
                            window: string, imported: string[], meet: (p: Person) => Promise<void>): Promise<number> {
  const links = await db.query("select jira_key, item_uid from jira_links where project = $1", [project]);
  const parentOf = new Map<string, string>(links.map((l) => [l.jira_key, l.item_uid]));
  const fields = ["summary", "status", "parent", "assignee"];
  const subs: any[] = [];
  // Every sub-task of a parent new this pass, then whatever changed since the last.
  for (let i = 0; i < imported.length; i += 50) {
    subs.push(...await search(jira, `parent in (${imported.slice(i, i + 50).join(",")}) AND issuetype in subTaskIssueTypes()`, fields));
  }
  if (window) subs.push(...await search(jira, `project = "${jiraProject}" AND issuetype in subTaskIssueTypes()${window}`, fields));
  let n = 0;
  for (const s of subs) {
    const itemUid = parentOf.get(s.fields?.parent?.key);
    if (!itemUid) continue;
    await meet(s.fields?.assignee);
    const jiraStatus = String(s.fields?.status?.name ?? "");
    const mapped = rules ? statusSet(rules, jiraStatus)?.[0] : todoStatus(map, jiraStatus);
    const status = TASK_STATUS[mapped ?? "todo"] ?? "todo";
    const title = String(s.fields?.summary ?? s.key);
    const uid = jiraUid("task", s.key);
    const [task] = await db.query("select title, status, versions from tasks where project = $1 and uid = $2", [project, uid]);
    const op: Op | null = !task
      ? { op_id: `jira:task:${s.key}`, op: "create", entity: "task", uid, item_uid: itemUid,
          data: { title, status, phase: null, position: 1e6 } }
      : task.title !== title || task.status !== status
        ? { op_id: `jira:task:${s.key}:${title}:${status}`, op: "set", entity: "task", uid, item_uid: itemUid, data: { title, status } }
        : null;
    if (!op) continue;
    const [r] = await applyOps(db, project, [op], { handle: "jira-bridge", unconditional: true, bridge: true });
    if (r.status === "applied" && !r.duplicate) n++;
  }
  return n;
}
