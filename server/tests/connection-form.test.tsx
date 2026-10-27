// The connection form on Settings → Automation: a known service starts filled in, so a person only pastes the token.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "@/lib/plugin-views";
import { services } from "@/lib/services";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
const { ConnectionForm, connectionState } = await import("@/components/ConnectionForm");

const SERVICES = services({ github: "https://api.github.com", jira: "https://acme.atlassian.net", watchtower: "http://127.0.0.1:10010/latest" });
const service = (name: string) => SERVICES.find((s) => s.name === name)!;
const host = (name: string, over: Partial<HostConnection> = {}): HostConnection => ({
  name, source: "page", kind: "http", url: `https://${name}.example`, auth: "bearer", held: true, unreadable: false, refused: false, privateOk: null,
  version: 1, updated: { by: "pat", at: "2026-10-27T10:00:00.000Z" }, ...over,
});
const form = (name: string | null, current: HostConnection | null, secretProblem: string | null = null) => renderToStaticMarkup(
  <ConnectionForm projectKey="web" name={name} current={current} service={name ? service(name) : null} secretProblem={secretProblem}
                  onDone={() => undefined} onCancel={() => undefined} />);

describe("the connection form", () => {
  it("starts a service nothing connects yet at its usual address and auth, with a link to make its token", () => {
    const out = form("vercel", null);
    expect(out).toContain('aria-label="Vercel address" placeholder="https://api.vercel.com" value="https://api.vercel.com"');
    expect(out).toMatch(/<option value="bearer" selected="">a bearer token<\/option>/);
    expect(out).toContain('aria-label="Vercel token"');
    expect(out).toContain('href="https://vercel.com/account/tokens"');
    expect(out).not.toMatch(/TODO_|GITHUB_TOKEN|admin/i);
  });

  it("asks Jira for the email and API token, and GitHub for its token alone", () => {
    const jira = form("jira", null);
    expect(jira).toContain('value="https://acme.atlassian.net"');
    expect(jira).toContain('aria-label="Jira email"');
    expect(jira).toContain('aria-label="Jira api token"');
    const github = form("github", null);
    expect(github).not.toContain("GitHub address");
    expect(github).toContain('aria-label="GitHub token"');
    expect(github).toContain("https://github.com/settings/personal-access-tokens/new");
  });

  it("asks for a name for a new connection, and says plainly when tokens can't be saved", () => {
    expect(form(null, null)).toContain('aria-label="connection name"');
    const off = form("vercel", null, "TODO_SECRET_KEY isn't set on the server, so it can't store secrets");
    expect(off).toContain("Tokens can&#x27;t be saved here: TODO_SECRET_KEY isn&#x27;t set on the server, so it can&#x27;t store secrets.");
    expect(off).toMatch(/aria-label="Vercel token"[^>]*disabled=""/);
  });

  it("offers to allow a private address the rule refuses, and shows who allowed one", () => {
    expect(form("watchtower", host("watchtower", { source: "server", url: "http://127.0.0.1:10010/latest", auth: null, refused: true, version: null })))
      .toContain("This address is on your private network: allow todo to call it");
    expect(form("watchtower", host("watchtower", { url: "http://127.0.0.1:10010/latest", auth: null, privateOk: { by: "pat", at: "2026-10-27T10:00:00.000Z" } })))
      .toContain("Private address allowed by pat");
  });
});

describe("a connection's state in a line", () => {
  it("says what it still needs, or whose it is", () => {
    expect(connectionState(null, service("vercel"))).toEqual({ text: "Not connected yet.", hot: true });
    expect(connectionState(null, service("watchtower"))).toEqual({ text: "No address yet.", hot: true });
    expect(connectionState(host("github", { source: "server", auth: null, held: false }), service("github"))).toEqual({ text: "No token yet.", hot: true });
    expect(connectionState(host("vercel", { held: false }), service("vercel"))).toEqual({ text: "No token yet.", hot: true });
    expect(connectionState(host("vercel"), service("vercel"))).toEqual({ text: "Set by pat · https://vercel.example · token stored.", hot: false });
    expect(connectionState(host("jira", { source: "server" }), service("jira")).text).toBe("The server's connection · https://jira.example · token stored.");
  });
});
