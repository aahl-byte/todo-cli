// The todo → Jira half: apply.ts queues rows, flush.ts delivers them.
import type { Db } from "../db";
import type { Actor } from "../apply";
import { jiraReadOnly } from "./config";
import { outboundRules, outboundTarget } from "./rules";

export interface JiraEvent { project: string; itemUid: string; from: string; status: string }

/** A triggered status move transitions every issue the item's jira field names. */
export async function queueJira(t: Db, actor: Actor, event: JiraEvent): Promise<void> {
  if (actor.bridge) return;
  const [p] = await t.query("select jira_outbound from projects where key = $1", [event.project]);
  const rules = outboundRules(p?.jira_outbound);
  const target = rules && outboundTarget(rules, event.from, event.status);
  if (!target) return;
  const keys: string[] = (await t.query(
    "select jira_key from jira_links where project = $1 and item_uid = $2 and source = 'field' order by jira_key",
    [event.project, event.itemUid])).map((r) => r.jira_key);
  if (!keys.length) return;
  // A newer transition supersedes any older one still waiting for the same
  // issue, so a retried old row can never land after it. A dry run supersedes nothing.
  if (await jiraWrites(t, event.project)) await t.query(
    `update jira_outbox set done_at = now(), result = '{"superseded":true}'::jsonb
      where project = $1 and item_uid = $2 and action = 'transition' and done_at is null and claimed_at is null
        and payload->>'key' = any($3::text[])`,
    [event.project, event.itemUid, keys]);
  for (const key of keys) await enqueue(t, event.project, event.itemUid, "transition", { key, status: target });
}

/** Whether a project's Jira calls are sent: the server allows writes and the
 * project has switched them on. */
export async function jiraWrites(t: Db, project: string): Promise<boolean> {
  if (jiraReadOnly()) return false;
  const [p] = await t.query("select jira_outbound from projects where key = $1", [project]);
  return outboundRules(p?.jira_outbound)?.writes ?? false;
}

/** Queue a Jira call; with writes off it's recorded as done, as a dry run. */
async function enqueue(t: Db, project: string, itemUid: string, action: string, payload: Record<string, unknown>) {
  const live = await jiraWrites(t, project);
  await t.query(
    `insert into jira_outbox (project, item_uid, action, payload, done_at, result)
     values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)`,
    [project, itemUid, action, JSON.stringify(payload), live ? null : new Date(), live ? null : '{"dry_run":true}']);
}
