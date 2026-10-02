import crypto from "node:crypto";
import type { Db } from "./db";

export interface User {
  handle: string;
  name: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function userForToken(db: Db, token: string | null | undefined): Promise<User | null> {
  if (!token) return null;
  const [row] = await db.query("select handle, name from users where token_hash = $1", [hashToken(token)]);
  return row ? { handle: row.handle, name: row.name } : null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const cookie = req.headers.get("cookie") ?? "";
  const c = /(?:^|;\s*)todo_token=([^;]+)/.exec(cookie);
  return c ? decodeURIComponent(c[1]) : null;
}

export async function addUser(db: Db, handle: string, name?: string): Promise<string> {
  const token = newToken();
  await db.query(
    `insert into users (handle, name, token_hash) values ($1, $2, $3)
     on conflict (handle) do update set token_hash = excluded.token_hash, name = coalesce(excluded.name, users.name)`,
    [handle, name ?? null, hashToken(token)]);
  return token;
}

export async function addProject(db: Db, key: string, name?: string): Promise<void> {
  await db.query("insert into projects (key, name) values ($1, $2) on conflict (key) do nothing", [key, name ?? key]);
}
