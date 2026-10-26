// What the Automation settings page says about plugins in words: which plugins
// get a settings form, which connections need a person, and the lines a person
// adds to a repo's plugins file. Pure, so the page and the tests share it.
import type { DashConnection, DashPlugin } from "./plugin-views";

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

/** The environment variable that holds the secret for one of this server's connections. */
export const secretVar = (name: string) => (name === "github" ? "GITHUB_TOKEN" : `TODO_PLUGIN_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);

/** What a person can do about a connection a plugin uses, or null when it needs nothing. `form`: a credential is set here. */
export function connectionNotice(shipped: boolean, c: DashConnection): { text: string; hot: boolean; form: boolean } | null {
  if (c.origin === "missing") {
    const admin = shipped ? ", or the server's admin adds it to TODO_PLUGIN_CONNECTIONS" : "";
    return { text: `Declared nowhere. A developer adds it under connections: in the plugins file${admin}.`, hot: true, form: false };
  }
  if (c.origin === "host") {
    if (!shipped) {
      return { text: "Only plugins that ship with todo get this server's connections. A developer declares it under connections: in the plugins file.",
               hot: true, form: false };
    }
    return c.needsSecret && !c.held ? { text: `The server has no secret for it. Its admin sets ${secretVar(c.name)}.`, hot: true, form: false } : null;
  }
  if (c.command || !c.needsSecret) return null;
  return c.held ? { text: "Credential stored.", hot: false, form: true }
    : { text: "No credential on this server. Set one so the server can call it.", hot: true, form: true };
}
