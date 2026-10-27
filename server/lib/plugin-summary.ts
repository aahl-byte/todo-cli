// What the Automation settings page says about plugins in words: which plugins
// get a settings form, and which connections need a person. Pure, so the page
// and the tests share it.
import type { DashConnection, DashPlugin } from "./plugin-views";

const DEFAULT_ID = "default";

type Shape = Pick<DashPlugin, "settings" | "exclusive" | "on" | "instances">;

/** A plugin gets a form when there's something to set: settings, a choice of instances, a first-match order or a button
 * label, or a lone instance someone already changed, which the form changes back. */
export function configurable(p: Shape): boolean {
  if (Object.keys(p.settings ?? {}).length || p.exclusive || p.instances.length !== 1) return true;
  if ((p.on ?? []).includes("manual")) return true;
  const [i] = p.instances;
  return i.id !== DEFAULT_ID || i.enabled === false || !!i.dry_run || i.on !== undefined || !!i.button;
}

/** The environment variable that holds the secret for one of this server's connections. */
export const secretVar = (name: string) => (name === "github" ? "GITHUB_TOKEN" : `TODO_PLUGIN_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);

/** What a person can do about a connection a plugin uses, or null when it needs nothing. `form`: a credential is set here. */
export function connectionNotice(shipped: boolean, c: DashConnection): { text: string; hot: boolean; form: boolean } | null {
  if (c.name === "github" && !shipped && c.origin !== "repo") return null;
  if (c.origin === "missing") {
    const admin = shipped ? ", or the server's admin adds it to TODO_PLUGIN_CONNECTIONS" : "";
    return { text: `Declared nowhere. Add it under Connections below${admin}.`, hot: true, form: false };
  }
  if (c.origin === "host") {
    if (!shipped) {
      return { text: "Only plugins that ship with todo get this server's connections. Add one of this repo's own under Connections below.",
               hot: true, form: false };
    }
    return c.needsSecret && !c.held ? { text: `The server has no secret for it. Its admin sets ${secretVar(c.name)}.`, hot: true, form: false } : null;
  }
  if (c.command || !c.needsSecret) return null;
  return c.held ? { text: "Credential stored.", hot: false, form: true }
    : { text: "No credential on this server. Set one so the server can call it.", hot: true, form: true };
}
