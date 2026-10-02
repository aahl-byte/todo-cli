import { addProject } from "@/lib/auth";
import { authed, json } from "@/lib/http";

export async function POST(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return json({ error: "bad project key" }, 400);
  await addProject(a.d, key, body.name);
  const [p] = await a.d.query("select key, name, deploy_step from projects where key = $1", [key]);
  return json(p);
}
