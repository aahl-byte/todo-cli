// Queueing plugin events in the caller's transaction. Kept apart from the
// runner so the write path doesn't load the plugin host.
import type { Db } from "../db";
import { repoAllowed, repoKey } from "../checkouts";
import { githubToken } from "../github-token";
import type { PluginEvent } from "./types";

export const PLUGIN_HANDLE = "plugin";
/** Statuses after which an item's branches no longer run plugins; its status moves still do. */
export const FINISHED = ["done", "deployed", "cancelled"];

export const finished = (it: Record<string, any>) => FINISHED.includes(it.status) || !!it.extra?.archived;

/** The server runs a project's plugins for a repo only with a GitHub token that reads it, through which it reads the repo's
 * branches and pull requests. */
export const pluginsEnabled = async (d: Pick<Db, "query">, project: string, repo: string) => !!(await githubToken(d, project, repo));

/** Queue an event for an item in one of the project's repos; the row id, or null when nothing was queued.
 * A finished item gets only status events. */
export async function queuePluginEvent(t: Pick<Db, "query">, project: string, itemUid: string, repo: unknown, event: PluginEvent,
                                       by: string, only?: string[]): Promise<number | null> {
  const key = repoKey(typeof repo === "string" ? repo : "");
  if (!key || !(await repoAllowed(t, project, key)) || !(await pluginsEnabled(t, project, key))) return null;
  if (event.type !== "status") {
    const [it] = await t.query("select status, extra from items where project = $1 and uid = $2", [project, itemUid]);
    if (!it || finished(it)) return null;
  }
  const [row] = await t.query(
    `insert into plugin_events (project, item_uid, repo, event, only_plugins, by) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
    [project, itemUid, key, JSON.stringify(event), only ?? null, by]);
  return Number(row.id);
}
