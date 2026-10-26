// Jira people as todo handles: a known account maps to its user, any other
// shows as jira:<display name>, and, with TODO_JIRA_CREATE_USERS=1 as with
// jira-sync --create-users, a user is made for an account on first sight.
import type { Db } from "../db";
import { addUser } from "../auth";

export type Person = { accountId?: string; displayName?: string } | null | undefined;

const slugName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "user";

/** A user for this Jira account, made on first sight with password `<handle>-test`. */
export async function ensureUser(db: Pick<Db, "query">, p: Person): Promise<boolean> {
  if (!p?.accountId || !p.displayName) return false;
  const [known] = await db.query("select 1 from users where jira_account_id = $1", [p.accountId]);
  if (known) return false;
  const base = slugName(p.displayName);
  let handle = base;
  for (let i = 2; (await db.query("select 1 from users where handle = $1", [handle])).length; i++) handle = `${base}-${i}`;
  await addUser(db as Db, handle, p.displayName, `${handle}-test`);
  await db.query("update users set jira_account_id = $2 where handle = $1", [handle, p.accountId]);
  return true;
}

/** The handle a Jira person writes as, or null for no one. */
export async function jiraHandle(db: Pick<Db, "query">, p: Person): Promise<string | null> {
  if (!p) return null;
  if (process.env.TODO_JIRA_CREATE_USERS === "1") await ensureUser(db, p);
  if (p.accountId) {
    const [u] = await db.query("select handle from users where jira_account_id = $1", [p.accountId]);
    if (u) return u.handle;
  }
  return p.displayName ? `jira:${p.displayName}` : null;
}
