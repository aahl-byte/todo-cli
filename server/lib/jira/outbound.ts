// The todo → Jira half: apply.ts queues rows, flush.ts delivers them.
import type { Db } from "../db";
import type { Actor } from "../apply";

export type JiraEvent =
  | { kind: "status"; project: string; itemUid: string; status: string }
  | { kind: "note"; project: string; itemUid: string; note: Record<string, any> };

export async function queueJira(t: Db, actor: Actor, event: JiraEvent): Promise<void> {
  if (actor.bridge) return;
  const [link] = await t.query(
    `select l.jira_key, p.jira_status_map from jira_links l join projects p on p.key = l.project
      where l.project = $1 and l.item_uid = $2`, [event.project, event.itemUid]);
  if (!link) return;
  if (event.kind === "status") {
    const target = (link.jira_status_map ?? {})[event.status];
    if (!target) return;
    // A newer transition supersedes any older one still waiting, so a retried
    // old row can never land after the new one.
    await t.query(
      `update jira_outbox set done_at = now(), result = '{"superseded":true}'::jsonb
        where project = $1 and item_uid = $2 and action = 'transition' and done_at is null and claimed_at is null`,
      [event.project, event.itemUid]);
    await enqueue(t, event.project, event.itemUid, "transition", { key: link.jira_key, status: target });
    return;
  }
  const { note } = event;
  if (note.source === "jira") return;
  if (note.kind === "comment" || note.kind === "qa-rejection") {
    const label = note.kind === "qa-rejection" ? "QA rejected" : "comment";
    await enqueue(t, event.project, event.itemUid, "comment",
      { key: link.jira_key, text: note.text, author: note.author, label });
  } else if (note.kind === "link" && note.meta?.url) {
    await enqueue(t, event.project, event.itemUid, "remotelink",
      { key: link.jira_key, url: note.meta.url, title: note.meta.label || note.text || note.meta.url, global_id: note.uid });
  }
}

export async function enqueue(t: Db, project: string, itemUid: string, action: string, payload: Record<string, unknown>) {
  await t.query("insert into jira_outbox (project, item_uid, action, payload) values ($1, $2, $3, $4::jsonb)",
    [project, itemUid, action, JSON.stringify(payload)]);
}
