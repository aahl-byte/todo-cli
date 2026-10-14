import type { Db } from "./db";
import { hashToken, newToken } from "./auth";

export const DISPLAY_COOKIE = "todo_display";

/** Issue a display key for one project's board; the same label again replaces its key. */
export async function addDisplay(d: Db, project: string, label: string, token: string = newToken()): Promise<string> {
  await d.query(
    `insert into display_tokens (token_hash, project, label) values ($1, $2, $3)
     on conflict (project, label) do update set token_hash = excluded.token_hash, created = now(), last_seen = null`,
    [hashToken(token), project, label]);
  return token;
}

export async function removeDisplay(d: Db, project: string, label: string): Promise<boolean> {
  return (await d.query("delete from display_tokens where project = $1 and label = $2 returning label", [project, label])).length > 0;
}

/** Whether the key opens this project's display, noting when it was last used. */
export async function displayAllowed(d: Db, project: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const rows = await d.query(
    "update display_tokens set last_seen = now() where token_hash = $1 and project = $2 returning label",
    [hashToken(token), project]);
  return rows.length > 0;
}
