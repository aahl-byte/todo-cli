import { migrate, pglite, setDb, type Db } from "@/lib/db";
import { addProject, addUser } from "@/lib/auth";
import { applyOps, type Actor, type Op, type Result } from "@/lib/apply";
import { ulid } from "@/lib/ulid";

export interface World {
  d: Db;
  tokens: Record<string, string>;
  apply(who: string | Actor, ...ops: Partial<Op>[]): Promise<Result[]>;
  one(who: string | Actor, op: Partial<Op>): Promise<Result>;
}

let shared: Db | null = null;

const TABLES = ["notifications", "jira_outbox", "jira_links", "applied_ops", "tombstones", "changes",
  "status_history", "checks", "logs", "notes", "tasks", "items", "projects", "users"];

/** A clean database: one PGlite per test file, emptied before each test. */
export async function world(): Promise<World> {
  if (!shared) {
    shared = await pglite();
    await migrate(shared);
  }
  const d = shared;
  await d.exec(`truncate ${TABLES.join(", ")} restart identity cascade`);
  setDb(d);
  const tokens: Record<string, string> = {};
  for (const h of ["alice", "bob", "carol"]) tokens[h] = await addUser(d, h);
  await addProject(d, "p");
  const apply = (who: string | Actor, ...ops: Partial<Op>[]) =>
    applyOps(d, "p", ops.map((o) => ({ op_id: ulid(), ...o }) as Op),
      typeof who === "string" ? { handle: who } : who);
  return { d, tokens, apply, one: async (who, op) => (await apply(who, op))[0] };
}

export function item(uid: string, data: Record<string, unknown> = {}): Partial<Op> {
  return { op: "create", entity: "item", uid, item_uid: uid,
           data: { id: uid, title: `Item ${uid}`, created: "2026-10-02T00:00:00.000Z", ...data } };
}

export function child(entity: Op["entity"], uid: string, itemUid: string, data: Record<string, unknown>): Partial<Op> {
  return { op: "create", entity, uid, item_uid: itemUid, data };
}

export function set(entity: Op["entity"], uid: string, itemUid: string, data: Record<string, unknown>,
                    base: Record<string, number> = {}, extra: Partial<Op> = {}): Partial<Op> {
  return { op: "set", entity, uid, item_uid: itemUid, data, base, ...extra };
}
