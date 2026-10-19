// The todo → Jira half: apply.ts queues rows, flush.ts delivers them.
import type { Db } from "../db";
import type { Actor } from "../apply";
import { jiraReadOnly } from "./config";
import { outboundRules, outboundTarget } from "./rules";

export type JiraEvent =
  | { kind: "status"; project: string; itemUid: string; from: string; status: string }
  | { kind: "note"; project: string; itemUid: string; note: Record<string, any> };

/** The Jira status a todo status maps to. An unmapped `qa-rejected` follows
 * `in-progress`, so a rejection still moves the Jira issue. */
export function jiraTarget(map: Record<string, string> | null | undefined, status: string): string | undefined {
  const m = map ?? {};
  return m[status] ?? (status === "qa-rejected" ? m["in-progress"] : undefined);
}

export async function queueJira(t: Db, actor: Actor, event: JiraEvent): Promise<void> {
  if (actor.bridge) return;
  const [p] = await t.query("select jira_mode, jira_status_map, jira_outbound from projects where key = $1", [event.project]);
  if (!p) return;
  const rules = outboundRules(p.jira_outbound);
  // An import-mode item speaks for the issue it was imported from; a links-mode
  // item moves every issue its jira field names, and posts no comments.
  const links = p.jira_mode === "links";
  const keys: string[] = (await t.query(
    "select jira_key from jira_links where project = $1 and item_uid = $2 and source = $3 order by jira_key",
    [event.project, event.itemUid, links ? "field" : "import"])).map((r) => r.jira_key);
  if (!keys.length) return;
  if (event.kind === "status") {
    const target = rules ? outboundTarget(rules, event.from, event.status) : links ? null : jiraTarget(p.jira_status_map, event.status);
    if (!target) return;
    // A newer transition supersedes any older one still waiting for the same
    // issue, so a retried old row can never land after it. A dry run supersedes nothing.
    if (await jiraWrites(t, event.project)) await t.query(
      `update jira_outbox set done_at = now(), result = '{"superseded":true}'::jsonb
        where project = $1 and item_uid = $2 and action = 'transition' and done_at is null and claimed_at is null
          and payload->>'key' = any($3::text[])`,
      [event.project, event.itemUid, keys]);
    for (const key of keys) await enqueue(t, event.project, event.itemUid, "transition", { key, status: target });
    return;
  }
  const { note } = event;
  // A reply in a question's thread stays with the question, which Jira never sees.
  if (links || note.source === "jira" || (rules && !rules.comments) || note.meta?.thread) return;
  const [key] = keys;
  if (note.kind === "comment" || note.kind === "qa-rejection") {
    const label = note.kind === "qa-rejection" ? "QA rejected" : "comment";
    await enqueue(t, event.project, event.itemUid, "comment",
      { key, text: note.text, author: note.author, label });
  } else if (note.kind === "link" && note.meta?.url && !rules) {
    await enqueue(t, event.project, event.itemUid, "remotelink",
      { key, url: note.meta.url, title: note.meta.label || note.text || note.meta.url, global_id: note.uid });
  }
}

/** Whether a project's Jira calls are sent: the server allows writes and the
 * project hasn't switched them off. A project with only the legacy map sends. */
export async function jiraWrites(t: Db, project: string): Promise<boolean> {
  if (jiraReadOnly()) return false;
  const [p] = await t.query("select jira_outbound from projects where key = $1", [project]);
  return outboundRules(p?.jira_outbound)?.writes ?? true;
}

/** Queue a Jira call; with writes off it's recorded as done, as a dry run. */
export async function enqueue(t: Db, project: string, itemUid: string, action: string, payload: Record<string, unknown>) {
  const live = await jiraWrites(t, project);
  await t.query(
    `insert into jira_outbox (project, item_uid, action, payload, done_at, result)
     values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)`,
    [project, itemUid, action, JSON.stringify(payload), live ? null : new Date(), live ? null : '{"dry_run":true}']);
}
