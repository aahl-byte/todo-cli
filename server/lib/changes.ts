import type { Db, Row } from "./db";
import { TABLE } from "./model";

export interface Change {
  seq: number;
  entity: string;
  uid: string;
  item_uid: string;
  deleted: boolean;
  data: Row | null;
}

/** Changes after `since`, each carrying its entity's current row. A uid that
 * changed more than once in the page appears once, at its first position, so
 * an item always precedes the children created after it. */
export async function changesSince(db: Db, project: string, since: number, limit = 500):
    Promise<{ changes: Change[]; cursor: number; more: boolean }> {
  const rows = await db.query(
    "select seq, entity, uid, item_uid, deleted from changes where project = $1 and seq > $2 order by seq limit $3",
    [project, since, limit]);
  const latest = new Map<string, Row>();
  for (const r of rows) {
    const seen = latest.get(r.uid);
    latest.set(r.uid, seen ? { ...seen, seq: r.seq, deleted: r.deleted } : r);
  }
  const changes: Change[] = [];
  for (const r of latest.values()) {
    const table = TABLE[r.entity as keyof typeof TABLE];
    const [data] = await db.query(`select * from ${table} where uid = $1 and project = $2`, [r.uid, project]);
    changes.push({
      seq: Number(r.seq), entity: r.entity, uid: r.uid, item_uid: r.item_uid,
      deleted: !data, data: data ? clean(data) : null,
    });
  }
  return {
    changes,
    cursor: rows.length ? Number(rows[rows.length - 1].seq) : since,
    more: rows.length === limit,
  };
}

function clean(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
}
