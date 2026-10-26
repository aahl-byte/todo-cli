import { describe, expect, it } from "vitest";
import { configurable, connectionNotice, enableLine, stateLine, TRACK_EXAMPLE } from "@/lib/plugin-summary";

const inst = (over: Record<string, unknown> = {}) => ({
  id: "default", name: "default", server_runs: true, server_runs_reason: null, from_repo: false, ...over,
});
const plugin = (over: Record<string, unknown> = {}) => ({ settings: {}, exclusive: false, on: ["push", "pr"], instances: [inst()], ...over }) as never;

describe("which plugins get a Configure form", () => {
  it("leaves out a plugin with no settings and its one plain default instance", () => {
    expect(configurable(plugin())).toBe(false);
  });

  it("gives one to a plugin with settings, several instances, none, a first-match order, or a button", () => {
    expect(configurable(plugin({ settings: { to: { label: "To", type: "text" } } }))).toBe(true);
    expect(configurable(plugin({ instances: [inst(), inst({ id: "b" })] }))).toBe(true);
    expect(configurable(plugin({ instances: [] }))).toBe(true);
    expect(configurable(plugin({ exclusive: true }))).toBe(true);
    expect(configurable(plugin({ on: ["manual"] }))).toBe(true);
  });

  it("gives one to a single instance someone changed, so it can be changed back", () => {
    for (const over of [{ enabled: false }, { dry_run: true }, { on: ["push"] }, { id: "mine" }, { from_repo: true }]) {
      expect(configurable(plugin({ instances: [inst(over)] })), JSON.stringify(over)).toBe(true);
    }
  });
});

describe("a plugin's state in one line", () => {
  it("says where its one instance runs", () => {
    expect(stateLine(plugin())).toEqual({ text: "on · runs on the server", hot: false });
    expect(stateLine(plugin({ instances: [inst({ server_runs: false, server_runs_reason: "`hooks` not authorized here" })] })))
      .toEqual({ text: "on · runs in a developer's CLI: `hooks` not authorized here", hot: false });
    expect(stateLine(plugin({ instances: [inst({ dry_run: true })] }))).toEqual({ text: "on · runs on the server, in dry run", hot: false });
  });

  it("counts several instances by where they run", () => {
    const p = plugin({ instances: [inst(), inst({ id: "b" }), inst({ id: "c", server_runs: false, server_runs_reason: "x" }), inst({ id: "d", enabled: false })] });
    expect(stateLine(p)).toEqual({ text: "on · 3 instances: 2 on the server, 1 in a developer's CLI · 1 switched off", hot: false });
  });

  it("flags one that's on but has nothing to run", () => {
    expect(stateLine(plugin({ instances: [] }))).toEqual({ text: "on, with no instance yet: configure one to run it", hot: true });
    expect(stateLine(plugin({ instances: [inst({ enabled: false })] }))).toEqual({ text: "every instance is switched off", hot: false });
  });
});

describe("the lines a person adds to the plugins file", () => {
  it("turns a shipped plugin on and names deploy branches", () => {
    expect(enableLine("vercel-preview")).toBe("vercel-preview: {use: shipped}");
    expect(TRACK_EXAMPLE).toBe("track: [staging, main]");
  });
});

describe("which connections a plugin shows", () => {
  const conn = (over: Record<string, unknown>) => ({ name: "hooks", origin: "repo", kind: "http", url: "https://h", needsSecret: true, command: false, held: false,
                                                    usedBy: ["ping"], ...over }) as never;

  it("shows a repo connection's credential, stored or not, since a person sets and clears it here", () => {
    expect(connectionNotice(true, conn({}))).toEqual({ text: "no credential on this server", hot: true, form: true });
    expect(connectionNotice(true, conn({ held: true }))).toEqual({ text: "credential stored", hot: false, form: true });
  });

  it("names who fixes a missing server secret or a connection declared nowhere", () => {
    expect(connectionNotice(true, conn({ origin: "host", name: "vercel" })))
      .toEqual({ text: "this server has no secret for it: its operator sets TODO_PLUGIN_SECRET_VERCEL", hot: true, form: false });
    expect(connectionNotice(true, conn({ origin: "host", name: "github" })))
      .toEqual({ text: "this server has no secret for it: its operator sets GITHUB_TOKEN", hot: true, form: false });
    expect(connectionNotice(true, conn({ origin: "missing", name: "jira", kind: null })))
      .toEqual({ text: "declared nowhere: add it under connections: in the plugins file, or the server's operator adds it to TODO_PLUGIN_CONNECTIONS",
                 hot: true, form: false });
  });

  it("tells a repo plugin to declare its own connection, since the server's go only to shipped plugins", () => {
    expect(connectionNotice(false, conn({ origin: "missing", kind: null })))
      .toEqual({ text: "declared nowhere: add it under connections: in the plugins file", hot: true, form: false });
    expect(connectionNotice(false, conn({ origin: "host", held: true, name: "github" })))
      .toEqual({ text: "this server's own, which only plugins shipped with todo get: declare it under connections: in the plugins file", hot: true, form: false });
  });

  it("hides what needs nothing: a server connection with its secret, one with no secret, a local command", () => {
    expect(connectionNotice(true, conn({ origin: "host", held: true }))).toBeNull();
    expect(connectionNotice(true, conn({ needsSecret: false }))).toBeNull();
    expect(connectionNotice(true, conn({ command: true, kind: "mcp", needsSecret: false }))).toBeNull();
  });
});
