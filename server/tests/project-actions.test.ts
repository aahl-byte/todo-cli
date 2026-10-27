import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute } from "@/app/api/projects/[key]/actions/route";
import { POST as runRoute } from "@/app/api/projects/[key]/actions/run/route";
import { POST as checkoutRoute } from "@/app/api/projects/[key]/checkout/route";
import { knownCheckouts, recordCheckout, repoDir, repoKey, wtFileUrl } from "@/lib/checkouts";
import { boardSessions, itemSessions } from "@/lib/actions/sessions";
import { deliver } from "@/lib/actions/deliver";
import { WATCHTOWER_URL } from "@/lib/watchtower";
import { cleanAction, fill, firesOn, itemVars, render, validateActions, type ActionDef } from "@/lib/actions/model";
import { flushActions, MAX_ATTEMPTS, queueManualAction } from "@/lib/actions/runs";
import { STATUSES } from "@/lib/model";
import { item, set, world, type World } from "./helpers";
import { publicDns } from "./plugin-github";

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
  const vars = itemVars("p", { id: "safari", title: 'Say "hi"', status: "in-qa", extra: { repo: "acme/web", branches: ["fix/x", "fix/y"] } },
                        "review", "alice", "https://todo.test");
  it("fills names, with json and url filters", () => {
    expect(fill("{{item.repo_name}}@{{ item.branch }}", vars)).toBe("web@fix/x");
    expect(itemVars("p", { id: "a", title: "A", status: "todo", extra: { branch: "fix/old" } }, "", "alice")["item.branch"]).toBe("fix/old");
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
  it("calls the gated Watchtower on its loopback port, but links the public address", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster") ? { json: { sessions: [] } } : { json: { id: "s1", url: "http://127.0.0.1:10012/?session=s1" } }));
    const out = await deliver({ ...req, base: WATCHTOWER_URL }, f);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:10010/latest/api/roster", "http://127.0.0.1:10010/latest/api/sessions"]);
    expect(out.detail.url).toBe(`${WATCHTOWER_URL}/?session=s1`);
  });
  it("reuses the item's live session", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster")
      ? { json: { sessions: [{ id: "s9", name: "todo: x", state: "active", managed: true, url: "u9" }] } } : { json: { delivered: "queued" } }));
    await deliver(req, f);
    expect(calls[1]).toMatchObject({ method: "POST", url: "http://wt/api/sessions/s9/message", body: { text: "/todo x", from: "todo" } });
  });
  it("retries the send while Watchtower can't see the session's input box", async () => {
    let refusals = 2;
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/roster")) return { json: { sessions: [{ id: "s9", name: "todo: x", state: "active", managed: true, url: "u9" }] } };
      return refusals-- > 0 ? { status: 409, json: { ok: false, error: "the prompt input isn't visible" } } : { json: { delivered: "now" } };
    });
    const out = await deliver(req, f, async () => undefined);
    expect(calls.filter((c) => c.url.endsWith("/message"))).toHaveLength(3);
    expect(out.summary).toContain("(now)");
  });
  it("doesn't retry other refusals", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster")
      ? { json: { sessions: [{ id: "s9", name: "todo: x", state: "active", managed: true, url: "u9" }] } }
      : { status: 409, json: { ok: false, error: "the user is typing in this session" } }));
    await expect(deliver(req, f, async () => undefined)).rejects.toThrow("typing");
    expect(calls).toHaveLength(2);
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

  const resuming = { ...req, resumePrompt: "/todo x: news" };
  const stopped = (id: string, lastActivity: number) => ({ id, name: "todo: x", state: "stopped", managed: false, url: `u-${id}`, lastActivity });
  it("resumes the newest stopped session and sends it the resume prompt once it's idle", async () => {
    const states = [{ state: "stopped", status: "stopped" }, { state: "active", status: "busy" }, { state: "active", status: "idle" }];
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/roster")) return { json: { sessions: [stopped("old", 1), stopped("new", 2)] } };
      if (c.method === "GET") return { json: states.shift() };
      return { json: c.url.endsWith("/resume") ? { id: "new" } : { delivered: "now" } };
    });
    const out = await deliver(resuming, f, async () => undefined);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url))
      .toEqual(["http://wt/api/sessions/new/resume", "http://wt/api/sessions/new/message"]);
    expect(calls.at(-1)!.body.text).toBe("/todo x: news");
    expect(out.summary).toContain("resumed");
  });
  it("sends a live session the resume prompt", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/roster")
      ? { json: { sessions: [{ id: "s9", name: "todo: x", state: "active", managed: true, url: "u9" }] } } : { json: { delivered: "now" } }));
    await deliver(resuming, f);
    expect(calls[1].body.text).toBe("/todo x: news");
  });
  it("starts a new session with the start prompt when a resume doesn't come back", async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/roster")) return { json: { sessions: [stopped("gone", 1)] } };
      if (c.url.endsWith("/resume")) return { status: 404, json: { error: "no such session" } };
      return { json: { id: "s3", url: "u3" } };
    });
    const out = await deliver(resuming, f, async () => undefined);
    expect(calls.at(-1)).toMatchObject({ url: "http://wt/api/sessions", body: { initialPrompt: "/todo x" } });
    expect(out.summary).toContain("started");
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

