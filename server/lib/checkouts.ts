// Where people keep a project's repos on disk, as the CLI reports them. Actions
// read it so a session starts in the right folder after the folder moves.
import type { Db } from "./db";

/** `owner/name` from a repo field or a remote URL, lowercased; "" when it has no such shape. */
export function repoKey(raw: string | null | undefined): string {
  const parts = String(raw ?? "").trim().replace(/\.git$/i, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : "";
}

export async function recordCheckout(d: Db, handle: string, project: string, dir: string, repo: string): Promise<void> {
  await d.query(
    `insert into checkouts (handle, project, repo, dir, seen_at) values ($1, $2, $3, $4, now())
     on conflict (handle, project, repo) do update set dir = excluded.dir, seen_at = excluded.seen_at`,
    [handle, project, repoKey(repo), dir]);
}

/** The folder for a repo (any project), or the folder last reported for the project when `repo` is empty;
 * the actor's own checkout first, then the most recently reported. */
export async function checkoutDir(d: Db, project: string, repo: string, actor: string): Promise<{ dir: string; repo: string }> {
  const key = repoKey(repo);
  const [row] = key
    ? await d.query("select dir, repo from checkouts where repo = $1 order by (handle = $2) desc, seen_at desc limit 1", [key, actor])
    : await d.query("select dir, repo from checkouts where project = $1 order by (handle = $2) desc, seen_at desc limit 1", [project, actor]);
  return { dir: row?.dir ?? "", repo: row?.repo ?? "" };
}

/** Watchtower's address for links; a file link opens there. */
export const WATCHTOWER_URL = (process.env.WATCHTOWER_URL ?? "https://leaf-rain.shrew-goblin.ts.net/watchtower/latest").replace(/\/+$/, "");

export function wtFileUrl(dir: string, file: string, edit = false): string {
  return `${WATCHTOWER_URL}/?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}${edit ? "&mode=edit" : ""}`;
}

/** A folder for a repo given as a folder path, owner/name, or a bare name; the person's own checkout first. */
export async function repoDir(d: Db, handle: string, repo: string): Promise<string | null> {
  const r = repo.trim();
  if (r.startsWith("/")) return r.replace(/\/+$/, "") || "/";
  const key = repoKey(r);
  const name = r.toLowerCase();
  const [row] = await d.query(
    `select dir from checkouts
      where ($2 <> '' and repo = $2) or ($2 = '' and (split_part(repo, '/', 2) = $3 or lower(dir) like '%/' || $3))
      order by (handle = $1) desc, seen_at desc limit 1`, [handle, key, name]);
  return row?.dir ?? null;
}

/** The checkouts a person can pick from: theirs first, then everyone's, one per folder. */
export async function knownCheckouts(d: Db, handle: string): Promise<{ repo: string; dir: string }[]> {
  const rows = await d.query(
    `select repo, dir from (select distinct on (dir) repo, dir, handle = $1 as mine, seen_at from checkouts order by dir, (handle = $1) desc, seen_at desc) c
      order by mine desc, seen_at desc limit 50`, [handle]);
  return rows.map((r) => ({ repo: r.repo, dir: r.dir }));
}
