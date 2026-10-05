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
  const [link] = await t.query(
    `select l.jira_key, p.jira_status_map, p.jira_outbound from jira_links l join projects p on p.key = l.project
      where l.project = $1 and l.item_uid = $2`, [event.project, event.itemUid]);
  if (!link) return;
  const rules = outboundRules(link.jira_outbound);
  if (event.kind === "status") {
    const target = rules ? outboundTarget(rules, event.from, event.status) : jiraTarget(link.jira_status_map, event.status);
    if (!target) return;
    // A newer transition supersedes any older one still waiting, so a retried
    // old row can never land after the new one. A dry run supersedes nothing.
    if (await jiraWrites(t, event.project)) await t.query(
      `update jira_outbox set done_at = now(), result = '{"superseded":true}'::jsonb
        where project = $1 and item_uid = $2 and action = 'transition' and done_at is null and claimed_at is null`,
      [event.project, event.itemUid]);
    await enqueue(t, event.project, event.itemUid, "transition", { key: link.jira_key, status: target });
    return;
  }
  const { note } = event;
  if (note.source === "jira" || (rules && !rules.comments)) return;
  if (note.kind === "comment" || note.kind === "qa-rejection") {
    const label = note.kind === "qa-rejection" ? "QA rejected" : "comment";
    await enqueue(t, event.project, event.itemUid, "comment",
      { key: link.jira_key, text: note.text, author: note.author, label });
  } else if (note.kind === "link" && note.meta?.url && !rules) {
    await enqueue(t, event.project, event.itemUid, "remotelink",
      { key: link.jira_key, url: note.meta.url, title: note.meta.label || note.text || note.meta.url, global_id: note.uid });
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
