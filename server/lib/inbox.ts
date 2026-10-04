// Notifications are per-user read state, outside the synced op model.
import type { Db } from "./db";

export async function inbox(db: Db, handle: string, opts: { all?: boolean; since?: number } = {}) {
  const rows = await db.query(
    `select n.id, n.kind, n.project, n.created, n.read_at, n.note_uid, n.actor,
            i.id as item_id, i.title as item_title, i.status as item_status,
            nt.n as note_n, nt.text as note_text, nt.author as note_author
       from notifications n
       join items i on i.uid = n.item_uid and i.project = n.project
       left join notes nt on nt.uid = n.note_uid and nt.project = n.project
      where n.handle = $1 and n.id > $2 ${opts.all ? "" : "and n.read_at is null"}
      order by (n.read_at is null) desc, n.id desc
      limit 200`,
    [handle, opts.since ?? 0]);
  const [c] = await db.query(
    "select count(*)::int as n from notifications where handle = $1 and read_at is null", [handle]);
  return { notifications: rows.map((r) => ({ ...r, id: Number(r.id) })), unread: Number(c.n) };
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
  if (!lastSeen) {
    const [n] = await db.query(
      `select min(created) as at from notifications where handle = $1 and project = $2 and item_uid = $3 and read_at is null`,
      [handle, project, itemUid]);
    // Just before the oldest notice, so the note it's about counts as new.
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
