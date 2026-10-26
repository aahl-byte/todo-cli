// What the Plugins settings page says in words: each plugin's state in one
// line, which plugins get a Configure form, which connections need a person,
// and the lines a person adds to a repo's plugins file. Pure, so the page and
// the tests share it.
import type { DashConnection, DashInstance, DashPlugin } from "./plugin-views";

export const PLUGINS_FILE = ".todo-plugins/plugins.yaml";
export const TRACK_EXAMPLE = "track: [staging, main]";
const DEFAULT_ID = "default";

/** The line under `plugins:` that turns a shipped plugin on. */
export const enableLine = (name: string) => `${name}: {use: shipped}`;

type Shape = Pick<DashPlugin, "settings" | "exclusive" | "on" | "instances">;

/** A plugin gets a form when there's something to set: settings, a choice of instances, a first-match order or a button
 * label, or a lone instance someone already changed, which the form changes back. */
export function configurable(p: Shape): boolean {
  if (Object.keys(p.settings ?? {}).length || p.exclusive || p.instances.length !== 1) return true;
  if ((p.on ?? []).includes("manual")) return true;
  const [i] = p.instances;
  return i.id !== DEFAULT_ID || i.enabled === false || !!i.dry_run || i.on !== undefined || !!i.button || i.from_repo;
}

const where = (i: DashInstance) => (i.server_runs ? "runs on the server" : `runs in a developer's CLI: ${i.server_runs_reason}`);

/** "on · runs on the server", or what keeps it from running. */
export function stateLine(p: Shape): { text: string; hot: boolean } {
  if (!p.instances.length) return { text: "on, with no instance yet: configure one to run it", hot: true };
  const on = p.instances.filter((i) => i.enabled !== false);
  if (!on.length) return { text: "every instance is switched off", hot: false };
  const off = p.instances.length - on.length;
  const offText = off ? ` · ${off} switched off` : "";
  if (on.length === 1) return { text: `on · ${where(on[0])}${on[0].dry_run ? ", in dry run" : ""}${offText}`, hot: false };
  const server = on.filter((i) => i.server_runs).length;
  const parts = [server && `${server} on the server`, on.length - server && `${on.length - server} in a developer's CLI`].filter(Boolean);
  return { text: `on · ${on.length} instances: ${parts.join(", ")}${offText}`, hot: false };
}

/** The environment variable that holds the secret for one of this server's connections. */
export const secretVar = (name: string) => (name === "github" ? "GITHUB_TOKEN" : `TODO_PLUGIN_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);

/** What a person can do about a connection a plugin uses, or null when it needs nothing. `form`: a credential is set here. */
export function connectionNotice(shipped: boolean, c: DashConnection): { text: string; hot: boolean; form: boolean } | null {
  if (c.origin === "missing") {
    return { text: `declared nowhere: add it under connections: in the plugins file${shipped ? ", or the server's operator adds it to TODO_PLUGIN_CONNECTIONS" : ""}`,
             hot: true, form: false };
  }
  if (c.origin === "host") {
    if (!shipped) return { text: "this server's own, which only plugins shipped with todo get: declare it under connections: in the plugins file", hot: true, form: false };
    return c.needsSecret && !c.held ? { text: `this server has no secret for it: its operator sets ${secretVar(c.name)}`, hot: true, form: false } : null;
  }
  if (c.command || !c.needsSecret) return null;
  return c.held ? { text: "credential stored", hot: false, form: true } : { text: "no credential on this server", hot: true, form: true };
}
