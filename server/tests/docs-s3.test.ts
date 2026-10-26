import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { item, world, type World } from "./helpers";

// S3 reached directly: uploads go to the bucket by presigned POST, reads redirect to it.
const posts: any[] = [];
vi.mock("@aws-sdk/client-s3", () => {
  class Cmd { constructor(public input: any) {} }
  class S3Client { async send() { return {}; } }
  return { S3Client, PutObjectCommand: Cmd, GetObjectCommand: Cmd, HeadObjectCommand: Cmd, DeleteObjectCommand: Cmd };
});
vi.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: async (_c: unknown, opts: any) => { posts.push(opts); return { url: "https://bucket.test/", fields: { key: opts.Key } }; },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_c: unknown, cmd: any) => `https://bucket.test/${cmd.input.Key}?disposition=${encodeURIComponent(cmd.input.ResponseContentDisposition ?? "")}`,
}));

const { docType, uploadTarget, newDocKey, newKey } = await import("@/lib/files");
const { GET: docGET } = await import("@/app/api/projects/[key]/docs/[uid]/route");
const { docUid } = await import("@/lib/docs");

let w: World;
beforeEach(async () => {
  w = await world();
  posts.length = 0;
  Object.assign(process.env, { S3_BUCKET: "b", S3_REGION: "us-east-1" });
  delete process.env.S3_PROXY;
  await w.apply("alice", item("I1"));
});
afterEach(() => { for (const k of ["S3_BUCKET", "S3_REGION"]) delete process.env[k]; });

async function seed(name: string) {
  const uid = docUid("I1", name);
  await w.d.query(
    `insert into docs (project, uid, item_uid, name, name_key, size, sha256, file_key, content_type, by, via, at)
     values ('p', $1, 'I1', $2, $2, 1, 'x', $3, $4, 'alice', 'human', '2026-10-23')`, [uid, name, newDocKey("p", name), docType(name)]);
  return uid;
}

describe("docs on direct S3", () => {
  it("presign a doc upload for any size up to 25 MB, of the type its name gives", async () => {
    await uploadTarget(newDocKey("p", "plan.md"), "text/markdown");
    expect(posts[0].Conditions).toEqual([["content-length-range", 0, 25 * 1024 * 1024], ["eq", "$Content-Type", "text/markdown"]]);
    await uploadTarget(newKey("p", "I1", "image/png")!, "image/png");
    expect(posts[1].Conditions).toEqual([["content-length-range", 1, 10 * 1024 * 1024], ["eq", "$Content-Type", "image/png"]]);
  });

  it("send HTML, SVG and XML from the bucket only as downloads", async () => {
    const t = w.tokens.alice;
    for (const name of ["mock.html", "logo.svg", "feed.xml"]) {
      const uid = await seed(name);
      const r = await docGET(new Request(`http://x/api/projects/p/docs/${uid}`, { headers: { authorization: `Bearer ${t}` } }),
        { params: Promise.resolve({ key: "p", uid }) });
      expect(r.status).toBe(302);
      expect(decodeURIComponent(r.headers.get("location")!)).toContain(`disposition=attachment; filename*=UTF-8''${name}`);
    }
    const uid = await seed("plan.md");
    const r = await docGET(new Request(`http://x/api/projects/p/docs/${uid}`, { headers: { authorization: `Bearer ${t}` } }),
      { params: Promise.resolve({ key: "p", uid }) });
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("disposition=inline");
  });
});
