import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { runInstance } from "@/lib/plugins/host";
import { flushPluginRuns, pluginUid } from "@/lib/plugins/server";
import { queuePluginEvent } from "@/lib/plugins/queue";
import { SHIPPED } from "@/lib/plugins/shipped";
import type { PluginItem } from "@/lib/plugins/types";
import { fakeServer, type Recorded } from "./plugin-fakes";
import { item, world, type World } from "./helpers";
import { configured, params, publicDns, req } from "./plugin-github";

const RULE = { jira_from: "QA", jira_to: "In Development", from: "in-qa", to: "qa-rejected", note: "QA moved the Jira ticket" };
const PATH = "/rest/api/3/issue/SR-1/changelog";
const history = (id: string, created: string, from: string, to: string, author = { accountId: "acc-q", displayName: "Quinn" }) =>
  ({ id, created, author, items: [{ field: "status", fromString: from, toString: to }] });
const page = (values: unknown[], startAt = 0, total = values.length): Recorded =>
  ({ method: "GET", path: `${PATH}?startAt=${startAt}&maxResults=100`, body: { startAt, total, values } });

async function runPlugin(responses: Recorded[], over: Partial<PluginItem> = {}, settings: Record<string, unknown> = RULE, shipped = true) {
  const server = await fakeServer(responses);
  try {
    const { def, code } = SHIPPED["jira-status-transitions"];
    return await runInstance({ plugin: def, name: "jira-status-transitions", code, shipped, instance: { id: "reject", name: "r", settings },
      item: { id: "x", uid: "U", title: "t", status: "in-qa", branches: [], jira: ["SR-1"], links: [], ...over },
      event: { type: "refresh" }, connections: { jira: { kind: "http", url: server.url } }, dryRun: false }, { isolation: "inline" });
  } finally {
    await server.close();
  }
}

describe("jira-status-transitions", () => {
  it("attaches the newest Jira move that matches, as the person who made it", async () => {
    const r = await runPlugin([page([
      history("10", "2026-10-01T10:00:00.000+0000", "QA", "In Development"),
      history("11", "2026-10-02T10:00:00.000+0000", "In Development", "QA"),
      history("12", "2026-10-03T10:00:00.000-0600", "qa", "in development"),
    ])]);
    expect(r.error).toBeUndefined();
    expect(r.attached).toEqual([{ kind: "status", key: "jira:SR-1:12", from: "in-qa", to: "qa-rejected", text: "QA moved the Jira ticket",
                                  at: "2026-10-03T16:00:00.000Z", author: "acc-q", author_name: "Quinn" }]);
  });

  it("reads the last page of a long changelog", async () => {
    const r = await runPlugin([
      page([], 0, 150),
      page([history("200", "2026-10-03T10:00:00.000+0000", "QA", "In Development")], 50, 150),
    ]);
    expect(r.attached.map((a) => a.key)).toEqual(["jira:SR-1:200"]);
  });

  it("attaches nothing when no Jira move matches", async () => {
    const r = await runPlugin([page([history("10", "2026-10-01T10:00:00.000+0000", "QA", "Blocked")])]);
    expect(r.attached).toEqual([]);
  });

  it("doesn't call Jira while the item is in another status", async () => {
    const r = await runPlugin([], { status: "in-progress" });
    expect(r.skipped).toMatch(/when is false/);
  });

  it("writes a default note when none is set", async () => {
    const r = await runPlugin([page([history("10", "2026-10-01T10:00:00.000+0000", "QA", "In Development")])], {}, { ...RULE, note: "" });
    expect(r.attached[0]).toMatchObject({ text: "Jira moved SR-1 from QA to In Development" });
  });

  it("can't move an item as a custom plugin", async () => {
    const r = await runPlugin([page([history("10", "2026-10-01T10:00:00.000+0000", "QA", "In Development")])], {}, RULE, false);
    expect(r.error).toMatch(/only plugins shipped with todo may declare move-status/);
  });
});

