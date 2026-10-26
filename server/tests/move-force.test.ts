import { beforeEach, describe, expect, it, vi } from "vitest";
import { item, world, type World } from "./helpers";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const act = await import("@/app/item-actions");
const { itemWaits } = await import("@/lib/views");

let w: World;
beforeEach(async () => {
  w = await world();
  vi.stubEnv("GITHUB_TOKEN", "");
  jar.clear();
  jar.set("todo_token", w.tokens.alice);
  await w.one("alice", item("B", { id: "b", status: "qa-approved" }));
  await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'B', $1::jsonb, 'server')",
    [JSON.stringify({ needs: [{ id: "a", branch: "feat/a", state: "waiting", source: "git", evidence: "feat/b's PR is based on feat/a" }], waits_on: ["a"] })]);
});

const versions = async () => (await w.d.query("select versions from items where uid = 'B'"))[0].versions;

describe("staging past a dependency from the dashboard", () => {
  it("answers a refused stage with each edge it waits on", async () => {
    const r = await act.moveItem({ project: "p", uid: "B", versions: await versions(), to: "ready-to-deploy" });
    expect(r.ok).toBe(false);
    expect(r.waits).toEqual([{ item: "a", needs: null, branch: "feat/a", state: "waiting", why: "feat/b's PR is based on feat/a" }]);
  });

  it("stages anyway with force, and history records it forced", async () => {
    const r = await act.moveItem({ project: "p", uid: "B", versions: await versions(), to: "ready-to-deploy", force: true });
    expect(r.ok).toBe(true);
    const [h] = await w.d.query("select to_status, forced from status_history where item_uid = 'B' order by n desc limit 1");
    expect(h).toEqual({ to_status: "ready-to-deploy", forced: true });
  });

  it("lists what a stage would wait on before it's tried", async () => {
    expect(await itemWaits(w.d, "p", "B")).toEqual([
      { item: "a", needs: null, branch: "feat/a", state: "waiting", why: "feat/b's PR is based on feat/a" }]);
  });
});
