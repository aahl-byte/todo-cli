// Polling half of the Jira bridge. One pass mirrors the issues items link
// through their `jira` field (links.ts); every op id derives from Jira ids, so a
// repeated pass is a no-op.
import type { Db } from "../db";
import { addUser } from "../auth";
import { JiraClient, type Fetch } from "./client";
import { jiraConfig, jiraReadOnly } from "./config";
import { syncLinked } from "./links";

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface SyncResult { comments: number; users: number; files: number; backfilled: number }

const FIELDS = ["summary", "description", "status", "assignee", "reporter", "updated", "comment", "attachment"];
/** Overlap between passes, so an issue updated mid-pass is seen again. */
const OVERLAP_MINUTES = 2;

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
  const [p] = await db.query("select jira_synced_at from projects where key = $1", [projectKey]);
  if (!p) throw new Error(`No project ${projectKey}.`);
  const jira = new JiraClient(cfg, opts.fetchImpl);
  const startedAt = new Date();
  const since = p.jira_synced_at ? new Date(p.jira_synced_at) : null;
  const out: SyncResult = { comments: 0, users: 0, files: 0, backfilled: 0 };
  const meet = async (who: Person) => { if (opts.createUsers && await ensureUser(db, who)) out.users++; };
  const linked = await syncLinked(db, jira, projectKey, {
    since: since ? new Date(since.getTime() - OVERLAP_MINUTES * 60_000) : null, fields: FIELDS,
    search: (jql) => search(jira, jql, FIELDS), comments: (issue) => allComments(jira, issue), meet });
  out.backfilled += linked.backfilled;
  out.comments += linked.comments;
  out.files += linked.files;
  await db.query("update projects set jira_synced_at = $2 where key = $1", [projectKey, startedAt.toISOString()]);
  return out;
}

/** Every project, for a poll that covers them all. */
export async function linkedProjects(db: Db): Promise<string[]> {
  return (await db.query("select key from projects order by key")).map((r) => r.key);
}
