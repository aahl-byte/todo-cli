// Deliver queued Jira calls. A row is leased while in flight (`claimed_at`), so
// concurrent flushes never send it twice; a failure backs off exponentially, and
// after MAX_ATTEMPTS the row gives up and says so in the item's dev log.
import type { Db } from "../db";
import { applyOps } from "../apply";
import { ulid } from "../ulid";
import { nowIso } from "../model";
import { textToAdf } from "./adf";
import { JiraClient, type Fetch } from "./client";
import { COMMENT_MARK, LEASE_MINUTES, MAX_ATTEMPTS, jiraConfig } from "./config";

export async function flushJira(db: Db, fetchImpl?: Fetch): Promise<{ sent: number; failed: number }> {
  const cfg = jiraConfig();
  if (!cfg) return { sent: 0, failed: 0 };
  const jira = new JiraClient(cfg, fetchImpl);
  const rows = await db.query(
    `select id from jira_outbox
      where done_at is null and attempts < $1
        and (next_attempt_at is null or next_attempt_at <= now())
        and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
      order by id limit 50`, [MAX_ATTEMPTS, LEASE_MINUTES]);
  let sent = 0;
  let failed = 0;
  // A process that died during a row's last attempt left it claimed; give it up.
  const crashed = await db.query(
    `update jira_outbox set claimed_at = null
      where done_at is null and attempts >= $1 and claimed_at < now() - make_interval(mins => $2)
      returning id, project, item_uid, action, payload`, [MAX_ATTEMPTS, LEASE_MINUTES]);
  for (const row of crashed) await gaveUp(db, row, "the process stopped during the last attempt");
  for (const { id } of rows) {
    const [row] = await db.query(
      `update jira_outbox set attempts = attempts + 1, claimed_at = now()
        where id = $1 and done_at is null
          and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
        returning id, project, item_uid, action, payload, attempts`, [id, LEASE_MINUTES]);
    if (!row) continue;
    if (row.action === "transition" && await superseded(db, row)) {
      await db.query(`update jira_outbox set done_at = now(), claimed_at = null, result = '{"superseded":true}'::jsonb where id = $1`, [row.id]);
      continue;
    }
    if (row.action === "transition" && await olderInFlight(db, row)) {
      // Let the older transition finish first; this one goes next flush.
      await db.query("update jira_outbox set claimed_at = null, attempts = attempts - 1 where id = $1", [row.id]);
      continue;
    }
    try {
      const result = await deliver(jira, row.action, row.payload);
      await db.query("update jira_outbox set done_at = now(), error = null, claimed_at = null, result = $2::jsonb where id = $1",
        [row.id, JSON.stringify(result ?? {})]);
      sent++;
    } catch (e) {
      const message = String((e as Error).message ?? e);
      await db.query(
        `update jira_outbox set error = $2, claimed_at = null,
           next_attempt_at = now() + make_interval(secs => $3) where id = $1`,
        [row.id, message, 30 * 2 ** (row.attempts - 1)]);
      if (row.attempts >= MAX_ATTEMPTS) await gaveUp(db, row, message);
      failed++;
    }
  }
  return { sent, failed };
}

/** A newer transition for the same item makes this one moot. */
async function superseded(db: Db, row: any): Promise<boolean> {
  const newer = await db.query(
    "select 1 from jira_outbox where project = $3 and item_uid = $1 and action = 'transition' and id > $2 limit 1",
    [row.item_uid, row.id, row.project]);
  return newer.length > 0;
}

async function olderInFlight(db: Db, row: any): Promise<boolean> {
  const older = await db.query(
    `select 1 from jira_outbox where project = $4 and item_uid = $1 and action = 'transition' and id < $2 and done_at is null
        and claimed_at >= now() - make_interval(mins => $3) limit 1`, [row.item_uid, row.id, LEASE_MINUTES, row.project]);
  return older.length > 0;
}

async function gaveUp(db: Db, row: any, message: string): Promise<void> {
  await applyOps(db, row.project, [{
    op_id: `jira:gave-up:${row.id}`, op: "create", entity: "log", uid: ulid(), item_uid: row.item_uid,
    data: { text: `Jira ${row.action} for ${row.payload.key} gave up after ${MAX_ATTEMPTS} attempts: ${message}`, ts: nowIso() },
  }], { handle: "jira-bridge", unconditional: true, bridge: true });
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
    const who = p.author ?? "someone";
    const head = p.label === "QA rejected" ? `QA rejected — ${who} ${COMMENT_MARK}` : `${who} ${COMMENT_MARK}`;
    const res = await jira.call("POST", `/rest/api/3/issue/${key}/comment`, { body: textToAdf(`${head}:\n${p.text}`) });
    return { comment_id: res?.id ?? null };
  }
  if (action === "remotelink") {
    await jira.call("POST", `/rest/api/3/issue/${key}/remotelink`,
      { globalId: `todo:${p.global_id ?? p.url}`, object: { url: p.url, title: p.title } });
    return {};
  }
  throw new Error(`unknown action ${action}`);
}
