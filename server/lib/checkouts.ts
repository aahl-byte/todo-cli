// Where people keep a project's repos on disk, as the CLI reports them. Actions
// read it so a session starts in the right folder after the folder moves.
import type { Db } from "./db";
import { WATCHTOWER_URL } from "./watchtower";

/** A GitHub owner/name, safe to put in an API path. */
const REPO_KEY = /^[a-z0-9](?:[a-z0-9_-]{0,38})\/(?!\.\.?$)[a-z0-9._-]{1,100}$/;

/** `owner/name` from a repo field or a remote URL, lowercased; "" when it has no such shape. */
export function repoKey(raw: string | null | undefined): string {
  const parts = String(raw ?? "").trim().replace(/\.git$/i, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean);
  const key = parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : "";
  return REPO_KEY.test(key) ? key : "";
}

/** The GitHub owners whose repos the server's own GITHUB_TOKEN reads, and whose repos a member's checkout brings into a project
 * on its own, from TODO_PLUGIN_OWNERS; none when it's unset. */
export const pluginOwners = () => (process.env.TODO_PLUGIN_OWNERS ?? "").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);

const ownerAllowed = (repo: string) => pluginOwners().includes(repo.split("/")[0]);

/** Whether a project may use a repo: someone added it on Settings → Automation, or its owner is in TODO_PLUGIN_OWNERS and a
 * member's CLI reported a checkout of it. */
export async function repoAllowed(d: Pick<Db, "query">, project: string, repo: string): Promise<boolean> {
  if (!repo || repoKey(repo) !== repo) return false;
  const [listed] = await d.query("select 1 from project_plugin_repos where project = $1 and repo = $2", [project, repo]);
  if (listed) return true;
  if (!ownerAllowed(repo)) return false;
  const [checkout] = await d.query("select 1 from checkouts where project = $1 and repo = $2 limit 1", [project, repo]);
  return !!checkout;
}

/** The projects allowed to use a repo. */
export async function projectsAllowed(d: Pick<Db, "query">, repo: string): Promise<string[]> {
  const rows = ownerAllowed(repo)
    ? await d.query("select project from project_plugin_repos where repo = $1 union select project from checkouts where repo = $1", [repo])
    : await d.query("select project from project_plugin_repos where repo = $1", [repo]);
  return rows.map((r) => r.project as string).sort();
}

/** Why an item's repo gets no GitHub reads or plugin runs, or null when the project may use it. */
export async function repoRefusal(d: Pick<Db, "query">, project: string, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const repo = repoKey(String(raw));
  if (!repo) return `${String(raw)} isn't a GitHub owner/name, so todo doesn't read it from GitHub or run its plugins.`;
  if (await repoAllowed(d, project, repo)) return null;
  return `${repo} isn't one of this project's repos, so todo doesn't read it from GitHub or run its plugins. `
    + (ownerAllowed(repo) ? "It becomes one when a teammate's CLI reports a checkout of it, or when it's added under Settings → Automation."
      : "It becomes one when it's added under Settings → Automation.");
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
