import { db } from "@/lib/db";
import { startLogin } from "@/lib/devices";
import { json } from "@/lib/http";

/** A CLI asks to sign in; a browser user approves the code it gets back. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const login = await startLogin(await db(), body?.label);
  if (!login) return json({ error: "too many sign-in requests waiting; try again in a few minutes" }, 429);
  return json(login);
}
