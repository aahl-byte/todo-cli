// Pinned items are per-user, outside the synced op model.
import type { Db } from "./db";

export interface Pin {
  uid: string;
  id: string;
  title: string;
  status: string;
}

/** The user's pins in a project, oldest first. */
export async function pins(db: Db, handle: string, project: string): Promise<Pin[]> {
  return db.query(
    `select i.uid, i.id, i.title, i.status from item_pins p
       join items i on i.project = p.project and i.uid = p.item_uid
      where p.handle = $1 and p.project = $2
      order by p.pinned_at, i.id`, [handle, project]) as Promise<Pin[]>;
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
