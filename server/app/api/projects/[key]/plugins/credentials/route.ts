import { json } from "@/lib/http";
import { NoSecretKey } from "@/lib/plugins/secrets";
import { PluginInputError, putCredential } from "@/lib/plugins/store";
import { projectRepo } from "@/lib/plugins/route-helpers";

/** Store a repo connection's secret: `{repo, connection, secret}`, or `secret: null` to forget it. It is never read back. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  try {
    await putCredential(a.d, a.key, a.repo, body.connection, body.secret, a.user.handle);
  } catch (e) {
    if (e instanceof NoSecretKey) return json({ error: e.message }, 503);
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true });
}
