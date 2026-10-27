// What the Automation settings page says about plugins in words: which plugins
// get a settings form, and what a person sets for each connection. Pure, so the
// page and the tests share it.
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

/** What a person can do about a connection a plugin uses, or null when it needs nothing. `form`: what's set here, a repo
 * connection's credential, or one of the project's own connections. */
export function connectionNotice(shipped: boolean, c: DashConnection): { text: string; hot: boolean; form: "credential" | "host" | null } | null {
  if (c.name === "github" && !shipped && c.origin !== "repo") return null;
  if (!shipped && c.origin === "missing") return { text: "Declared nowhere. Add it under Connections below.", hot: true, form: null };
  if (!shipped && c.origin === "host") {
    return { text: "Only plugins that ship with todo get the project's own connections. Add one of this repo's own under Connections below.",
             hot: true, form: null };
  }
  if (c.origin !== "repo") return { text: "", hot: false, form: "host" };
  if (c.command || !c.needsSecret) return null;
  return c.held ? { text: "Credential stored.", hot: false, form: "credential" }
    : { text: "No credential on this server. Set one so the server can call it.", hot: true, form: "credential" };
}
