import { describe, expect, it } from "vitest";
import { automationRows, lastRun, pickRepo, repoChoices, splitBranches, suggestBranches, type AutomationRow, type RowContext } from "@/lib/automation";
import type { BridgeFacts, DashConnection, DashCustom, DashPlugin, DashRepo, HostConnection, RepoEntry, RunRow } from "@/lib/plugin-views";
import { services } from "@/lib/services";

const entry = (repo: string, over: Partial<RepoEntry> = {}): RepoEntry => ({
  repo, listed: null, checkout: false, items: 1, folded: false, refusal: null, addable: false, ...over,
});

const inst = (over: Record<string, unknown> = {}) => ({
  id: "default", name: "default", server_runs: true, server_runs_reason: null, ...over,
}) as DashPlugin["instances"][number];

const plugin = (name: string, over: Partial<DashPlugin> = {}): DashPlugin => ({
  name, description: null, shipped: true, always: false, connections: [], on: ["push"], every: null, exclusive: false, per: null, code: false,
  settings: {}, instances: [inst()], capabilities: [], grant: null, runs: {}, ...over,
});

const conn = (name: string, over: Partial<DashConnection> = {}): DashConnection => ({
  name, origin: "repo", kind: "http", url: "https://x.example", auth: "bearer", needsSecret: true, command: false, held: false, usedBy: [], ...over,
});

const prLink = plugin("pr-link", { always: true, connections: ["github"] });

const repo = (over: Partial<DashRepo> = {}): DashRepo => ({
  ...entry("acme/web"),
  track: [], branches: { names: ["main", "feat/x", "staging"], default: "main", visible: true }, plugins: [prLink], offered: [], custom: [],
  connections: [conn("github", { origin: "host", held: true, usedBy: ["pr-link"] })],
  available: { repo: [], host: ["github"] }, github: "server", errors: [], updated: null, ...over,
});

const custom = (name: string, over: Partial<DashCustom> = {}): DashCustom => ({
  name, manifest: "on: [manual]\n", code: null, codeFile: null, errors: [], version: 1, updated: { by: "pat", at: "2026-10-26T10:00:00.000Z" }, ...over,
});

const offer = (name: string, connections: string[] = []) => ({ name, description: `${name} does things.`, connections });

const bridge = (over: { jira?: Partial<BridgeFacts["jira"]>; actions?: BridgeFacts["actions"] } = {}): BridgeFacts => ({
  jira: { triggers: 0, writes: true, readOnly: false, polled: null, linked: 0, ...over.jira }, actions: over.actions ?? [],
});

const host = (name: string, over: Partial<HostConnection> = {}): HostConnection => ({
  name, source: "server", kind: "http", url: `https://${name}.example`, auth: "bearer", held: false, unreadable: false, refused: false, privateOk: null,
  version: null, updated: null, ...over,
});

const SERVICES = services({ github: "https://api.github.com", jira: null, watchtower: "http://127.0.0.1:10010/latest" });

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  project: "web", bridge: bridge(), host: [host("github", { held: true })], services: SERVICES, ...over,
});

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

