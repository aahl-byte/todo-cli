// Queueing plugin events in the caller's transaction. Kept apart from the
// runner so the write path doesn't load the plugin host.
import type { Db } from "../db";
import { repoKey } from "../checkouts";
import type { PluginEvent } from "./types";

/** The server runs plugins only with GITHUB_TOKEN, through which it reads each repo's plugin file. */
export const pluginsEnabled = () => !!process.env.GITHUB_TOKEN;

/** Queue an event for an item whose repo is known; the row id, or null when nothing was queued. */
export async function queuePluginEvent(t: Pick<Db, "query">, project: string, itemUid: string, repo: unknown, event: PluginEvent,
                                       by: string, only?: string[]): Promise<number | null> {
  const key = repoKey(typeof repo === "string" ? repo : "");
  if (!key || !pluginsEnabled()) return null;
  const [row] = await t.query(
    `insert into plugin_events (project, item_uid, repo, event, only_plugins, by) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
    [project, itemUid, key, JSON.stringify(event), only ?? null, by]);
  return Number(row.id);
}
