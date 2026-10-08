import { beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "@/app/api/projects/[key]/actions/route";
import { POST as runRoute } from "@/app/api/projects/[key]/actions/run/route";
import { deliver } from "@/lib/actions/deliver";
import { cleanAction, fill, firesOn, itemVars, render, validateActions, type ActionDef } from "@/lib/actions/model";
import { flushActions, MAX_ATTEMPTS } from "@/lib/actions/runs";
import { STATUSES } from "@/lib/model";
import { item, set, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
});

const rest = (over: Partial<ActionDef> = {}): ActionDef => cleanAction({
  id: "ping", name: "Ping", kind: "rest", runner: "server", method: "POST", url: "https://hooks.test/{{item.id}}",
  headers: { "content-type": "application/json" }, body: '{"title": {{item.title | json}}}', auto: [], ...over,
});
const tower = (over: Partial<ActionDef> = {}): ActionDef => cleanAction({
  id: "agent", name: "Start agent", kind: "watchtower", runner: "server", base: "http://wt:10011/",
  dir: "/mnt/rain/git/{{item.repo_name}}", auto: [], ...over,
});

async function saveActions(actions: ActionDef[]) {
  await w.d.query("update projects set actions = $1::jsonb where key = 'p'", [JSON.stringify(actions)]);
}

type Call = { method: string; url: string; body: any };
function fakeFetch(answer: (c: Call) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url, body: init.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return init.body; } })() : null };
    calls.push(c);
    const a = answer(c);
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("templates", () => {
  const vars = itemVars("p", { id: "safari", title: 'Say "hi"', status: "in-qa", extra: { repo: "acme/web", branch: "fix/x" } },
                        "review", "alice", "https://todo.test");
  it("fills names, with json and url filters", () => {
    expect(fill("{{item.repo_name}}@{{ item.branch }}", vars)).toBe("web@fix/x");
    expect(fill("{{item.title | json}}", vars)).toBe('"Say \\"hi\\""');
    expect(fill("q={{item.title|url}}", vars)).toBe("q=Say%20%22hi%22");
    expect(vars["item.url"]).toBe("https://todo.test/p/p/i/safari");
  });
  it("renders a REST call and drops the body of a GET", () => {
    expect(render(rest(), vars)).toEqual({ kind: "rest", method: "POST", url: "https://hooks.test/safari",
      headers: { "content-type": "application/json" }, body: '{"title": "Say \\"hi\\""}' });
    expect(render(rest({ method: "GET" }), vars)).toMatchObject({ body: null });
  });
  it("names the Watchtower session after the item and defaults the prompt", () => {
    expect(render(tower(), vars)).toEqual({ kind: "watchtower", base: "http://wt:10011", dir: "/mnt/rain/git/web",
      name: "todo: safari", prompt: "/todo safari" });
  });
});

describe("validation", () => {
  it("accepts good actions", () => {
    expect(validateActions([rest(), tower({ auto: [{ from: "*", to: "todo" }] })], STATUSES)).toEqual([]);
  });
  it("names each problem", () => {
    const msgs = validateActions([
      rest({ id: "Bad Id", url: "ftp://x", body: "{{item.nope}} {{item.id | shout}}" }),
      rest({ id: "ping", auto: [{ from: "nowhere", to: "todo" }, { from: "*", to: "todo" }, { from: "*", to: "todo" }] }),
      rest({ id: "ping" }),
      tower({ base: "", dir: "" }),
    ], STATUSES).map((p) => p.message).join("\n");
    for (const bit of ["lowercase letters", "http:// or https://", "{{item.nope}}", "filter shout", "from nowhere",
                       "* → todo twice", "share the id ping", "Watchtower's address", "folder"]) expect(msgs).toContain(bit);
  });
  it("fires on a matching move only", () => {
    const a = rest({ auto: [{ from: "*", to: "qa-approved" }, { from: "review", to: "todo" }] });
    expect(firesOn(a, "in-qa", "qa-approved")).toBe(true);
    expect(firesOn(a, "review", "todo")).toBe(true);
    expect(firesOn(a, "in-triage", "todo")).toBe(false);
    expect(firesOn(a, "qa-approved", "qa-approved")).toBe(false);
  });
});

