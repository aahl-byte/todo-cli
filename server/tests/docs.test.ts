import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listGET, PUT as recordPUT } from "@/app/api/projects/[key]/docs/route";
import { POST as uploadPOST } from "@/app/api/projects/[key]/docs/upload/route";
import { DELETE as docDELETE, GET as docGET } from "@/app/api/projects/[key]/docs/[uid]/route";
import { GET as changesGET } from "@/app/api/projects/[key]/changes/route";
import { GET as fileGET, POST as filePOST } from "@/app/api/files/[...key]/route";
import { addProject } from "@/lib/auth";
import { changesSince } from "@/lib/changes";
import type { Db } from "@/lib/db";
import { docKind, docNameError, docNameKey, docUid, issueUpload, recordDoc, sweepDocUploads, sweepDocUploadsIfDue } from "@/lib/docs";
import { newDocKey, readLocal, saveLocal } from "@/lib/files";
import { hashUid } from "@/lib/ulid";
import { item, world, type World } from "./helpers";

let w: World;
let dir: string;
beforeEach(async () => {
  w = await world();
  dir = mkdtempSync(path.join(tmpdir(), "docs-"));
  process.env.TODO_FILES_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.VERCEL;
  await w.apply("alice", item("I1"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TODO_FILES_DIR;
});

const auth = (token: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
const jsonReq = (url: string, method: string, token: string | null, body?: unknown) =>
  new Request(url, { method, headers: { ...auth(token), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const proj = (key: string) => ({ params: Promise.resolve({ key }) });
const one = (key: string, uid: string) => ({ params: Promise.resolve({ key, uid }) });
const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Upload bytes the way the CLI does, then record them as `name`. */
async function put(token: string, name: string, body: string, base: string | null, project = "p", itemUid = "I1") {
  const t = await uploadPOST(jsonReq(`http://x/api/projects/${project}/docs/upload`, "POST", token, { item_uid: itemUid, name, size: body.length }), proj(project));
  expect(t.status).toBe(200);
  const target = await t.json();
  const fd = new FormData();
  fd.append("file", new File([body], name, { type: target.content_type }));
  const sent = await filePOST(new Request(`http://x${target.url}`, { method: "POST", headers: auth(token), body: fd }),
    { params: Promise.resolve({ key: target.key.split("/") }) });
  expect(sent.status).toBe(204);
  return recordPUT(jsonReq(`http://x/api/projects/${project}/docs`, "PUT", token,
    { item_uid: itemUid, name, file_key: target.key, sha256: sha(body), base, via: "agent" }), proj(project));
}

describe("doc uids", () => {
  it("match the CLI's hash", () => {
    expect(hashUid("doc", "I1", "plan.md")).toBe("ZXRFVMMM2LHBM4A75CY5IY7VSU");
    expect(docUid("I1", "plan.md")).toBe("ZXRFVMMM2LHBM4A75CY5IY7VSU");
  });

  it("refuse names some system can't hold, by the CLI's rule", () => {
    const bad = ["a/b", ".meta.yaml", ".hidden", "x".repeat(201), "設".repeat(66) + ".md", "", "a\\b", "a\nb", "a:b.md", "a<b.md",
      "a>b.md", 'a"b.md', "a|b.md", "a?.md", "a*.md", "trailing.", "trailing ", "con", "CON.md", "nul.txt", "Aux", "prn.tar.gz",
      "com1.md", "LPT9.txt", "a\uD800.md"];
    for (const name of bad) expect([name, docNameError(name)]).not.toEqual([name, null]);
    for (const name of ["設".repeat(65) + ".md", "design v2.md", "console.md", "com10.md", "lpt.md", "a.b.c"]) expect(docNameError(name)).toBeNull();
  });

  it("make a name one doc whatever its case or Unicode form", () => {
    expect(docNameKey("Cafe\u0301.MD")).toBe("café.md");
    expect(docUid("I1", "Cafe\u0301.md")).toBe("ZPOF2JXTNOB7HXR3BXTCM7NVE6");
    expect(docUid("I1", "PLAN.md")).toBe(docUid("I1", "plan.md"));
  });
});

describe("docs routes", () => {
  it("upload, record, list and serve a doc, and put it in the changes feed for clients that ask", async () => {
    const t = w.tokens.alice;
    const r = await put(t, "plan.md", "# Plan\n", null);
    expect(r.status).toBe(200);
    const { status, doc } = await r.json();
    expect(status).toBe("applied");
    expect(doc).toMatchObject({ uid: docUid("I1", "plan.md"), name: "plan.md", size: 7, sha256: sha("# Plan\n"), by: "alice",
                                via: "agent", content_type: "text/markdown" });
    expect(doc.file_key).toMatch(/^p\/docs\/[0-9A-Z]{26}\.md$/);
    const list = await (await listGET(new Request("http://x/api/projects/p/docs?item=I1", { headers: auth(t) }), proj("p"))).json();
    expect(list.docs.map((d: any) => d.name)).toEqual(["plan.md"]);
    const got = await docGET(new Request(`http://x/api/projects/p/docs/${doc.uid}`, { headers: auth(t) }), one("p", doc.uid));
    expect(await got.text()).toBe("# Plan\n");
    expect(got.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(got.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''plan.md");
    const feed = async (docs: boolean) => (await (await changesGET(new Request(`http://x/api/projects/p/changes?since=0${docs ? "&docs=1" : ""}`,
      { headers: auth(t) }), proj("p"))).json()).changes.map((c: any) => c.entity);
    expect(await feed(true)).toContain("doc");
    expect(await feed(false)).not.toContain("doc");
  });

  it("sends a doc's size in the feed as a number when the driver reads bigint as a string", async () => {
    expect((await put(w.tokens.alice, "plan.md", "# Plan\n", null)).status).toBe(200);
    const pg: Db = { ...w.d, query: async (sql, params) =>
      (await w.d.query(sql, params)).map((r) => ("size" in r ? { ...r, size: String(r.size) } : r)) as any };
    const { changes } = await changesSince(pg, "p", 0, 500, true);
    expect(changes.find((c) => c.entity === "doc")?.data?.size).toBe(7);
  });

  it("calls a stale base a conflict and hands back the current doc", async () => {
    const t = w.tokens.alice;
    const first = (await (await put(t, "plan.md", "v1", null)).json()).doc;
    const second = await (await put(w.tokens.bob, "plan.md", "v2 by bob", first.sha256)).json();
    expect(second).toMatchObject({ status: "applied", doc: { by: "bob", sha256: sha("v2 by bob") } });
    const third = await (await put(t, "plan.md", "v2 by alice", first.sha256)).json();
    expect(third).toMatchObject({ status: "conflict", doc: { by: "bob", sha256: sha("v2 by bob") } });
    const fresh = await (await put(t, "plan.md", "new doc", null)).json();
    expect(fresh.status).toBe("conflict");
    expect((await (await put(t, "plan.md", "v2 by bob", null)).json()).status).toBe("applied");
  });

  it("deletes only from the current base", async () => {
    const t = w.tokens.alice;
    const doc = (await (await put(t, "plan.md", "v1", null)).json()).doc;
    const del = (base: string) => docDELETE(new Request(`http://x/api/projects/p/docs/${doc.uid}?base=${base}`, { method: "DELETE", headers: auth(t) }), one("p", doc.uid));
    expect(await (await del("stale")).json()).toMatchObject({ status: "conflict", doc: { sha256: doc.sha256 } });
    expect(await (await del(doc.sha256)).json()).toEqual({ status: "applied", doc: null });
    expect((await docGET(new Request(`http://x/api/projects/p/docs/${doc.uid}`, { headers: auth(t) }), one("p", doc.uid))).status).toBe(404);
    const [c] = await w.d.query("select deleted from changes where entity = 'doc' order by seq desc limit 1");
    expect(c.deleted).toBe(true);
    const feed = await (await changesGET(new Request("http://x/api/projects/p/changes?since=0&docs=1", { headers: auth(t) }), proj("p"))).json();
    expect(feed.changes.find((x: any) => x.uid === doc.uid)).toMatchObject({ deleted: true, data: null, last_sha256: doc.sha256 });
    await put(t, "plan.md", "back", null);
    const again = await (await changesGET(new Request("http://x/api/projects/p/changes?since=0&docs=1", { headers: auth(t) }), proj("p"))).json();
    expect(again.changes.find((x: any) => x.uid === doc.uid).last_sha256).toBeUndefined();
  });

  it("needs a token, and keeps each project's docs to itself", async () => {
    const t = w.tokens.alice;
    const doc = (await (await put(t, "plan.md", "secret", null)).json()).doc;
    expect((await docGET(new Request(`http://x/api/projects/p/docs/${doc.uid}`), one("p", doc.uid))).status).toBe(401);
    expect((await listGET(new Request("http://x/api/projects/p/docs?item=I1"), proj("p"))).status).toBe(401);
    expect((await recordPUT(jsonReq("http://x/api/projects/p/docs", "PUT", null, {}), proj("p"))).status).toBe(401);
    expect((await uploadPOST(jsonReq("http://x/api/projects/p/docs/upload", "POST", null, { item_uid: "I1", name: "a.md", size: 1 }), proj("p"))).status).toBe(401);
    await addProject(w.d, "q");
    await w.d.query("insert into items (project, uid, id, title, created) values ('q', 'I1', 'i1', 'Other', '2026-10-02')");
    expect((await docGET(new Request(`http://x/api/projects/q/docs/${doc.uid}`, { headers: auth(t) }), one("q", doc.uid))).status).toBe(404);
    const listed = await (await listGET(new Request("http://x/api/projects/q/docs?item=I1", { headers: auth(t) }), proj("q"))).json();
    expect(listed.docs).toEqual([]);
    const stolen = await recordPUT(jsonReq("http://x/api/projects/q/docs", "PUT", t, { item_uid: "I1", name: "x.md", file_key: doc.file_key, base: null }), proj("q"));
    expect(stolen.status).toBe(422);
    expect((await fileGET(new Request(`http://x/api/files/${doc.file_key}`, { headers: auth(t) }),
      { params: Promise.resolve({ key: doc.file_key.split("/") }) })).status).toBe(404);
  });

  it("refuses bad names, sizes, unknown items and a sha256 that doesn't match the upload", async () => {
    const t = w.tokens.alice;
    const ask = (body: unknown) => uploadPOST(jsonReq("http://x/api/projects/p/docs/upload", "POST", t, body), proj("p"));
    expect((await ask({ item_uid: "I1", name: "a/b.md", size: 1 })).status).toBe(422);
    expect((await ask({ item_uid: "I1", name: "a.md", size: 26 * 1024 * 1024 })).status).toBe(413);
    expect((await ask({ item_uid: "nope", name: "a.md", size: 1 })).status).toBe(422);
    expect((await uploadPOST(jsonReq("http://x/api/projects/zz/docs/upload", "POST", t, { item_uid: "I1", name: "a.md", size: 1 }), proj("zz"))).status).toBe(404);
    expect((await ask({ item_uid: "I1", name: "empty.txt", size: 0 })).status).toBe(200);
    const target = await (await ask({ item_uid: "I1", name: "a.md", size: 3 })).json();
    const fd = new FormData();
    fd.append("file", new File(["abc"], "a.md"));
    await filePOST(new Request(`http://x${target.url}`, { method: "POST", headers: auth(t), body: fd }), { params: Promise.resolve({ key: target.key.split("/") }) });
    const lie = await recordPUT(jsonReq("http://x/api/projects/p/docs", "PUT", t, { item_uid: "I1", name: "a.md", file_key: target.key, sha256: sha("xyz"), base: null }), proj("p"));
    expect(lie.status).toBe(422);
  });

  it("serves HTML sandboxed and offers any doc as a download", async () => {
    const t = w.tokens.alice;
    const doc = (await (await put(t, "mock.html", "<script>alert(1)</script>", null)).json()).doc;
    const got = await docGET(new Request(`http://x/api/projects/p/docs/${doc.uid}?download=1`, { headers: auth(t) }), one("p", doc.uid));
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''mock.html");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("doc kinds", () => {
  it("pick the renderer by extension", () => {
    const cases: Record<string, string> = {
      "plan.md": "markdown", "README.markdown": "markdown", "mock.html": "html", "a.HTM": "html", "data.json": "json",
      "ci.yaml": "code", "ci.yml": "code", "site.css": "code", "a.ts": "code", "a.tsx": "code", "a.js": "code", "a.jsx": "code",
      "a.mjs": "code", "a.py": "code", "q.sql": "code", "run.sh": "code", "run.bash": "code", "c.toml": "code", "c.ini": "code",
      "f.xml": "code", "m.go": "code", "m.rs": "code", "m.rb": "code", "M.java": "code", "m.c": "code", "m.h": "code",
      "m.cpp": "code", "m.cs": "code", "m.php": "code", "m.swift": "code", "m.kt": "code", "notes.txt": "text",
      "shot.png": "image", "pic.JPG": "image", "logo.svg": "image", "spec.pdf": "pdf", "call.mp3": "audio", "demo.mp4": "video",
      "demo.webm": "video", "bundle.zip": "download", "Makefile": "download",
    };
    for (const [name, kind] of Object.entries(cases)) expect([name, docKind(name)]).toEqual([name, kind]);
  });
});

describe("doc identity and uploads", () => {
  it("refuses a second doc whose name differs only in case or Unicode form", async () => {
    const t = w.tokens.alice;
    const ask = (name: string) => uploadPOST(jsonReq("http://x/api/projects/p/docs/upload", "POST", t, { item_uid: "I1", name, size: 3 }), proj("p"));
    const early = await (await ask("CAFÉ.md")).json();
    await saveLocal(early.key, new TextEncoder().encode("two"));
    await put(t, "café.md", "one", null);
    for (const twin of ["CAFÉ.md", "cafe\u0301.md"]) {
      const r = await ask(twin);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toContain("a doc named café.md already exists");
    }
    const late = await recordPUT(jsonReq("http://x/api/projects/p/docs", "PUT", t, { item_uid: "I1", name: "CAFÉ.md", file_key: early.key, base: null }), proj("p"));
    expect(late.status).toBe(409);
    expect((await w.d.query("select name from docs")).map((r) => r.name)).toEqual(["café.md"]);
  });

  it("records only a key it issued for that project, item and name, within the hour", async () => {
    const t = w.tokens.alice;
    const record = (file_key: string, name = "a.md") =>
      recordPUT(jsonReq("http://x/api/projects/p/docs", "PUT", t, { item_uid: "I1", name, file_key, base: null }), proj("p"));
    const forged = newDocKey("p", "a.md");
    await saveLocal(forged, new TextEncoder().encode("x"));
    expect((await record(forged)).status).toBe(422);
    const target = await (await uploadPOST(jsonReq("http://x/api/projects/p/docs/upload", "POST", t, { item_uid: "I1", name: "a.md", size: 1 }), proj("p"))).json();
    await saveLocal(target.key, new TextEncoder().encode("x"));
    expect((await record(target.key, "b.md")).status).toBe(422);
    await w.d.query("update doc_uploads set created = now() - interval '2 hours'");
    expect((await record(target.key)).status).toBe(422);
    await w.d.query("update doc_uploads set created = now()");
    await w.d.query("update doc_uploads set name_key = 'a.txt'");
    expect((await record(target.key, "a.txt")).status).toBe(422);
    await w.d.query("update doc_uploads set name_key = 'a.md'");
    expect((await record(target.key)).status).toBe(200);
    expect((await record(target.key)).status).toBe(422);
  });

  it("deletes the blob a replace or delete leaves behind", async () => {
    const t = w.tokens.alice;
    const first = (await (await put(t, "plan.md", "v1", null)).json()).doc;
    const second = (await (await put(t, "plan.md", "v2", first.sha256)).json()).doc;
    expect(await readLocal(first.file_key)).toBeNull();
    expect(await readLocal(second.file_key)).not.toBeNull();
    await docDELETE(new Request(`http://x/api/projects/p/docs/${second.uid}?base=${second.sha256}`, { method: "DELETE", headers: auth(t) }), one("p", second.uid));
    expect(await readLocal(second.file_key)).toBeNull();
  });

  it("lists every doc of the project in pages", async () => {
    const t = w.tokens.alice;
    await w.apply("alice", item("I2"));
    for (const [name, itemUid] of [["a.md", "I1"], ["b.md", "I1"], ["c.md", "I2"]]) await put(t, name, name, null, "p", itemUid);
    const seen: string[] = [];
    let after = "";
    for (;;) {
      const page = await (await listGET(new Request(`http://x/api/projects/p/docs?limit=2${after ? `&after=${after}` : ""}`, { headers: auth(t) }), proj("p"))).json();
      seen.push(...page.docs.map((d: any) => d.name));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("sweeps upload keys never recorded within a day, with their blobs", async () => {
    const t = w.tokens.alice;
    const target = await (await uploadPOST(jsonReq("http://x/api/projects/p/docs/upload", "POST", t, { item_uid: "I1", name: "a.md", size: 1 }), proj("p"))).json();
    await saveLocal(target.key, new TextEncoder().encode("x"));
    expect(await sweepDocUploads(w.d)).toBe(0);
    await w.d.query("update doc_uploads set created = now() - interval '25 hours'");
    expect(await sweepDocUploads(w.d)).toBe(1);
    expect(await readLocal(target.key)).toBeNull();
    expect(await w.d.query("select * from doc_uploads")).toEqual([]);
  });
});

describe("issued keys, once each", () => {
  it("apply one of two concurrent records of a key, and keep its bytes", async () => {
    const key = await issueUpload(w.d, "p", "I1", "plan.md", 2);
    await saveLocal(key, new TextEncoder().encode("v1"));
    const rec = () => recordDoc(w.d, "p", "alice", { item_uid: "I1", name: "plan.md", file_key: key, base: null });
    const res = await Promise.allSettled([rec(), rec()]);
    expect(res.filter((r) => r.status === "fulfilled" && r.value.status === "applied")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 422)).toHaveLength(1);
    const [row] = await w.d.query("select file_key from docs where project = 'p'");
    expect(row.file_key).toBe(key);
    expect(await readLocal(key)).not.toBeNull();
  });

  it("refuse a replayed record and keep the doc's bytes", async () => {
    const key = await issueUpload(w.d, "p", "I1", "plan.md", 2);
    await saveLocal(key, new TextEncoder().encode("v1"));
    await recordDoc(w.d, "p", "alice", { item_uid: "I1", name: "plan.md", file_key: key, base: null });
    await expect(recordDoc(w.d, "p", "alice", { item_uid: "I1", name: "plan.md", file_key: key, base: null }))
      .rejects.toMatchObject({ status: 422 });
    expect(await readLocal(key)).not.toBeNull();
  });

  it("take uploads through the app only for a key issued and still pending", async () => {
    const t = w.tokens.alice;
    const send = (key: string) => {
      const fd = new FormData();
      fd.append("file", new File(["x"], "a.md"));
      return filePOST(new Request(`http://x/api/files/${key}`, { method: "POST", headers: auth(t), body: fd }), { params: Promise.resolve({ key: key.split("/") }) });
    };
    expect((await send(newDocKey("p", "a.md"))).status).toBe(403);
    const key = await issueUpload(w.d, "p", "I1", "a.md", 1);
    expect((await send(key)).status).toBe(204);
    await recordDoc(w.d, "p", "alice", { item_uid: "I1", name: "a.md", file_key: key, base: null });
    const late = await issueUpload(w.d, "p", "I1", "b.md", 1);
    await w.d.query("delete from doc_uploads where file_key = $1", [late]);
    expect((await send(late)).status).toBe(403);
  });

  it("sweep stale uploads after a request at most once an hour", async () => {
    const key = await issueUpload(w.d, "p", "I1", "a.md", 1);
    await w.d.query("update doc_uploads set created = now() - interval '25 hours'");
    const t0 = 10_000_000;
    expect(await sweepDocUploadsIfDue(w.d, t0)).toBe(1);
    await issueUpload(w.d, "p", "I1", "b.md", 1);
    await w.d.query("update doc_uploads set created = now() - interval '25 hours'");
    expect(await sweepDocUploadsIfDue(w.d, t0 + 30 * 60_000)).toBeNull();
    expect(await sweepDocUploadsIfDue(w.d, t0 + 61 * 60_000)).toBe(1);
    expect(key).toBeTruthy();
  });
});
