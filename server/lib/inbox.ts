// Notifications are per-user read state, outside the synced op model.
import type { Db } from "./db";

export async function inbox(db: Db, handle: string, opts: { all?: boolean; since?: number } = {}) {
  const rows = await db.query(
    `select n.id, n.kind, n.project, n.created, n.read_at, n.note_uid,
            i.id as item_id, i.title as item_title, i.status as item_status,
            nt.n as note_n, nt.text as note_text, nt.author as note_author
       from notifications n
       join items i on i.uid = n.item_uid
       left join notes nt on nt.uid = n.note_uid
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
