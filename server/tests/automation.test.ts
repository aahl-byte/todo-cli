import { describe, expect, it } from "vitest";
import { automationRows, lastRun, pickRepo, repoChoices, type AutomationRow, type RowContext } from "@/lib/automation";
import type { BridgeFacts, DashConnection, DashPlugin, DashRepo, RepoEntry, RunRow } from "@/lib/plugin-views";

const entry = (repo: string, over: Partial<RepoEntry> = {}): RepoEntry => ({
  repo, listed: null, checkout: false, items: 1, folded: false, refusal: null, addable: false, ...over,
});

const inst = (over: Record<string, unknown> = {}) => ({
  id: "default", name: "default", server_runs: true, server_runs_reason: null, from_repo: false, ...over,
}) as DashPlugin["instances"][number];

const plugin = (name: string, over: Partial<DashPlugin> = {}): DashPlugin => ({
  name, description: null, shipped: true, always: false, connections: [], on: ["push"], every: null, exclusive: false, per: null, code: false,
  settings: {}, instances: [inst()], declared: {}, capabilities: [], grant: null, runs: {}, ...over,
});

const conn = (name: string, over: Partial<DashConnection> = {}): DashConnection => ({
  name, origin: "repo", kind: "http", url: "https://x.example", needsSecret: true, command: false, held: false, usedBy: [], ...over,
});

const prLink = plugin("pr-link", { always: true, connections: ["github"] });

const repo = (over: Partial<DashRepo> = {}): DashRepo => ({
  ...entry("acme/web"),
  source: { path: ".todo-plugins/plugins.yaml", branch: "main", exists: false, pluginsKey: false, commit: "abc1234def" },
  track: [], plugins: [prLink], offered: [], connections: [conn("github", { origin: "host", held: true, usedBy: ["pr-link"] })],
  available: { repo: [], host: ["github"] }, errors: [], ...over,
});

const offer = (name: string, connections: string[] = []) => ({ name, description: `${name} does things.`, connections });

const bridge = (over: { jira?: Partial<BridgeFacts["jira"]>; actions?: BridgeFacts["actions"] } = {}): BridgeFacts => ({
  jira: { triggers: 0, writes: true, readOnly: false, polled: null, linked: 0, ...over.jira }, actions: over.actions ?? [],
});

const ctx = (over: Partial<RowContext> = {}): RowContext => ({ project: "web", bridge: bridge(), host: [{ name: "github", auth: true, held: true }], ...over });

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 1, at: "2026-10-26T10:00:00.000Z", item: { id: "fix-login", title: "Fix login" }, event: { type: "push", branch: "feat/x" } as RunRow["event"],
  dryRun: false, attached: [], wouldSend: [], log: [], skipped: null, error: null, ...over,
});