describe("a repo nobody has set up", () => {
  const rows = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"]), offer("db-request", ["db-request"])] }), ctx());

  it("shows pr-link on, deploy branches first among what's off, then the other shipped plugins", () => {
    expect(states(rows)).toEqual([["pr-link", "on"], ["track", "off"], ["vercel-preview", "off"], ["db-request", "off"]]);
  });

  it("phrases each row as what happens to items, the plugin name aside", () => {
    expect(row(rows, "pr-link")).toMatchObject({ title: "Link each branch's pull request", plugins: ["pr-link"], last: null });
    expect(row(rows, "track").title).toBe("Show where work has landed");
    expect(row(rows, "track").offers).toContain("in staging ✓ · in main ✗");
  });

  it("asks for the deploy branches here, and gives each shipped plugin a switch, with nothing for anyone to commit", () => {
    expect(row(rows, "track")).toMatchObject({ branches: true, steps: [
      { text: "Name the branches work deploys from, such as staging and main.", done: false, setup: true }] });
    expect(row(rows, "vercel-preview").toggle).toEqual({ plugin: "vercel-preview", on: false });
    expect(row(rows, "pr-link").toggle).toBeUndefined();
  });

  it("lists the steps that follow switching one on, every one taken on this page", () => {
    expect(row(rows, "vercel-preview")).toMatchObject({
      offers: "Items would link the newest ready Vercel preview of each of their branches.",
      steps: [
        { text: "Enter the Vercel project and team, once it's switched on.", done: false },
        { text: "Connect todo to Vercel with a token.", done: false },
      ],
    });
    expect(row(rows, "vercel-preview").steps[0].setup).toBeFalsy();
    expect(row(rows, "vercel-preview").steps[1].connect).toBeUndefined();
    expect(row(rows, "db-request").steps).toEqual([{ text: "Give todo db-request's address.", done: false }]);
    expect(JSON.stringify(rows)).not.toMatch(/TODO_|GITHUB_TOKEN|admin/i);
  });

  it("marks the connection done when the project or the server holds its token", () => {
    const held = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"])] }), ctx({ host: [host("vercel", { held: true })] }));
    expect(row(held, "vercel-preview").steps[1]).toEqual({ text: "Connected to Vercel through the server's connection.", done: true });
    const own = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"])] }), ctx({ host: [host("vercel", { held: true, source: "page" })] }));
    expect(row(own, "vercel-preview").steps[1]).toEqual({ text: "Connected to Vercel.", done: true });
    const noToken = automationRows(repo({ offered: [offer("vercel-preview", ["vercel"])] }), ctx({ host: [host("vercel")] }));
    expect(row(noToken, "vercel-preview").steps[1]).toEqual({ text: "Enter Vercel's token.", done: false });
  });

  it("asks for a GitHub token that can see a repo GitHub doesn't show, which git facts need, in the row", () => {
    const hidden = automationRows(repo({ branches: { names: [], default: null, visible: false } }), ctx());
    expect(row(hidden, "track").steps).toEqual([
      { text: "The server's GitHub token can't see acme/web: give the project a token that can read its branches, commits and pull requests.",
        done: false, connect: "github" },
      { text: "Name the branches work deploys from, such as staging and main.", done: false, setup: true }]);
    const own = automationRows(repo({ github: "page", branches: { names: [], default: null, visible: false } }), ctx());
    expect(row(own, "track").steps[0].text).toMatch(/^This project's GitHub token can't see acme\/web/);
  });
});

describe("a repo todo has no GitHub token for", () => {
  const p = plugin("watchtower-session", { connections: ["watchtower"],
    instances: [inst({ server_runs: false, server_runs_reason: "todo has no GitHub token that reads this repo" })] });
  const rows = automationRows(repo({ github: null, plugins: [prLink, p],
    connections: [conn("watchtower", { origin: "missing", kind: null, usedBy: ["watchtower-session"] })] }), ctx({ host: [] }));
  const ask = { text: "Give todo a GitHub token that can read acme/web, so it can see the repo's branches, commits and pull requests.", done: false, connect: "github" };

  it("asks for one first, in each row that needs it, since nothing runs without it", () => {
    expect(row(rows, "track").steps[0]).toEqual(ask);
    expect(row(rows, "pr-link")).toMatchObject({ state: "setup", steps: [ask] });
    expect(row(rows, "watchtower-session")).toMatchObject({ state: "setup", steps: [ask, { text: "Give todo Watchtower's address.", done: false, connect: "watchtower" }] });
    expect(row(rows, "watchtower-session").notes.some((n) => n.warn)).toBe(false);
  });
});

describe("deploy branches", () => {
  it("are on once set, naming them", () => {
    const rows = automationRows(repo({ track: ["staging", "main"] }), ctx());
    expect(row(rows, "track")).toMatchObject({ state: "on", title: "Show where work has landed (staging, main)", steps: [], branches: true });
    expect(row(rows, "track").notes).toEqual([{ text: "Items show which of these deploy branches hold their work, and dependencies are checked against them." }]);
    expect(rows[0].key).toBe("track");
  });

  it("need setup while GitHub doesn't show the server the repo", () => {
    const rows = automationRows(repo({ track: ["main"], branches: { names: [], default: null, visible: false } }), ctx());
    expect(row(rows, "track")).toMatchObject({ state: "setup", steps: [{ connect: "github", done: false }] });
  });

  it("are typed with commas or spaces, and suggested from the remote's default and deploy-like branches", () => {
    expect(splitBranches(" staging, main  main,release/1 ")).toEqual(["staging", "main", "release/1"]);
    expect(splitBranches("")).toEqual([]);
    const branches = { names: ["trunk", "feat/x", "production", "staging", "wip"], default: "trunk", visible: true };
    expect(suggestBranches(branches, [])).toEqual(["trunk", "production", "staging"]);
    expect(suggestBranches(branches, ["staging"])).toEqual(["trunk", "production"]);
    expect(suggestBranches({ names: [], default: null, visible: null }, [])).toEqual([]);
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
    expect(r.steps).toEqual([]);
    expect(r.toggle).toEqual({ plugin: "watchtower-session", on: true });
  });
});