let w: World;
beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_SECRET_KEY", "");
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", "");
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
  SHIPPED["test-move"] = { def: { connections: [], on: ["push"], capabilities: ["move-status"],
    steps: [{ name: "v", value: "`1`" }],
    attach: [{ key: "jira:SR-1:12", status: { from: "in-qa", to: "qa-rejected", text: "QA moved the Jira ticket", at: "{{event.branch}}",
                                               author: "acc-q", author_name: "Quinn" } }] } };
});
afterEach(() => {
  delete SHIPPED["test-move"];
});

const hostDeps = { sleep: async () => {}, guard: { allow: [], lookup: publicDns } };
const notes = () => w.d.query("select uid, kind, text, author, meta->>'with_status' as with_status from notes where item_uid = 'I1' and kind <> 'link' order by n");
const status = async () => (await w.d.query("select status from items where uid = 'I1'"))[0].status;

/** The item in QA, and a run whose Jira move happened at `at`. */
async function moveAt(at: string, gh: Awaited<ReturnType<typeof configured>>) {
  await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: at }, "alice");
  await flushPluginRuns(w.d, { fetch: gh.impl, host: hostDeps }, 50);
}

async function inQa() {
  await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web" } }));
  await w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1", data: { status: "in-qa" } });
  await w.d.query("delete from plugin_events");
}

describe("a status move", () => {
  it("moves the item once, with its note, as the Jira person mapped to a todo user", async () => {
    await w.d.query("update users set jira_account_id = 'acc-q' where handle = 'bob'");
    const gh = await configured(w.d, { file: "plugins:\n  test-move: {use: shipped}\n" });
    await inQa();
    await moveAt(new Date(Date.now() + 60_000).toISOString(), gh);
    expect(await status()).toBe("qa-rejected");
    expect(await notes()).toEqual([{ uid: pluginUid("test-move/default", "I1", "jira:SR-1:12"), kind: "qa-rejection",
                                     text: "QA moved the Jira ticket", author: "bob", with_status: "qa-rejected" }]);
    const [h] = await w.d.query("select by from status_history where item_uid = 'I1' and to_status = 'qa-rejected'");
    expect(h.by).toBe("bob");
    const queued = await w.d.query("select event from plugin_events where done_at is null");
    expect(queued.map((e) => e.event)).toContainEqual({ type: "status", from: "in-qa", to: "qa-rejected" });

    await w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1", data: { status: "in-qa" } });
    await moveAt(new Date(Date.now() + 120_000).toISOString(), gh);
    expect(await status()).toBe("in-qa");
    expect(await notes()).toHaveLength(1);
  });

  it("leaves the item when Jira moved before the item last did", async () => {
    const gh = await configured(w.d, { file: "plugins:\n  test-move: {use: shipped}\n" });
    await inQa();
    await moveAt("2020-01-01T00:00:00.000Z", gh);
    expect(await status()).toBe("in-qa");
    const [r] = await w.d.query("select result from plugin_runs order by id desc limit 1");
    expect(r.result.log).toContainEqual(expect.stringMatching(/happened before the item last moved/));
  });

  it("leaves an item that isn't in the move's from status", async () => {
    const gh = await configured(w.d, { file: "plugins:\n  test-move: {use: shipped}\n" });
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web" } }));
    await moveAt(new Date(Date.now() + 60_000).toISOString(), gh);
    expect(await status()).toBe("in-progress");
  });

  it("only records the move in test mode", async () => {
    const gh = await configured(w.d, { file: "plugins:\n  test-move: {use: shipped}\n" });
    const put = await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, {
      repo: "acme/web", plugin: "test-move", instances: [{ id: "default", name: "default", dry_run: true }] }), params("p"));
    expect(put.status).toBe(200);
    await inQa();
    await moveAt(new Date(Date.now() + 60_000).toISOString(), gh);
    expect(await status()).toBe("in-qa");
    const [r] = await w.d.query("select result from plugin_runs order by id desc limit 1");
    expect(r.result.attached).toEqual([expect.objectContaining({ kind: "status", to: "qa-rejected" })]);
  });
});