describe("watchtower delivery", () => {
  const req = { kind: "watchtower" as const, base: "http://wt", dir: "/r/web", name: "todo: x", prompt: "/todo x" };
  it("starts a session with the prompt inline", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster") ? { json: { sessions: [] } } : { json: { id: "s1", url: "http://wt/?session=s1" } }));
    const out = await deliver(req, f);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET http://wt/api/roster", "POST http://wt/api/sessions"]);
    expect(calls[1].body).toEqual({ dir: "/r/web", name: "todo: x", initialPrompt: "/todo x" });
    expect(out.summary).toContain("http://wt/?session=s1");
  });
  it("reuses the item's live session", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster")
      ? { json: { sessions: [{ id: "s9", name: "todo: x", state: "active", managed: true, url: "u9" }] } } : { json: { delivered: "queued" } }));
    await deliver(req, f);
    expect(calls[1]).toMatchObject({ method: "POST", url: "http://wt/api/sessions/s9/message", body: { text: "/todo x", from: "todo" } });
  });
  it("sends a long prompt once the session is idle", async () => {
    const statuses = ["busy", "idle"];
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/roster")) return { json: { sessions: [] } };
      if (c.method === "GET") return { json: { status: statuses.shift() } };
      return { json: { id: "s2", url: "u2" } };
    });
    await deliver({ ...req, prompt: "line one\nline two" }, f, async () => undefined);
    expect(calls[1].body.initialPrompt).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: "http://wt/api/sessions/s2/message", body: { text: "line one\nline two" } });
  });
});

describe("runs", () => {
  it("queues a server Action on a matching status move, delivers it and logs the outcome", async () => {
    await saveActions([rest({ auto: [{ from: "*", to: "in-progress" }] }), rest({ id: "local", runner: "cli", auto: [{ from: "*", to: "in-progress" }] })]);
    const v = (await w.one("alice", item("I1", { title: "Fix it" }))).versions!;
    await w.one("alice", set("item", "I1", "I1", { status: "in-progress" }, { status: v.status }));
    const runs = await w.d.query("select action_id, trigger, request from action_runs");
    expect(runs).toEqual([{ action_id: "ping", trigger: "todo → in-progress",
      request: expect.objectContaining({ url: "https://hooks.test/i1", body: '{"title": "Fix it"}' }) }]);
    const { f } = fakeFetch(() => ({ status: 202, text: "ok" }));
    expect(await flushActions(w.d, f)).toEqual({ sent: 1, failed: 0 });
    const [log] = await w.d.query("select text from logs");
    expect(log.text).toBe("action Ping (todo → in-progress): POST https://hooks.test/i1 → 202");
  });

  it("retries a failure, then gives up and says so", async () => {
    await saveActions([rest({ auto: [{ from: "*", to: "review" }] })]);
    const v = (await w.one("alice", item("I1"))).versions!;
    await w.one("alice", set("item", "I1", "I1", { status: "review" }, { status: v.status }));
    const { f } = fakeFetch(() => ({ status: 500, text: "boom" }));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await w.d.query("update action_runs set next_attempt_at = null");
      await flushActions(w.d, f);
    }
    const [run] = await w.d.query("select attempts, done_at is not null as done, error from action_runs");
    expect(run).toMatchObject({ attempts: MAX_ATTEMPTS, done: true, error: expect.stringContaining("500: boom") });
    expect((await w.d.query("select text from logs"))[0].text).toContain("gave up after");
  });
});

describe("API", () => {
  const auth = (token: string, body?: unknown) => ({
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const params = { params: Promise.resolve({ key: "p" }) };

  it("lists the project's Actions", async () => {
    await saveActions([rest()]);
    const res = await listRoute(new Request("http://x", auth(w.tokens.alice)), params);
    expect((await res.json()).actions.map((a: ActionDef) => a.id)).toEqual(["ping"]);
  });

  it("refuses to run a CLI Action on the server", async () => {
    await saveActions([rest({ runner: "cli" })]);
    await w.one("alice", item("I1"));
    const res = await runRoute(new Request("http://x", auth(w.tokens.alice, { item: "I1", action: "ping" })), params);
    expect(res.status).toBe(400);
  });
});
