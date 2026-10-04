// Notifications are per-user read state, outside the synced op model.
import type { Db } from "./db";

export async function inbox(db: Db, handle: string, opts: { all?: boolean; since?: number } = {}) {
  const rows = await db.query(
    `select n.id, n.kind, n.project, n.created, n.read_at, n.note_uid, n.actor,
            i.id as item_id, i.title as item_title, i.status as item_status,
            n.item_uid, nt.n as note_n, nt.text as note_text, nt.author as note_author, nt.kind as note_kind, nt.meta as note_meta
       from notifications n
       join items i on i.uid = n.item_uid and i.project = n.project
       left join notes nt on nt.uid = n.note_uid and nt.project = n.project
      where n.handle = $1 and n.id > $2 ${opts.all ? "" : "and n.read_at is null"}
      order by (n.read_at is null) desc, n.id desc
      limit 200`,
    [handle, opts.since ?? 0]);
  const [c] = await db.query(
    "select count(*) filter (where read_at is null)::int as n, count(*)::int as total from notifications where handle = $1", [handle]);
  return { notifications: rows.map((r) => ({ ...r, id: Number(r.id) })), unread: Number(c.n), total: Number(c.total) };
}

export async function markRead(db: Db, handle: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.query(
    "update notifications set read_at = now() where handle = $1 and id = any($2::bigint[]) and read_at is null returning id",
    [handle, ids]);
  return rows.length;
}

/** Record a visit to an item: its notices are read, and the visit time kept.
 * Returns when the user last saw it (before now) — on a first visit, when its
 * oldest unread notice arrived — and the unread count left. */
export async function markSeen(db: Db, handle: string, project: string, itemUid: string):
    Promise<{ lastSeen: string | null; unread: number }> {
  const [prev] = await db.query(
    "select seen_at from item_seen where handle = $1 and project = $2 and item_uid = $3", [handle, project, itemUid]);
  let lastSeen: Date | null = prev?.seen_at ?? null;
  if (!prev) {
    // First visit: just before the oldest notice still pending, or read in the
    // last minute (opening a notice reads it before the page loads).
    const [n] = await db.query(
      `select min(created) as at from notifications where handle = $1 and project = $2 and item_uid = $3
          and (read_at is null or read_at > now() - interval '1 minute')`,
      [handle, project, itemUid]);
    lastSeen = n?.at ? new Date(new Date(n.at).getTime() - 1000) : null;
  }
  await db.query(
    "update notifications set read_at = now() where handle = $1 and project = $2 and item_uid = $3 and read_at is null",
    [handle, project, itemUid]);
  await db.query(
    `insert into item_seen (handle, project, item_uid, seen_at) values ($1, $2, $3, now())
     on conflict (handle, project, item_uid) do update set seen_at = excluded.seen_at`, [handle, project, itemUid]);
  const [c] = await db.query("select count(*)::int as n from notifications where handle = $1 and read_at is null", [handle]);
  return { lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null, unread: Number(c.n) };
}

/** Notices that ask something of you; the rest are for your information. */
export const NEEDS_YOU = ["qa-rejection", "clarification", "ready-for-qa", "mention"];

export interface InboxGroup {
  key: string;
  project: string;
  item_uid: string;
  item_id: string;
  title: string;
  status: string;
  newest: number;
  notices: Record<string, any>[];
}

/** Whether the ticket has moved past what the notice asked for. */
export function settled(n: Record<string, any>): boolean {
  if (n.kind === "ready-for-qa") return n.item_status !== "ready-for-qa";
  if (n.kind === "qa-rejection") return n.item_status !== "qa-rejected";
  if (n.kind === "clarification") return n.note_meta?.state === "answered";
  return false;
}

/** Notices grouped by ticket, newest ticket first, split into what needs you
 * and what's for your information. */
export function groupInbox(rows: Record<string, any>[]): { needs: InboxGroup[]; fyi: InboxGroup[] } {
  const split = { needs: new Map<string, InboxGroup>(), fyi: new Map<string, InboxGroup>() };
  for (const n of rows) {
    const side = NEEDS_YOU.includes(n.kind) ? split.needs : split.fyi;
    const key = `${n.project}/${n.item_uid}`;
    const at = new Date(n.created).getTime();
    let g = side.get(key);
    if (!g) {
      g = { key, project: n.project, item_uid: n.item_uid, item_id: n.item_id, title: n.item_title, status: n.item_status, newest: at, notices: [] };
      side.set(key, g);
    }
    g.newest = Math.max(g.newest, at);
    g.notices.push({ ...n, settled: settled(n) });
  }
  const order = (m: Map<string, InboxGroup>) => [...m.values()]
    .map((g) => ({ ...g, notices: g.notices.sort((a, b) => b.id - a.id) }))
    .sort((a, b) => b.newest - a.newest);
  return { needs: order(split.needs), fyi: order(split.fyi) };
}
