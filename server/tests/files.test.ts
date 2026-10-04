import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as askPOST } from "@/app/api/files/route";
import { GET as fileGET, POST as filePOST } from "@/app/api/files/[...key]/route";
import { world, type World } from "./helpers";

let w: World;
let dir: string;
beforeEach(async () => {
  w = await world();
  dir = mkdtempSync(path.join(tmpdir(), "files-"));
  process.env.TODO_FILES_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.VERCEL;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TODO_FILES_DIR;
  delete process.env.VERCEL;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const auth = (token: string | null) => (token ? { authorization: `Bearer ${token}` } : {});
const ask = (token: string | null, body: unknown) =>
  askPOST(new Request("http://x/api/files", { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(body) }));
const keyParams = (key: string) => ({ params: Promise.resolve({ key: key.split("/") }) });
const send = (token: string, key: string, file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  return filePOST(new Request(`http://x/api/files/${key}`, { method: "POST", headers: auth(token), body: fd }), keyParams(key));
};

describe("files", () => {
  it("uploads to the local store and reads back with a safe content type", async () => {
    const t = w.tokens.alice;
    const r = await ask(t, { project: "p", scope: "I1", type: "image/png", size: PNG.length });
    expect(r.status).toBe(200);
    const { key, url, fields } = await r.json();
    expect(key).toMatch(/^p\/I1\/[0-9A-Z]{26}\.png$/);
    expect([url, fields]).toEqual([`/api/files/${key}`, {}]);
    expect((await send(t, key, new File([PNG], "a.png", { type: "image/png" }))).status).toBe(204);
    const got = await fileGET(new Request(`http://x/api/files/${key}`, { headers: auth(t) }), keyParams(key));
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  it("refuses bad types, sizes, keys and strangers", async () => {
    const t = w.tokens.alice;
    expect((await ask(t, { project: "p", type: "image/svg+xml", size: 10 })).status).toBe(415);
    expect((await ask(t, { project: "p", type: "image/png", size: 11 * 1024 * 1024 })).status).toBe(413);
    expect((await ask(null, { project: "p", type: "image/png", size: 10 })).status).toBe(401);
    const { key } = await (await ask(t, { project: "p", type: "image/png", size: 10 })).json();
    expect((await send(t, key, new File(["<svg/>"], "a.png", { type: "image/svg+xml" }))).status).toBe(415);
    expect((await fileGET(new Request(`http://x/api/files/${key}`), keyParams(key))).status).toBe(401);
    expect((await fileGET(new Request("http://x/api/files/x", { headers: auth(t) }), keyParams("../../etc/passwd"))).status).toBe(404);
  });

  it("keeps uploads off on Vercel until S3 is set", async () => {
    process.env.VERCEL = "1";
    expect((await ask(w.tokens.alice, { project: "p", type: "image/png", size: 10 })).status).toBe(501);
  });
});
