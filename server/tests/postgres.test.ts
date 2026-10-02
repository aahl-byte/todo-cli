// Runs against a real Postgres when TEST_DATABASE_URL is set; PGlite serializes
// every transaction, so only this exercises the FOR UPDATE row lock.
import { describe, expect, it } from "vitest";
import { applyOps } from "@/lib/apply";
import { addProject } from "@/lib/auth";
import { migrate } from "@/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("real postgres", () => {
  it("applies a concurrently pushed op once and keeps seqs gapless", async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const wrap = {
      query: async (sql: string, p?: unknown[]) => (await pool.query(sql, p)).rows,
      exec: async (sql: string) => void (await pool.query(sql)),
      tx: async <T>(fn: (x: any) => Promise<T>) => {
        const c = await pool.connect();
        const inner = { query: async (s: string, p?: unknown[]) => (await c.query(s, p)).rows,
                        exec: async (s: string) => void (await c.query(s)), tx: (f: any) => f(inner) };
        try { await c.query("begin"); const out = await fn(inner); await c.query("commit"); return out; }
        catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
      },
    };
    const project = `pg${Date.now()}`;
    await migrate(wrap as any);
    await addProject(wrap as any, project);
    const op = { op_id: `${project}-op`, op: "create", entity: "item", uid: `${project}-I`, item_uid: `${project}-I`,
                 data: { id: "x", title: "x" } } as any;
    const results = await Promise.all([1, 2, 3].map(() => applyOps(wrap as any, project, [op], { handle: "t" })));
    expect(results.filter((r) => !r[0].duplicate)).toHaveLength(1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => applyOps(wrap as any, project, [{
      op_id: `${project}-t${i}`, op: "create", entity: "task", uid: `${project}-T${i}`, item_uid: `${project}-I`,
      data: { n: i + 1, title: `t${i}` } } as any], { handle: "t" })));
    const seqs = (await wrap.query("select seq from changes where project = $1 order by seq", [project])).map((r: any) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
    await pool.end();
  });
});
