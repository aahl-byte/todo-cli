import type { Db } from "./db";
import { hashToken, newToken } from "./auth";
import { withBase } from "./base";

export const DISPLAY_COOKIE = "todo_display";

/** The display key's cookie: sent only to display pages, and kept for a year. */
export const displayCookie = (https: boolean) =>
  ({ httpOnly: true, sameSite: "lax", secure: https, path: withBase("/display/"), maxAge: 60 * 60 * 24 * 365 }) as const;

export interface Display { project: string; label: string; created: string; last_seen: string | null }

export async function displays(d: Db): Promise<Display[]> {
  return d.query("select project, label, created, last_seen from display_tokens order by project, created") as any;
}

/** Issue a display key for one project's board; the same label again replaces its key. */
export async function addDisplay(d: Db, project: string, label: string, handle: string | null = null, token: string = newToken()): Promise<string> {
  await d.query(
    `insert into display_tokens (token_hash, project, label, handle) values ($1, $2, $3, $4)
     on conflict (project, label) do update set token_hash = excluded.token_hash, handle = excluded.handle, created = now(), last_seen = null`,
    [hashToken(token), project, label, handle]);
  return token;
}

export async function removeDisplay(d: Db, project: string, label: string): Promise<boolean> {
  return (await d.query("delete from display_tokens where project = $1 and label = $2 returning label", [project, label])).length > 0;
}

/** The display this key opens on the project, noting when it was last used; null when it opens none. */
export async function displayFor(d: Db, project: string, token: string | null | undefined): Promise<{ handle: string | null } | null> {
  if (!token) return null;
  const [row] = await d.query(
    "update display_tokens set last_seen = now() where token_hash = $1 and project = $2 returning handle",
    [hashToken(token), project]);
  return row ? { handle: row.handle } : null;
}
