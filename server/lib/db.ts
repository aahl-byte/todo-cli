// One query interface over node-postgres (production, DATABASE_URL) or PGlite
// (tests and local dev, TODO_PGLITE=memory|<dir>).
import { SCHEMA } from "./schema";

export type Row = Record<string, any>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close?(): Promise<void>;
}

// Next bundles route handlers and server components separately, so a module
// variable would give each its own connection — and PGlite would open the same
// data directory twice. One shared slot on globalThis keeps a single instance.
const slot = globalThis as typeof globalThis & { __todoDb?: Promise<Db> | null };

export function db(): Promise<Db> {
  if (!slot.__todoDb) slot.__todoDb = open();
  return slot.__todoDb;
}

/** Swap the shared connection, e.g. a fresh PGlite per test. */
export function setDb(next: Db | null): void {
  slot.__todoDb = next ? Promise.resolve(next) : null;
}

async function open(): Promise<Db> {
  const lite = process.env.TODO_PGLITE;
  if (lite) {
    const d = await pglite(lite === "memory" ? undefined : lite);
    await migrate(d);
    return d;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return pgPool(process.env.DATABASE_URL);
}

export async function pglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  let chain: Promise<unknown> = Promise.resolve();
  // PGlite runs one transaction at a time; serialize them so concurrent
  // requests queue instead of interleaving.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const wrap = (q: { query: typeof pg.query; exec: typeof pg.exec }): Db => ({
    query: async (sql, params) => (await q.query(sql, params as any[])).rows as any[],
    exec: async (sql) => void (await q.exec(sql)),
    tx: (fn) => fn(wrap(q)),
  });
  return {
    query: (sql, params) => serial(async () => (await pg.query(sql, params as any[])).rows as any[]),
    exec: (sql) => serial(async () => void (await pg.exec(sql))),
    tx: (fn) => serial(() => pg.transaction((t) => fn(wrap(t as any)))),
    close: () => serial(() => pg.close()),
  };
}

async function pgPool(url: string): Promise<Db> {
  const { Pool } = (await import("pg")).default;
  const pool = new Pool({ connectionString: url, max: 5 });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Db => ({
    query: async (sql, params) => (await c.query(sql, params)).rows,
    exec: async (sql) => void (await c.query(sql)),
    tx: (fn) => fn(wrap(c)),
  });
  return {
    ...wrap(pool),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export async function migrate(d: Db): Promise<void> {
  await d.exec(SCHEMA);
  const { backfillRequestVersions } = await import("./apply");
  await backfillRequestVersions(d);
}
