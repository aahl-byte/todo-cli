import { describe, expect, it } from "vitest";
import { configurable, connectionNotice } from "@/lib/plugin-summary";

const inst = (over: Record<string, unknown> = {}) => ({
  id: "default", name: "default", server_runs: true, server_runs_reason: null, ...over,
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
    for (const over of [{ enabled: false }, { dry_run: true }, { on: ["push"] }, { id: "mine" }]) {
      expect(configurable(plugin({ instances: [inst(over)] })), JSON.stringify(over)).toBe(true);
    }
  });
});

describe("which connections a plugin shows", () => {
  const conn = (over: Record<string, unknown>) => ({ name: "hooks", origin: "repo", kind: "http", url: "https://h", needsSecret: true, command: false, held: false,
                                                    usedBy: ["ping"], ...over }) as never;

  it("shows a repo connection's credential, stored or not, since a person sets and clears it here", () => {
    expect(connectionNotice(true, conn({}))).toEqual({ text: "No credential on this server. Set one so the server can call it.", hot: true, form: true });
    expect(connectionNotice(true, conn({ held: true }))).toEqual({ text: "Credential stored.", hot: false, form: true });
  });

  it("names who fixes a missing server secret or a connection declared nowhere", () => {
    expect(connectionNotice(true, conn({ origin: "host", name: "vercel" })))
      .toEqual({ text: "The server has no secret for it. Its admin sets TODO_PLUGIN_SECRET_VERCEL.", hot: true, form: false });
    expect(connectionNotice(true, conn({ origin: "host", name: "github" })))
      .toEqual({ text: "The server has no secret for it. Its admin sets GITHUB_TOKEN.", hot: true, form: false });
    expect(connectionNotice(true, conn({ origin: "missing", name: "jira", kind: null })))
      .toEqual({ text: "Declared nowhere. Add it under Connections below, or the server's admin adds it to TODO_PLUGIN_CONNECTIONS.",
                 hot: true, form: false });
  });

  it("tells a custom plugin to declare its own connection, since the server's go only to shipped plugins, github aside", () => {
    expect(connectionNotice(false, conn({ origin: "missing", kind: null })))
      .toEqual({ text: "Declared nowhere. Add it under Connections below.", hot: true, form: false });
    expect(connectionNotice(false, conn({ origin: "host", held: true, name: "watchtower" })))
      .toEqual({ text: "Only plugins that ship with todo get this server's connections. Add one of this repo's own under Connections below.", hot: true, form: false });
    expect(connectionNotice(false, conn({ origin: "host", held: true, name: "github" }))).toBeNull();
  });

  it("hides what needs nothing: a server connection with its secret, one with no secret, a local command", () => {
    expect(connectionNotice(true, conn({ origin: "host", held: true }))).toBeNull();
    expect(connectionNotice(true, conn({ needsSecret: false }))).toBeNull();
    expect(connectionNotice(true, conn({ command: true, kind: "mcp", needsSecret: false }))).toBeNull();
  });
});
