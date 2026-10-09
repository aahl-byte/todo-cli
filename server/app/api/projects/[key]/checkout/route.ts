import { recordCheckout } from "@/lib/checkouts";
import { authed, json } from "@/lib/http";

/** The CLI reports the folder it runs in and that folder's git remote. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const body = await req.json().catch(() => null);
  const dir = typeof body?.dir === "string" ? body.dir.trim() : "";
  if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir)) return json({ error: "dir must be an absolute path" }, 400);
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  await recordCheckout(a.d, a.user.handle, key, dir, typeof body?.repo === "string" ? body.repo : "");
  return json({ ok: true });
}
