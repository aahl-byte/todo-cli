import { after, NextResponse } from "next/server";
import { db, type Db } from "./db";
import { bearer, userForToken, type User } from "./auth";

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

/** Resolve the caller, or a 401 response. */
export async function authed(req: Request): Promise<{ d: Db; user: User } | Response> {
  const d = await db();
  const user = await userForToken(d, bearer(req));
  if (!user) return json({ error: "unauthorized" }, 401);
  return { d, user };
}

/** Run `fn` after the response is sent (Vercel keeps the function alive for
 * it). Outside a request scope, as in tests, it just runs. */
export function later(fn: () => Promise<unknown>): void {
  try {
    after(fn);
  } catch {
    void fn().catch(() => undefined);
  }
}
