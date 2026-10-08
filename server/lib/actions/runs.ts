// The action_runs outbox: a status move or a manual run queues a row in the
// same transaction, and flushActions delivers it after the request. A row is
// leased while in flight, backs off on failure, and logs its outcome once.
import type { Db } from "../db";
import { applyOps } from "../apply";
import { nowIso } from "../model";
import { ulid } from "../ulid";
import { deliver, type Fetch } from "./deliver";
import { firesOn, itemVars, render, storedActions, type ActionDef, type ItemLike } from "./model";

export const MAX_ATTEMPTS = 4;
const LEASE_MINUTES = 5;

export async function projectActions(t: Db, project: string): Promise<ActionDef[]> {
  const [p] = await t.query("select actions from projects where key = $1", [project]);
  return storedActions(p?.actions);
}

async function queue(t: Db, project: string, itemUid: string, a: ActionDef, from: string, actor: string, trigger: string): Promise<number | null> {
  const [it] = await t.query("select * from items where project = $1 and uid = $2", [project, itemUid]);
  if (!it) return null;
  const request = render(a, itemVars(project, it as ItemLike, from, actor, process.env.PUBLIC_URL ?? ""));
  const [row] = await t.query(
    `insert into action_runs (project, item_uid, action_id, name, trigger, by, request) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning id`, [project, itemUid, a.id, a.name, trigger, actor, JSON.stringify(request)]);
  return Number(row.id);
}

/** Queue every server Action a status move fires. */
export async function queueAutoActions(t: Db, project: string, itemUid: string, from: string, to: string, actor: string) {
  for (const a of await projectActions(t, project)) {
    if (a.runner === "server" && firesOn(a, from, to)) await queue(t, project, itemUid, a, from, actor, `${from} → ${to}`);
  }
}

export async function queueManualAction(t: Db, project: string, itemUid: string, a: ActionDef, actor: string): Promise<number | null> {
  return queue(t, project, itemUid, a, "", actor, "manual");
}

export interface RunState { done: boolean; ok: boolean; message: string }

/** Where a run stands: delivered, given up, or still due a retry. */
export async function runState(db: Db, id: number): Promise<RunState> {
  const [r] = await db.query("select done_at, error, result, attempts from action_runs where id = $1", [id]);
  if (!r) return { done: true, ok: false, message: "No such run." };
  if (r.done_at && !r.error) return { done: true, ok: true, message: r.result?.summary ?? "sent" };
  if (r.done_at) return { done: true, ok: false, message: `gave up: ${r.error}` };
  return { done: false, ok: false, message: r.error ? `failed, will retry: ${r.error}` : "queued" };
}

async function logLine(db: Db, row: any, text: string) {
  await applyOps(db, row.project, [{
    op_id: `action:${row.id}`, op: "create", entity: "log", uid: ulid(), item_uid: row.item_uid, data: { text, ts: nowIso() },
  }], { handle: row.by, unconditional: true, bridge: true });
}

export async function flushActions(db: Db, f?: Fetch): Promise<{ sent: number; failed: number }> {
  const crashed = await db.query(
    `update action_runs set claimed_at = null, done_at = now(), error = coalesce(error, 'the process stopped during the last attempt')
      where done_at is null and attempts >= $1 and claimed_at < now() - make_interval(mins => $2)
      returning *`, [MAX_ATTEMPTS, LEASE_MINUTES]);
  for (const row of crashed) await logLine(db, row, `action ${row.name} gave up: ${row.error}`);
  const due = await db.query(
    `select id from action_runs
      where done_at is null and attempts < $1 and (next_attempt_at is null or next_attempt_at <= now())
        and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
      order by id limit 20`, [MAX_ATTEMPTS, LEASE_MINUTES]);
  let sent = 0;
  let failed = 0;
  for (const { id } of due) {
    const [row] = await db.query(
      `update action_runs set attempts = attempts + 1, claimed_at = now()
        where id = $1 and done_at is null and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
        returning *`, [id, LEASE_MINUTES]);
    if (!row) continue;
    try {
      const outcome = await deliver(row.request, f);
      await db.query("update action_runs set done_at = now(), claimed_at = null, error = null, result = $2::jsonb where id = $1",
        [row.id, JSON.stringify({ summary: outcome.summary, ...outcome.detail })]);
      await logLine(db, row, `action ${row.name} (${row.trigger}): ${outcome.summary}`);
      sent++;
    } catch (e) {
      const message = String((e as Error).message ?? e);
      const last = row.attempts >= MAX_ATTEMPTS;
      await db.query(
        `update action_runs set error = $2, claimed_at = null, done_at = case when $4 then now() end,
           next_attempt_at = now() + make_interval(secs => $3) where id = $1`,
        [row.id, message, 30 * 2 ** (row.attempts - 1), last]);
      if (last) await logLine(db, row, `action ${row.name} (${row.trigger}) gave up after ${MAX_ATTEMPTS} attempts: ${message}`);
      failed++;
    }
  }
  return { sent, failed };
}

export interface RecentRun { id: number; at: string; name: string; itemId: string; trigger: string; by: string; state: string; message: string | null }

export async function recentRuns(db: Db, project: string, limit = 15): Promise<RecentRun[]> {
  const rows = await db.query(
    `select r.*, i.id as item_id from action_runs r join items i on i.project = r.project and i.uid = r.item_uid
      where r.project = $1 order by r.id desc limit $2`, [project, limit]);
  return rows.map((r) => ({
    id: Number(r.id), at: new Date(r.created).toISOString(), name: r.name, itemId: r.item_id, trigger: r.trigger, by: r.by,
    state: r.done_at ? (r.error ? "gave up" : "sent") : r.error ? "failed" : "queued",
    message: r.error ?? r.result?.summary ?? null,
  }));
}
