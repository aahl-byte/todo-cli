import type { Db, Row } from "./db";
import { clean as cleanDoc } from "./docs";
import { TABLE } from "./model";

export interface Change {
  seq: number;
  entity: string;
  uid: string;
  item_uid: string;
  deleted: boolean;
  data: Row | null;
  /** For a deleted doc: its last content's sha256. */
  last_sha256?: string;
  /** For a deleted note: a plugin run removed it, rather than a person. */
  by_plugin?: boolean;
}

const TABLES: Record<string, string> = { ...TABLE, doc: "docs" };

/** Changes after `since`, each carrying its entity's current row. A uid that
 * changed more than once in the page appears once, at its first position, so
 * an item always precedes the children created after it. Doc changes come
 * only to a client that asks for them with `docs`. */
export async function changesSince(db: Db, project: string, since: number, limit = 500, docs = false):
    Promise<{ changes: Change[]; cursor: number; more: boolean }> {
  const rows = await db.query(
    `select seq, entity, uid, item_uid, deleted from changes where project = $1 and seq > $2 ${docs ? "" : "and entity <> 'doc'"}
      order by seq limit $3`,
    [project, since, limit]);
  const latest = new Map<string, Row>();
  for (const r of rows) {
    const seen = latest.get(r.uid);
    latest.set(r.uid, seen ? { ...seen, seq: r.seq, deleted: r.deleted } : r);
  }
  const changes: Change[] = [];
  for (const r of latest.values()) {
    const table = TABLES[r.entity];
    const [data] = await db.query(`select * from ${table} where uid = $1 and project = $2`, [r.uid, project]);
    const change: Change = {
      seq: Number(r.seq), entity: r.entity, uid: r.uid, item_uid: r.item_uid,
      deleted: !data, data: !data ? null : r.entity === "doc" ? cleanDoc(data) : clean(data),
    };
    if (!data && r.entity === "doc") {
      const [tomb] = await db.query("select sha256 from doc_tombstones where project = $1 and uid = $2", [project, r.uid]);
      if (tomb) change.last_sha256 = tomb.sha256;
    }
    if (!data && r.entity === "note") {
      const [tomb] = await db.query("select by_plugin from tombstones where project = $1 and uid = $2", [project, r.uid]);
      change.by_plugin = !!tomb?.by_plugin;
    }
    changes.push(change);
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
