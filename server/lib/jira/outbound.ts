// The todo → Jira half: apply.ts queues rows, flush.ts delivers them.
import type { Db } from "../db";
import type { Actor } from "../apply";

export type JiraEvent =
  | { kind: "status"; itemUid: string; status: string }
  | { kind: "note"; itemUid: string; note: Record<string, any> };

export async function queueJira(t: Db, actor: Actor, event: JiraEvent): Promise<void> {
  if (actor.bridge) return;
  const [link] = await t.query(
    `select l.jira_key, p.jira_status_map from jira_links l
       join items i on i.uid = l.item_uid join projects p on p.key = i.project
      where l.item_uid = $1`, [event.itemUid]);
  if (!link) return;
  if (event.kind === "status") {
    const target = (link.jira_status_map ?? {})[event.status];
    if (!target) return;
    await enqueue(t, event.itemUid, "transition", { key: link.jira_key, status: target });
    return;
  }
  const { note } = event;
  if (note.source === "jira") return;
  if (note.kind === "comment" || note.kind === "qa-rejection") {
    const label = note.kind === "qa-rejection" ? "QA rejected" : "comment";
    await enqueue(t, event.itemUid, "comment",
      { key: link.jira_key, text: note.text, author: note.author, label });
  } else if (note.kind === "link" && note.meta?.url) {
    await enqueue(t, event.itemUid, "remotelink",
      { key: link.jira_key, url: note.meta.url, title: note.meta.label || note.text || note.meta.url });
  }
}

async function enqueue(t: Db, itemUid: string, action: string, payload: Record<string, unknown>) {
  await t.query("insert into jira_outbox (item_uid, action, payload) values ($1, $2, $3::jsonb)",
    [itemUid, action, JSON.stringify(payload)]);
}
