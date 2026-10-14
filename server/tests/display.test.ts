import { beforeEach, describe, expect, it, vi } from "vitest";
import { addProject } from "@/lib/auth";
import { addDisplay, displayFor, displays, removeDisplay } from "@/lib/display";

const displayOpens = async (...a: Parameters<typeof displayFor>) => !!(await displayFor(...a));
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveLocal } from "@/lib/files";
import { world, type World } from "./helpers";

const { GET: enroll } = await import("@/app/display/[key]/enroll/route");
const { GET: displayFile } = await import("@/app/display/[key]/files/[...file]/route");

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));

let w: World;
beforeEach(async () => {
  w = await world();
  jar.clear();
  await addProject(w.d, "q");
});

const enrollWith = (project: string, key: string, proto = "https") =>
  enroll(new Request(`http://127.0.0.1/display/${project}/enroll?key=${key}`, { headers: { "x-forwarded-proto": proto } }),
         { params: Promise.resolve({ key: project }) });

describe("display keys", () => {
  it("open only their own project's display", async () => {
    const key = await addDisplay(w.d, "p", "tablet");
    expect(await displayOpens(w.d, "p", key)).toBe(true);
    expect(await displayOpens(w.d, "q", key)).toBe(false);
  });

  it("remember who set them up", async () => {
    const key = await addDisplay(w.d, "p", "tablet", "alice");
    expect(await displayFor(w.d, "p", key)).toEqual({ handle: "alice" });
  });

  it("don't accept a user's sign-in token", async () => {
    expect(await displayOpens(w.d, "p", w.tokens.alice)).toBe(false);
  });

  it("stop working when replaced or removed", async () => {
    const old = await addDisplay(w.d, "p", "tablet");
    const key = await addDisplay(w.d, "p", "tablet");
    expect(await displayOpens(w.d, "p", old)).toBe(false);
    expect(await removeDisplay(w.d, "p", "tablet")).toBe(true);
    expect(await displayOpens(w.d, "p", key)).toBe(false);
  });

  it("list with when each was last opened", async () => {
    const key = await addDisplay(w.d, "p", "tablet");
    await addDisplay(w.d, "q", "hall");
    await displayOpens(w.d, "p", key);
    const rows = await displays(w.d);
    expect(rows.map((r) => [r.project, r.label, !!r.last_seen])).toEqual([["p", "tablet", true], ["q", "hall", false]]);
  });

  it("enroll sets a display-scoped cookie and drops the key from the URL", async () => {
    const key = await addDisplay(w.d, "p", "tablet");
    const res = await enrollWith("p", key);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/display/p");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^todo_display=${key}; Path=/display/; Max-Age=\\d+; HttpOnly; SameSite=Lax; Secure$`));
    expect((await enrollWith("p", key, "http")).headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("enroll refuses a key for another project", async () => {
    const key = await addDisplay(w.d, "q", "tablet");
    const res = await enrollWith("p", key);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("serve their own project's images, and only with the display's key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "display-files-"));
    process.env.TODO_FILES_DIR = dir;
    delete process.env.S3_BUCKET;
    const mine = "p/I1/01JA0000000000000000000000.png", theirs = "q/I1/01JA0000000000000000000000.png";
    await saveLocal(mine, new Uint8Array([1, 2, 3]));
    await saveLocal(theirs, new Uint8Array([4]));
    const get = (key: string) => displayFile(new Request("http://x"), { params: Promise.resolve({ key: "p", file: key.split("/") }) });
    expect((await get(mine)).status).toBe(401);
    jar.set("todo_display", w.tokens.alice);
    expect((await get(mine)).status).toBe(401);
    jar.set("todo_display", await addDisplay(w.d, "p", "tablet"));
    const ok = await get(mine);
    expect(ok.status).toBe(200);
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await get(theirs)).status).toBe(404);
  });
});