describe("checkout folders", () => {
  const report = (token: string, body: unknown) => checkoutRoute(
    new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ key: "p" }) });
  const queuedDir = async (who: string, itemUid: string) => {
    await queueManualAction(w.d, "p", itemUid, tower({ dir: "{{item.dir}}|{{project.dir}}|{{project.repo}}" }), who);
    const [r] = await w.d.query("select request from action_runs order by id desc limit 1");
    return r.request.dir;
  };

  it("reads owner/name from a repo field or a remote URL", () => {
    expect(repoKey("git@github.com:Acme/Web.git")).toBe("acme/web");
    expect(repoKey("https://github.com/acme/web/")).toBe("acme/web");
    expect(repoKey("acme/web")).toBe("acme/web");
    expect(repoKey("web")).toBe("");
  });

  it("fills item.dir from the item's repo, preferring the actor's own folder, and follows a renamed folder", async () => {
    expect((await report(w.tokens.alice, { dir: "relative" })).status).toBe(400);
    await report(w.tokens.alice, { dir: "/home/alice/todo", repo: "git@github.com:acme/todo.git" });
    await report(w.tokens.bob, { dir: "/home/bob/web", repo: "acme/web" });
    await w.one("alice", item("I1"));
    await w.one({ handle: "alice", unconditional: true }, set("item", "I1", "I1", { "extra.repo": "acme/web" }));
    await w.one("alice", item("I2"));
    expect(await queuedDir("alice", "I1")).toBe("/home/bob/web|/home/alice/todo|acme/todo");
    await report(w.tokens.alice, { dir: "/home/alice/web", repo: "acme/web" });
    expect(await queuedDir("alice", "I1")).toBe("/home/alice/web|/home/alice/web|acme/web");
    await report(w.tokens.alice, { dir: "/home/alice/web-renamed", repo: "acme/web" });
    expect(await queuedDir("alice", "I1")).toBe("/home/alice/web-renamed|/home/alice/web-renamed|acme/web");
    await report(w.tokens.alice, { dir: "/home/alice/todo", repo: "git@github.com:acme/todo.git" });
    expect(await queuedDir("alice", "I2")).toBe("/home/alice/todo|/home/alice/todo|acme/todo");
  });
});

