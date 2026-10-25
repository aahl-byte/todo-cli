import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { item, world, type World } from "./helpers";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const act = await import("@/app/doc-actions");
const { POST: filePOST } = await import("@/app/api/files/[...key]/route");
const { listDocs } = await import("@/lib/docs");
const { readLocal } = await import("@/lib/files");

let w: World;
let dir: string;
beforeEach(async () => {
  w = await world();
  dir = mkdtempSync(path.join(tmpdir(), "doc-actions-"));
  process.env.TODO_FILES_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.VERCEL;
  await w.apply("alice", item("I1"));
  jar.clear();
  jar.set("todo_token", w.tokens.alice);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What the Docs section does: ask for a target, send the bytes there, record them. */
async function upload(name: string, body: string, base: string | null) {
  const target = await act.docUploadTarget({ project: "p", itemUid: "I1", name, size: body.length });
  if (!target.ok) return target;
  const fd = new FormData();
  for (const [k, v] of Object.entries(target.fields ?? {})) fd.append(k, v);
  fd.append("file", new File([body], name));
  const sent = await filePOST(new Request(`http://x${target.url}`, { method: "POST", headers: { authorization: `Bearer ${w.tokens.alice}` }, body: fd }),
    { params: Promise.resolve({ key: target.key!.split("/") }) });
  expect(sent.status).toBe(204);
  return act.saveDoc({ project: "p", itemUid: "I1", name, key: target.key!, base });
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("doc actions", () => {
  it("upload, replace and delete a doc from the dashboard", async () => {
    expect((await upload("plan.md", "v1", null)).ok).toBe(true);
    const [doc] = await listDocs(w.d, "p", "I1");
    expect(doc).toMatchObject({ name: "plan.md", by: "alice", sha256: sha("v1") });
    expect((await upload("plan.md", "v2", doc.sha256)).ok).toBe(true);
    const [next] = await listDocs(w.d, "p", "I1");
    expect(next.sha256).toBe(sha("v2"));
    expect(await readLocal(doc.file_key)).toBeNull();
    expect((await act.deleteDoc({ project: "p", uid: next.uid, name: "plan.md", base: next.sha256 })).ok).toBe(true);
    expect(await listDocs(w.d, "p", "I1")).toEqual([]);
  });

  it("say why a write was refused", async () => {
    await upload("plan.md", "v1", null);
    const stale = await upload("plan.md", "v2", sha("something older"));
    expect(stale).toMatchObject({ ok: false, message: expect.stringContaining("changed since this page loaded") });
    const twin = await upload("PLAN.md", "x", null);
    expect(twin).toMatchObject({ ok: false, message: expect.stringContaining("plan.md") });
    expect(await act.docUploadTarget({ project: "p", itemUid: "I1", name: "con.md", size: 1 })).toMatchObject({ ok: false });
    const [doc] = await listDocs(w.d, "p", "I1");
    expect((await act.deleteDoc({ project: "p", uid: doc.uid, name: "plan.md", base: "stale" })).ok).toBe(false);
  });
});
