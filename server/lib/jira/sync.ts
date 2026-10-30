// Polling half of the Jira bridge. One pass mirrors the issues items link
// through their `jira` field (links.ts); every op id derives from Jira ids, so a
// repeated pass is a no-op.
import type { Db } from "../db";
import { JiraClient, type Fetch } from "./client";
import { jiraConfig, jiraReadOnly } from "./config";
import { backfillItem, syncLinked } from "./links";
import { ensureUser } from "./people";

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

export async function syncJira(db: Db, projectKey: string, opts: { createUsers?: boolean; fetchImpl?: Fetch } = {}):
    Promise<SyncResult> {
  if (!jiraReadOnly()) throw new Error("Polling Jira needs JIRA_READ_ONLY=1: writing back while polling isn't supported.");
  const cfg = jiraConfig();
  if (!cfg) throw new Error("Jira is not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
  const [p] = await db.query("select jira_synced_at, jira_poll from projects where key = $1", [projectKey]);
  if (!p) throw new Error(`No project ${projectKey}.`);
  if (p.jira_poll === false) return { comments: 0, users: 0, files: 0, backfilled: 0 };
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

/** Put an item's newly linked issues in its request now rather than at the
 * next poll, so a link made while the item is requested lands in the open
 * request instead of a later version. */
export async function backfillLinked(db: Db, projectKey: string, itemUid: string, opts: { fetchImpl?: Fetch } = {}):
    Promise<{ backfilled: string[] } | { skipped: string }> {
  const cfg = jiraConfig();
  if (!cfg) return { skipped: "Jira isn't configured on this server" };
  const [p] = await db.query("select jira_poll from projects where key = $1", [projectKey]);
  if (!p) throw new Error(`No project ${projectKey}.`);
  if (p.jira_poll === false) return { skipped: "jira-issue mirrors this project's tickets" };
  const jira = new JiraClient(cfg, opts.fetchImpl);
  return { backfilled: await backfillItem(db, jira, projectKey, itemUid, FIELDS, (jql) => search(jira, jql, FIELDS)) };
}

/** Every project the bridge polls, for a poll that covers them all: those whose linked tickets jira-issue mirrors are left out. */
export async function linkedProjects(db: Db): Promise<string[]> {
  return (await db.query("select key from projects where jira_poll order by key")).map((r) => r.key);
}
