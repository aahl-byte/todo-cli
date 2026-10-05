import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world, type World } from "./helpers";

// An in-memory bucket standing in for S3.
const bucket = new Map<string, { body: Uint8Array; type?: string }>();
vi.mock("@aws-sdk/client-s3", () => {
  class Cmd { constructor(public input: any) {} }
  class PutObjectCommand extends Cmd {}
  class GetObjectCommand extends Cmd {}
  class HeadObjectCommand extends Cmd {}
  class S3Client {
    async send(c: Cmd) {
      const { Key, Body, ContentType } = c.input;
      if (c instanceof PutObjectCommand) { bucket.set(Key, { body: Body, type: ContentType }); return {}; }
      const hit = bucket.get(Key);
      if (!hit) throw Object.assign(new Error("missing"), { name: c instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey" });
      return c instanceof GetObjectCommand ? { Body: { transformToByteArray: async () => hit.body } } : {};
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand };
});

const { POST: askPOST } = await import("@/app/api/files/route");
const { GET: fileGET, POST: filePOST } = await import("@/app/api/files/[...key]/route");

let w: World;
beforeEach(async () => {
  w = await world();
  bucket.clear();
  Object.assign(process.env, { S3_BUCKET: "b", S3_REGION: "us-east-1", S3_PROXY: "1" });
});
afterEach(() => { for (const k of ["S3_BUCKET", "S3_REGION", "S3_PROXY"]) delete process.env[k]; });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const params = (key: string) => ({ params: Promise.resolve({ key: key.split("/") }) });

describe("files through the app (S3_PROXY)", () => {
  it("takes the upload and serves the bytes itself, with no S3 URL reaching the browser", async () => {
    const t = w.tokens.alice;
    const r = await askPOST(new Request("http://x/api/files", { method: "POST", headers: { ...auth(t), "content-type": "application/json" },
      body: JSON.stringify({ project: "p", scope: "I1", type: "image/png", size: PNG.length }) }));
    const { key, url, fields } = await r.json();
    expect(url).toBe(`/api/files/${key}`);
    expect(fields).toEqual({});
    const fd = new FormData();
    fd.append("file", new File([PNG], "a.png", { type: "image/png" }));
    expect((await filePOST(new Request(`http://x${url}`, { method: "POST", headers: auth(t), body: fd }), params(key))).status).toBe(204);
    expect(bucket.get(key)?.type).toBe("image/png");
    const again = new FormData();
    again.append("file", new File([PNG], "a.png", { type: "image/png" }));
    expect((await filePOST(new Request(`http://x${url}`, { method: "POST", headers: auth(t), body: again }), params(key))).status).toBe(409);
    const got = await fileGET(new Request(`http://x${url}`, { headers: auth(t) }), params(key));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    const missing = key.replace(/[0-9A-Z]{26}/, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect((await fileGET(new Request(`http://x/api/files/${missing}`, { headers: auth(t) }), params(missing))).status).toBe(404);
  });
});
