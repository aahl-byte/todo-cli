import { authed, json } from "@/lib/http";

export async function GET(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  return json(a.user);
}