const row = (rows: AutomationRow[], key: string) => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key} in ${rows.map((x) => x.key).join(", ")}`);
  return r;
};
const states = (rows: AutomationRow[]) => rows.map((r) => [r.key, r.state]);

describe("the repo picker", () => {
  const repos = [
    entry("acme/api", { items: 3 }), entry("acme/web", { items: 40 }), entry("acme/docs", { items: 9, refusal: "not ours", addable: true }),
    entry("acme/tools", { items: 0, folded: true, checkout: true }), entry("other/thing", { items: 2, refusal: "owner not read" }),
  ];

  it("lists readable repos by item count, checkout-only ones apart, and the ones the project can't read yet", () => {
    const c = repoChoices(repos);
    expect(c.main.map((r) => r.repo)).toEqual(["acme/web", "acme/api"]);
    expect(c.checkoutOnly.map((r) => r.repo)).toEqual(["acme/tools"]);
    expect(c.unconnected.map((r) => r.repo)).toEqual(["acme/docs", "other/thing"]);
  });

  it("shows the repo asked for, else the one most items name", () => {
    expect(pickRepo(repos, null)).toBe("acme/web");
    expect(pickRepo(repos, "acme/tools")).toBe("acme/tools");
    expect(pickRepo(repos, "acme/docs")).toBe("acme/web");
    expect(pickRepo(repos, "nope/nope")).toBe("acme/web");
    expect(pickRepo([entry("acme/tools", { folded: true, items: 0 })], null)).toBe("acme/tools");
    expect(pickRepo([entry("acme/docs", { refusal: "x" })], null)).toBeNull();
  });
});

describe("a repo with no plugins file", () => {
  const rows = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"]), offer("db-request", ["db-request"])] }), ctx());

  it("shows pr-link on, deploy branches first among what's off, then the other shipped plugins", () => {
    expect(states(rows)).toEqual([["pr-link", "on"], ["track", "off"], ["vercel-preview", "off"], ["db-request", "off"]]);
  });

  it("phrases each row as what happens to items, the plugin name aside", () => {
    expect(row(rows, "pr-link")).toMatchObject({ title: "Link each branch's pull request", plugins: ["pr-link"], last: null });
    expect(row(rows, "track").title).toBe("Show where work has landed");
    expect(row(rows, "track").offers).toContain("in staging ✓ · in main ✗");
  });

  it("gives the whole file to commit, since there is none, and who commits it where", () => {
    expect(row(rows, "track").steps).toEqual([{
      who: "repo", text: "A developer commits this line to .todo-plugins/plugins.yaml on main, naming your deploy branches.",
      code: "track: [staging, main]", done: false }]);
    expect(row(rows, "vercel-preview").steps[0]).toEqual({
      who: "repo", text: "A developer commits this to .todo-plugins/plugins.yaml on main.", code: "plugins:\n  vercel-preview: {use: shipped}", done: false });
  });

  it("lists the steps that follow turning one on: settings here once it's on, and what the server's admin connects", () => {
    expect(row(rows, "vercel-preview")).toMatchObject({
      offers: "Items would link the newest ready Vercel preview of each of their branches.",
      steps: [
        { who: "repo", done: false },
        { who: "here", text: "Enter the Vercel project and team, once it's turned on in the repo.", done: false },
        { who: "admin", text: "Connect the server to Vercel: its address and a token.", code: "TODO_PLUGIN_CONNECTIONS\nTODO_PLUGIN_SECRET_VERCEL", done: false },
      ],
    });
    expect(row(rows, "vercel-preview").steps[1].setup).toBeFalsy();
  });

  it("marks the server's side done when it already holds the connection and its token", () => {
    const held = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"])] }), ctx({ host: [{ name: "vercel", auth: true, held: true }] }));
    expect(row(held, "vercel-preview").steps[2]).toEqual({ who: "admin", text: "Server has a Vercel token.", done: true });
    const noToken = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"])] }), ctx({ host: [{ name: "vercel", auth: true, held: false }] }));
    expect(row(noToken, "vercel-preview").steps[2]).toEqual({ who: "admin", text: "Give the server a Vercel token.", code: "TODO_PLUGIN_SECRET_VERCEL", done: false });
  });

  it("asks the admin to let the server see a repo GitHub doesn't show it, before anything a developer commits", () => {
    const hidden = automationRows(repo({ source: { path: ".todo-plugins/plugins.yaml", branch: null, exists: false, pluginsKey: false, commit: null } }), ctx());
    expect(row(hidden, "track").steps.map((s) => [s.who, s.code])).toEqual([["admin", "GITHUB_TOKEN"], ["repo", "track: [staging, main]"]]);
    expect(row(hidden, "track").steps[1].text).toContain("on the default branch");
  });
});

describe("a repo with a plugins file", () => {
  const source = { path: ".todo-plugins/plugins.yaml", branch: "main", exists: true, pluginsKey: true, commit: "abc1234def" };

  it("shows deploy branches on, with the branches and where they were read", () => {
    const rows = automationRows(repo({ source, track: ["staging", "main"] }), ctx());
    expect(row(rows, "track")).toMatchObject({ state: "on", title: "Show where work has landed (staging, main)", steps: [] });
    expect(row(rows, "track").notes).toEqual([{ text: "Items show which of these deploy branches hold their work, and dependencies are checked against them." }]);
    expect(rows[0].key).toBe("track");
  });

  it("adds a plugin's line under the file's plugins: map", () => {
    const rows = automationRows(repo({ source, offered: [offer("db-request", ["db-request"])] }), ctx());
    expect(row(rows, "db-request").steps[0]).toMatchObject({
      text: "A developer adds this line under plugins: in .todo-plugins/plugins.yaml on main and commits it.", code: "  db-request: {use: shipped}" });
  });
});

describe("a plugin that's on", () => {
  it("names the last thing it did, the item, and when", () => {
    const p = plugin("pr-link", { always: true, runs: { default: [
      run({ id: 3, attached: [{ kind: "link", key: "k", type: "pr", url: "https://gh/pr/267", label: "#267 · Fix login" }] }),
      run({ id: 2, skipped: "pr-link: when is false" }),
    ] } });
    const [r] = automationRows(repo({ plugins: [p] }), ctx()).filter((x) => x.key === "pr-link");
    expect(r.state).toBe("on");
    expect(r.last).toEqual({ at: "2026-10-26T10:00:00.000Z", item: { id: "fix-login", title: "Fix login" }, did: "linked PR #267 · Fix login", detail: null, tone: "ok" });
  });

  it("passes over runs that skipped because the item didn't apply, unless that's all there is", () => {
    const p = plugin("pr-link", { runs: { default: [run({ id: 9, skipped: "pr-link: when is false" }), run({ id: 4, attached: [] })] } });
    expect(lastRun(p)?.did).toBe("found nothing new");
    expect(lastRun(plugin("x", { runs: { default: [run({ skipped: "when is false" })] } }))?.did).toBe("skipped");
    expect(lastRun(plugin("x"))).toBeNull();
  });

  it("says what a failed, skipped, test-mode or multi-attachment run did", () => {
    const one = (r: Partial<RunRow>) => lastRun(plugin("x", { runs: { a: [run(r)] } }));
    expect(one({ error: "Jira said 401" })).toMatchObject({ did: "failed", detail: "Jira said 401", tone: "fail" });
    expect(one({ skipped: "x: setting to is not set" })).toMatchObject({ did: "skipped", detail: "setting to is not set", tone: "warn" });
    expect(one({ dryRun: true, wouldSend: [{ connection: "jira" }, { connection: "jira" }] as RunRow["wouldSend"] }))
      .toMatchObject({ did: "would have sent 2 requests (test mode)" });
    expect(one({ attached: [{ kind: "edge", key: "e", needs: "https://gh/pr/9", because: "x" }, { kind: "log", key: "l", text: "hi" }] }))
      .toMatchObject({ did: "added a dependency and 1 more", detail: "needs https://gh/pr/9" });
  });

  it("is newest-first across instances", () => {
    const p = plugin("x", { runs: { a: [run({ id: 2, attached: [{ kind: "doc", name: "old.png" } as never] })], b: [run({ id: 5, attached: [{ kind: "doc", name: "new.png" } as never] })] } });
    expect(lastRun(p)?.did).toBe("attached new.png");
  });

  it("says it's in test mode when every instance is", () => {
    const p = plugin("watchtower-session", { instances: [inst({ dry_run: true })] });
    const r = row(automationRows(repo({ plugins: [prLink, p] }), ctx()), "watchtower-session");
    expect(r.state).toBe("on");
    expect(r.notes[0].text).toBe("In test mode: it shows what it would do without doing it.");
    expect(r.steps).toEqual([{ who: "repo", text: "Turned on.", done: true }]);
  });
});

describe("a plugin turned on in the repo that needs setup", () => {
  it("asks for an instance here when it has none, listing the turned-on step as done", () => {
    const p = plugin("vercel-preview", { connections: ["vercel"], instances: [],
      settings: { project: { label: "Vercel project id", type: "text" }, team: { label: "Vercel team id", type: "text" } } });
    const r = row(automationRows(repo({ plugins: [prLink, p], connections: [conn("vercel", { origin: "host", usedBy: ["vercel-preview"] })] }),
      ctx({ host: [{ name: "vercel", auth: true, held: false }] })), "vercel-preview");
    expect(r.state).toBe("setup");
    expect(r.steps).toEqual([
      { who: "repo", text: "Turned on.", done: true },
      { who: "here", text: "Enter the Vercel project and team.", done: false, setup: true },
      { who: "admin", text: "Give the server a Vercel token.", code: "TODO_PLUGIN_SECRET_VERCEL", done: false },
    ]);
  });

  it("names the required settings an instance left empty", () => {
    const p = plugin("notes", { shipped: false, description: "Links the item to its notes page.",
      settings: { url: { label: "Notes URL", type: "text" }, title: { label: "Title", type: "text", default: "Notes" } } });
    const r = row(automationRows(repo({ plugins: [prLink, p] }), ctx()), "notes");
    expect(r).toMatchObject({ state: "setup", title: "Links the item to its notes page", plugins: ["notes"] });
    expect(r.steps).toEqual([{ who: "here", text: "Fill in Notes URL.", done: false, setup: true }]);
  });

  it("asks for a repo connection's credential here, and shows it done once stored", () => {
    const p = plugin("ping", { shipped: false, connections: ["hooks"], instances: [inst({ server_runs: false, server_runs_reason: "`hooks` not authorized here" })] });
    const missing = row(automationRows(repo({ plugins: [prLink, p], connections: [conn("hooks", { usedBy: ["ping"] })] }), ctx()), "ping");
    expect(missing).toMatchObject({ state: "setup", title: "ping", steps: [{ who: "here", text: "Enter the hooks credential.", done: false, setup: true }] });
    expect(missing.notes).toEqual([{ text: "This repo's own plugin; its plugins file gives no description." }]);
    const held = row(automationRows(repo({ plugins: [prLink, plugin("ping", { shipped: false, connections: ["hooks"] })],
      connections: [conn("hooks", { usedBy: ["ping"], held: true })] }), ctx()), "ping");
    expect(held).toMatchObject({ state: "on", steps: [{ who: "here", text: "hooks credential stored.", done: true }] });
  });

  it("tells a repo's own plugin to declare a connection the repo file lacks", () => {
    const p = plugin("ping", { shipped: false, connections: ["hooks"], instances: [inst({ server_runs: false, server_runs_reason: "x" })] });
    const r = row(automationRows(repo({ plugins: [p], connections: [conn("hooks", { origin: "missing", usedBy: ["ping"] })] }), ctx()), "ping");
    expect(r.steps).toEqual([{ who: "repo", text: "A developer declares hooks under connections: in .todo-plugins/plugins.yaml.", done: false }]);
  });

  it("says why the server can't run it when no step explains it", () => {
    const p = plugin("ping", { shipped: false, instances: [inst({ server_runs: false, server_runs_reason: "connection `hooks` is refused by the private-address rule" })] });
    const r = row(automationRows(repo({ plugins: [p] }), ctx()), "ping");
    expect(r.state).toBe("setup");
    expect(r.notes[0]).toEqual({ text: "The server can't run it yet: connection `hooks` is refused by the private-address rule.", warn: true });
    expect(r.notes).toHaveLength(2);
  });

  it("is off, with a step to switch it on, when every instance is switched off here", () => {
    const p = plugin("watchtower-session", { instances: [inst({ enabled: false })] });
    const r = row(automationRows(repo({ plugins: [prLink, p] }), ctx()), "watchtower-session");
    expect(r.state).toBe("off");
    expect(r.offers).toContain("Claude session");
    expect(r.steps[1]).toEqual({ who: "here", text: "Switch it on: it's switched off here.", done: false, setup: true });
  });
});

describe("work the Jira bridge or Actions do today", () => {
  const offered = [offer("jira-transition", ["jira"]), offer("jira-issue", ["jira"]), offer("rest"), offer("watchtower-session", ["watchtower"])];
  const busy = ctx({ bridge: bridge({ jira: { triggers: 15, polled: "2026-10-26T09:00:00.000Z", linked: 12 },
                                      actions: [{ name: "Start agent", kind: "watchtower" }, { name: "Notify deploy", kind: "rest" }] }) });
  const rows = automationRows(repo({ offered }), busy);

  it("shows those plugins as elsewhere, not off, saying how many and where", () => {
    expect(states(rows)).toEqual([["pr-link", "on"], ["track", "off"], ["jira-transition", "elsewhere"], ["jira-issue", "elsewhere"],
                                  ["watchtower-session", "elsewhere"], ["rest", "elsewhere"]]);
    expect(row(rows, "jira-transition").notes).toEqual([{ text: "15 triggers in the Jira bridge move tickets today.",
                                                          link: { label: "General → Jira", href: "/p/web/settings#jira" } }]);
    expect(row(rows, "jira-issue").notes[0].text).toBe("The Jira bridge does this today, for 12 linked tickets.");
    expect(row(rows, "rest").notes[0]).toEqual({ text: "1 Action on the General tab does this today: \"Notify deploy\".",
                                                 link: { label: "General → Actions", href: "/p/web/settings#actions" } });
    expect(row(rows, "jira-transition").steps).toEqual([]);
  });

  it("says when the bridge only records what it would send", () => {
    const quiet = automationRows(repo({ offered }), ctx({ bridge: bridge({ jira: { triggers: 1, writes: false } }) }));
    expect(row(quiet, "jira-transition").notes[0].text).toBe("1 trigger in the Jira bridge moves tickets today; sending is off there, so it records the moves it would make.");
    expect(row(quiet, "jira-issue").state).toBe("off");
    const polled = automationRows(repo({ offered }), ctx({ bridge: bridge({ jira: { polled: "2026-10-26T09:00:00.000Z" } }) }));
    expect(row(polled, "jira-issue").notes[0].text).toBe("The Jira bridge does this today, once an item links a ticket.");
  });

  it("keeps a plugin that's on as on, adding that the bridge would send too", () => {
    const jt = plugin("jira-transition", { connections: ["jira"], instances: [inst({ id: "qa", settings: { to: "QA" } })],
      settings: { to: { label: "Jira status", type: "text" } } });
    const r = row(automationRows(repo({ plugins: [prLink, jt], connections: [conn("jira", { origin: "host", needsSecret: true, held: true, usedBy: ["jira-transition"] })] }),
      ctx({ ...busy, host: [{ name: "jira", auth: true, held: true }] })), "jira-transition");
    expect(r.state).toBe("on");
    expect(r.notes).toEqual([{ text: "The Jira bridge also moves tickets with 15 triggers, so both would send.",
                               link: { label: "General → Jira", href: "/p/web/settings#jira" } }]);
    expect(r.steps.map((s) => [s.who, s.done])).toEqual([["repo", true], ["here", true], ["admin", true]]);
  });
});