describe("a plugin switched on that needs setup", () => {
  it("asks for an instance here when it has none", () => {
    const p = plugin("vercel-preview", { connections: ["vercel"], instances: [],
      settings: { project: { label: "Vercel project id", type: "text" }, team: { label: "Vercel team id", type: "text" } } });
    const r = row(automationRows(repo({ plugins: [prLink, p], connections: [conn("vercel", { origin: "host", usedBy: ["vercel-preview"] })] }),
      ctx({ host: [host("vercel")] })), "vercel-preview");
    expect(r.state).toBe("setup");
    expect(r.steps).toEqual([
      { text: "Enter the Vercel project and team.", done: false, setup: true },
      { text: "Enter Vercel's token.", done: false, connect: "vercel" },
    ]);
  });

  it("asks for the token in the row when nothing connects todo to the service yet, the address filled in", () => {
    const p = plugin("vercel-preview", { connections: ["vercel"], instances: [inst({ settings: { project: "prj", team: "tm" } })],
      settings: { project: { label: "Vercel project id", type: "text" }, team: { label: "Vercel team id", type: "text" } } });
    const r = row(automationRows(repo({ plugins: [prLink, p], connections: [conn("vercel", { origin: "missing", kind: null, url: null, usedBy: ["vercel-preview"] })] }),
      ctx()), "vercel-preview");
    expect(r.state).toBe("setup");
    expect(r.steps).toEqual([{ text: "Enter the Vercel project and team.", done: true }, { text: "Connect todo to Vercel with a token.", done: false, connect: "vercel" }]);
    expect(SERVICES.find((s) => s.name === "vercel")).toMatchObject({ url: "https://api.vercel.com", auth: "bearer", tokenUrl: "https://vercel.com/account/tokens" });
    const jira = automationRows(repo({ plugins: [prLink, plugin("jira-issue", { connections: ["jira"] })],
      connections: [conn("jira", { origin: "missing", usedBy: ["jira-issue"] })] }), ctx());
    expect(row(jira, "jira-issue").steps).toEqual([{ text: "Connect todo to Jira with an email and API token.", done: false, connect: "jira" }]);
  });

  it("asks in the row to allow a connection the private-address rule refuses, or to enter a credential that doesn't decrypt again", () => {
    const p = plugin("watchtower-session", { connections: ["watchtower"] });
    const at = (over: Partial<HostConnection>) => row(automationRows(repo({ plugins: [prLink, p],
      connections: [conn("watchtower", { origin: "host", needsSecret: false, usedBy: ["watchtower-session"] })] }),
      ctx({ host: [host("watchtower", { url: "http://127.0.0.1:10010/latest", auth: null, ...over })] })), "watchtower-session");
    expect(at({ refused: true }).steps).toEqual([{ text: "Allow todo to call Watchtower at http://127.0.0.1:10010/latest, which is on your private network.",
                                                   done: false, connect: "watchtower" }]);
    expect(at({ unreadable: true }).steps[0]).toMatchObject({ text: "Enter the Watchtower credential again: the stored one doesn't decrypt on this server.", connect: "watchtower" });
    expect(at({ source: "page" })).toMatchObject({ state: "on", steps: [{ text: "Connected to Watchtower.", done: true, connect: "watchtower" }] });
  });

  it("adds in the row a connection a web-request button names that nothing declares", () => {
    const rest = plugin("rest", { connections: ["{{settings.connection}}"], on: ["manual"], instances: [inst({ id: "hook", settings: { connection: "hooks" } })],
      settings: { connection: { label: "Connection", type: "text" } } });
    const r = row(automationRows(repo({ plugins: [prLink, rest], connections: [conn("hooks", { origin: "missing", kind: null, usedBy: ["rest"] })] }), ctx()), "rest");
    expect(r.steps).toEqual([{ text: "Set the button's connection and request.", done: true },
                             { text: "Add the hooks connection: where it is and how it authorizes.", done: false, connect: "hooks" }]);
  });

  it("names the required settings an instance left empty", () => {
    const p = plugin("notes", { shipped: false, description: "Links the item to its notes page.",
      settings: { url: { label: "Notes URL", type: "text" }, title: { label: "Title", type: "text", default: "Notes" } } });
    const r = row(automationRows(repo({ plugins: [prLink, p] }), ctx()), "notes");
    expect(r).toMatchObject({ state: "setup", title: "Links the item to its notes page", plugins: ["notes"] });
    expect(r.steps).toEqual([{ text: "Fill in Notes URL.", done: false, setup: true }]);
  });

  it("asks for a repo connection's credential here, and shows it done once stored", () => {
    const p = plugin("ping", { shipped: false, connections: ["hooks"], instances: [inst({ server_runs: false, server_runs_reason: "`hooks` not authorized here" })] });
    const missing = row(automationRows(repo({ plugins: [prLink, p], connections: [conn("hooks", { usedBy: ["ping"] })] }), ctx()), "ping");
    expect(missing).toMatchObject({ state: "setup", title: "ping", steps: [{ text: "Enter the hooks credential.", done: false, setup: true }] });
    expect(missing.notes).toEqual([{ text: "A custom plugin of this repo; its YAML gives no description." }]);
    const held = row(automationRows(repo({ plugins: [prLink, plugin("ping", { shipped: false, connections: ["hooks"] })],
      connections: [conn("hooks", { usedBy: ["ping"], held: true })] }), ctx()), "ping");
    expect(held).toMatchObject({ state: "on", steps: [{ text: "hooks credential stored.", done: true }] });
  });

  it("tells a custom plugin to declare a connection here, the server's own being for shipped plugins only", () => {
    const p = plugin("ping", { shipped: false, connections: ["hooks"], instances: [inst({ server_runs: false, server_runs_reason: "x" })] });
    const r = row(automationRows(repo({ plugins: [p], custom: [custom("ping")], connections: [conn("hooks", { origin: "missing", usedBy: ["ping"] })] }), ctx()), "ping");
    expect(r.steps).toEqual([{ text: "Add a connection named hooks under Connections.", done: false }]);
    expect(r.custom?.name).toBe("ping");
    expect(r.toggle).toBeUndefined();
    const wt = plugin("wt", { shipped: false, connections: ["watchtower"], instances: [inst({ server_runs: false, server_runs_reason: "x" })] });
    const onHost = row(automationRows(repo({ plugins: [wt], connections: [conn("watchtower", { origin: "host", usedBy: ["wt"] })] }),
      ctx({ host: [host("watchtower", { auth: null })] })), "wt");
    expect(onHost.steps).toEqual([{ text: "Add a connection named watchtower under Connections: only plugins that ship with todo use the project's own.", done: false }]);
  });

  it("shows a custom plugin whose YAML doesn't load, so it can be fixed", () => {
    const rows = automationRows(repo({ custom: [custom("broken", { errors: ['unknown key "wat"'] })] }), ctx());
    expect(row(rows, "broken")).toMatchObject({ state: "setup", custom: { name: "broken" }, plugin: null,
      notes: [{ text: "Its YAML has problems, so it doesn't run: unknown key \"wat\".", warn: true }],
      steps: [{ text: "Fix its YAML.", done: false, setup: true }] });
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
    expect(r.steps[0]).toEqual({ text: "Switch it on: it's switched off here.", done: false, setup: true });
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
    expect(row(rows, "jira-transition").toggle).toEqual({ plugin: "jira-transition", on: false });
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
      ctx({ ...busy, host: [host("jira", { auth: "basic", held: true, source: "page" })] })), "jira-transition");
    expect(r.state).toBe("on");
    expect(r.notes).toEqual([{ text: "The Jira bridge also moves tickets with 15 triggers, so both would send.",
                               link: { label: "General → Jira", href: "/p/web/settings#jira" } }]);
    expect(r.steps.map((s) => [s.text, s.done])).toEqual([["Pick the Jira status for each move.", true], ["Connected to Jira.", true]]);
  });
});
