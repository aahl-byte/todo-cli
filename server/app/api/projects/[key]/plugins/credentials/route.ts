import { repoKey } from "@/lib/checkouts";
import { authed, json } from "@/lib/http";
import { NoSecretKey } from "@/lib/plugins/secrets";
import { PluginInputError, putCredential } from "@/lib/plugins/server";

/** Store a repo connection's secret: `{repo, connection, secret}`, or `secret: null` to forget it. It is never read back. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  const body = await req.json().catch(() => null);
  const repo = repoKey(typeof body?.repo === "string" ? body.repo : "");
  if (!repo) return json({ error: "repo must be owner/name" }, 400);
  try {
    await putCredential(a.d, key, repo, body.connection, body.secret, a.user.handle);
  } catch (e) {
    if (e instanceof NoSecretKey) return json({ error: e.message }, 503);
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true });
}