describe("session states", () => {
  const delivered = async (itemUid: string, actionId: string, session: string) => {
    await w.d.query(
      `insert into action_runs (project, item_uid, action_id, name, trigger, by, request, result, done_at)
       values ('p', $1, $2, $2, 'manual', 'alice', $3::jsonb, $4::jsonb, now())`,
      [itemUid, actionId, JSON.stringify({ kind: "watchtower", base: "http://wt", dir: "/x", name: "todo: x", prompt: "/todo x" }),
       JSON.stringify({ summary: "started", session, url: `http://wt/?session=${session}` })]);
  };

  it("reads each Action's latest session from Watchtower, following an id moved by /clear", async () => {
    await w.one("alice", item("I1"));
    await w.one("alice", item("I2"));
    await delivered("I1", "agent", "old");
    await delivered("I1", "agent", "s1");
    await delivered("I1", "review", "s2");
    await delivered("I2", "agent", "s3");
    const { f, calls } = fakeFetch((c) => c.url.endsWith("/s1") ? { json: { id: "s1b", status: "busy", url: "http://wt/?session=s1b" } }
      : c.url.endsWith("/s2") ? { json: { id: "s2", status: "waiting", waitingFor: "permission prompt" } }
      : { status: 404, json: { error: "no such session" } });
    const states = await itemSessions(w.d, "p", "I1", { fetch: f });
    expect(calls.map((c) => c.url)).not.toContain("http://wt/api/sessions/old");
    expect(states).toEqual([
      { key: "agent", name: "agent", session: "s1b", url: "http://wt/?session=s1b", status: "busy", waitingFor: null },
      { key: "review", name: "review", session: "s2", url: "http://wt/?session=s2", status: "waiting", waitingFor: "permission prompt" },
    ]);
    expect(await boardSessions(w.d, "p", { fetch: f })).toEqual({ I1: { status: "busy", waitingFor: null } });
  });

  describe("the watchtower-session plugin's", () => {
    const ran = async (itemUid: string, instance: string, result: Record<string, unknown> = {}, dryRun = false) => {
      await w.d.query(
        `insert into plugin_runs (project, item_uid, repo, plugin, instance, event, result, applied, dry_run)
         values ('p', $1, 'acme/web', 'watchtower-session', $2, '{"type":"manual"}', $3::jsonb, '[]', $4)`,
        [itemUid, instance, JSON.stringify({ attached: [], wouldSend: [], log: [], ...result }), dryRun]);
    };
    const roster = { sessions: [
      { id: "old", name: "todo: i1", state: "stopped", lastActivity: 1 },
      { id: "live", name: "todo: i1", state: "active", lastActivity: 2 },
      { id: "gone", name: "todo: i2", state: "stopped", lastActivity: 5 },
      { id: "other", name: "todo: i3", state: "active", lastActivity: 9 },
    ] };

    beforeEach(async () => {
      vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ watchtower: { http: { url: "https://wt.example/latest", auth: "bearer" } } }));
      vi.stubEnv("TODO_PLUGIN_SECRET_WATCHTOWER", "wt-token");
      for (const uid of ["I1", "I2", "I3", "I4"]) await w.one("alice", item(uid));
      await w.d.query(
        `insert into plugin_instances (project, repo, plugin, id, def, updated_by)
         values ('p', 'acme/web', 'watchtower-session', 'agent', $1::jsonb, 'alice')`,
        [JSON.stringify({ id: "agent", name: "Agent", settings: { link: "https://wt.link/latest/" } })]);
    });

    it("finds the item's own session through the repo's watchtower connection, live before stopped", async () => {
      await ran("I1", "agent");
      await ran("I2", "agent");
      await ran("I3", "agent", { error: "watchtower: POST /api/sessions answered 500" });
      await ran("I4", "agent", {}, true);
      const { f, calls } = fakeFetch((c) => c.url.endsWith("/api/roster") ? { json: roster }
        : c.url.endsWith("/api/sessions/live") ? { json: { id: "live", status: "waiting", waitingFor: "permission prompt" } }
        : { status: 404, json: { error: "no such session" } });
      const net = { fetch: f, lookup: publicDns };
      expect(await itemSessions(w.d, "p", "I1", net)).toEqual([
        { key: "watchtower-session/agent", name: "Agent", session: "live", url: "https://wt.link/latest/?session=live", status: "waiting",
          waitingFor: "permission prompt" },
      ]);
      expect(await itemSessions(w.d, "p", "I2", net)).toEqual([
        { key: "watchtower-session/agent", name: "Agent", session: "gone", url: "https://wt.link/latest/?session=gone", status: "stopped", waitingFor: null },
      ]);
      expect(await itemSessions(w.d, "p", "I3", net)).toEqual([]);
      expect(await itemSessions(w.d, "p", "I4", net)).toEqual([]);
      expect(calls.every((c) => c.url.startsWith("https://wt.example/latest/api/"))).toBe(true);
      expect(await boardSessions(w.d, "p", net)).toEqual({ I1: { status: "waiting", waitingFor: "permission prompt" } });
    });

    it("sends the connection's credential, and shows the session as unreachable when Watchtower doesn't answer", async () => {
      await ran("I1", "agent");
      const auth: (string | null)[] = [];
      const f = (async (_url: string, init: RequestInit = {}) => {
        auth.push(new Headers(init.headers).get("authorization"));
        return new Response("no", { status: 401 });
      }) as unknown as typeof fetch;
      expect(await itemSessions(w.d, "p", "I1", { fetch: f, lookup: publicDns })).toEqual([
        { key: "watchtower-session/agent", name: "Agent", session: "", url: "https://wt.link/latest", status: "unknown", waitingFor: null },
      ]);
      expect(auth).toEqual(["Bearer wt-token"]);
    });
  });
});

describe("Watchtower file links", () => {
  it("finds a repo's folder by folder, owner/name or bare name, the person's own first", async () => {
    await recordCheckout(w.d, "bob", "p", "/home/bob/watchtower", "git@github.com:me/watchtower.git");
    await recordCheckout(w.d, "alice", "p", "/home/alice/watchtower", "me/watchtower");
    await recordCheckout(w.d, "alice", "q", "/home/alice/scratch", "");
    expect(await repoDir(w.d, "alice", "watchtower")).toBe("/home/alice/watchtower");
    expect(await repoDir(w.d, "bob", "me/Watchtower")).toBe("/home/bob/watchtower");
    expect(await repoDir(w.d, "bob", "scratch")).toBe("/home/alice/scratch");
    expect(await repoDir(w.d, "bob", "/srv/x/")).toBe("/srv/x");
    expect(await repoDir(w.d, "bob", "nope")).toBeNull();
    expect((await knownCheckouts(w.d, "bob"))[0]).toEqual({ repo: "me/watchtower", dir: "/home/bob/watchtower" });
    expect(wtFileUrl("/a b", "src/App.svelte", true)).toMatch(/\/\?dir=%2Fa%20b&file=src%2FApp.svelte&mode=edit$/);
  });
});
