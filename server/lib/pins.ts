// Pinned items are per-user, outside the synced op model.
import type { Db } from "./db";
import { cards, type Card } from "./views";

/** The user's pinned items in a project as board cards, in pin order. */
export async function pins(db: Db, handle: string, project: string): Promise<Card[]> {
  const order = (await db.query(
    "select item_uid from item_pins where handle = $1 and project = $2 order by pinned_at, item_uid",
    [handle, project])).map((r) => r.item_uid as string);
  if (!order.length) return [];
  const rows = await cards(db, project, "and i.uid = any($2)", [order], handle);
  return rows.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
}

export async function isPinned(db: Db, handle: string, project: string, itemUid: string): Promise<boolean> {
  const rows = await db.query(
    "select 1 from item_pins where handle = $1 and project = $2 and item_uid = $3", [handle, project, itemUid]);
  return rows.length > 0;
}

export async function setPinned(db: Db, handle: string, project: string, itemUid: string, on: boolean): Promise<void> {
  if (on) {
    await db.query(
      `insert into item_pins (handle, project, item_uid) values ($1, $2, $3)
       on conflict (handle, project, item_uid) do nothing`, [handle, project, itemUid]);
  } else {
    await db.query("delete from item_pins where handle = $1 and project = $2 and item_uid = $3", [handle, project, itemUid]);
  }
}
