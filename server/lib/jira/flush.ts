// Deliver queued Jira calls. Each row is claimed by bumping `attempts`, so two
// flushes never send the same row; a failure records the error and the row is
// retried until MAX_ATTEMPTS.
import type { Db } from "../db";
import { textToAdf } from "./adf";
import { JiraClient, type Fetch } from "./client";
import { COMMENT_MARK, MAX_ATTEMPTS, jiraConfig } from "./config";

export async function flushJira(db: Db, fetchImpl?: Fetch): Promise<{ sent: number; failed: number }> {
  const cfg = jiraConfig();
  if (!cfg) return { sent: 0, failed: 0 };
  const jira = new JiraClient(cfg, fetchImpl);
  const rows = await db.query(
    "select id, action, payload, attempts from jira_outbox where done_at is null and attempts < $1 order by id limit 50",
    [MAX_ATTEMPTS]);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = await db.query(
      "update jira_outbox set attempts = attempts + 1 where id = $1 and attempts = $2 and done_at is null returning id",
      [row.id, row.attempts]);
    if (!claimed.length) continue;
    try {
      const result = await deliver(jira, row.action, row.payload);
      await db.query("update jira_outbox set done_at = now(), error = null, result = $2::jsonb where id = $1",
        [row.id, JSON.stringify(result ?? {})]);
      sent++;
    } catch (e) {
      await db.query("update jira_outbox set error = $2 where id = $1", [row.id, String((e as Error).message ?? e)]);
      failed++;
    }
  }
  return { sent, failed };
}

async function deliver(jira: JiraClient, action: string, p: Record<string, any>): Promise<Record<string, unknown>> {
  const key = encodeURIComponent(p.key);
  if (action === "transition") {
    const issue = await jira.call("GET", `/rest/api/3/issue/${key}?fields=status`);
    const current = issue?.fields?.status?.name;
    if (current && current.toLowerCase() === String(p.status).toLowerCase()) return { skipped: "already there" };
    const { transitions = [] } = await jira.call("GET", `/rest/api/3/issue/${key}/transitions`);
    const want = String(p.status).toLowerCase();
    const t = transitions.find((x: any) => x?.to?.name?.toLowerCase() === want)
      ?? transitions.find((x: any) => x?.name?.toLowerCase() === want);
    if (!t) throw new Error(`no transition from ${current ?? "?"} to ${p.status}`);
    await jira.call("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    return { transition: t.id };
  }
  if (action === "comment") {
    const head = p.label === "QA rejected" ? `QA rejected — ${p.author ?? "someone"} ${COMMENT_MARK}` : `${p.author ?? "someone"} ${COMMENT_MARK}`;
    const res = await jira.call("POST", `/rest/api/3/issue/${key}/comment`, { body: textToAdf(`${head}:\n${p.text}`) });
    return { comment_id: res?.id ?? null };
  }
  if (action === "remotelink") {
    await jira.call("POST", `/rest/api/3/issue/${key}/remotelink`, { object: { url: p.url, title: p.title } });
    return {};
  }
  throw new Error(`unknown action ${action}`);
}
