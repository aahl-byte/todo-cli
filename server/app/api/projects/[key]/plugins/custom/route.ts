import { json } from "@/lib/http";
import { projectRepo } from "@/lib/plugins/route-helpers";
import { checkStoredCustom, PluginInputError, putCustom, removeCustom } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

const fields = (body: any) => ({ name: String(body?.name ?? ""), manifest: String(body?.manifest ?? ""),
                                 code: typeof body?.code === "string" && body.code.trim() ? body.code : null });

/** Check a custom plugin without saving it: `{repo, name, manifest, code?, was?}` answers {errors, warnings}. */
export async function POST(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  const { errors, warnings } = await checkStoredCustom(a.d, a.key, a.repo, fields(body), typeof body?.was === "string" ? body.was : null);
  return json({ errors, warnings });
}

/** Add or replace a custom plugin: `{repo, name, manifest, code?, was?}`, `was` the name it's stored under when it's renamed. */
export async function PUT(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  try {
    const { warnings } = await putCustom(a.d, a.key, a.repo, body, a.user.handle);
    return json({ ok: true, warnings });
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message, errors: e.errors }, 400);
    throw e;
  }
}

/** Remove a custom plugin with its instances: `{repo, name}`. */
export async function DELETE(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  try {
    await removeCustom(a.d, a.key, a.repo, body?.name);
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true });
}
