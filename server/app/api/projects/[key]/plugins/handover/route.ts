import { json } from "@/lib/http";
import { makeMove, MOVES, planMove, type Direction, type Move } from "@/lib/plugins/handover";
import { projectRepo } from "@/lib/plugins/route-helpers";
import { PluginConflict, PluginInputError } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

const moveOf = (m: unknown, dir: unknown): { move: Move; direction: Direction } | null =>
  MOVES.includes(m as Move) && (dir === "here" || dir === "back") ? { move: m as Move, direction: dir } : null;

/** What a move would do, in words, with its base: `?repo=owner/name&move=jira-triggers&direction=here`. */
export async function GET(req: Request, ctx: Ctx) {
  const q = new URL(req.url).searchParams;
  const a = await projectRepo(req, ctx, q.get("repo"));
  if (a instanceof Response) return a;
  const m = moveOf(q.get("move"), q.get("direction"));
  if (!m) return json({ error: `move is one of ${MOVES.join(", ")}, and direction here or back` }, 400);
  return json(await planMove(a.d, a.key, m.move, m.direction, a.repo));
}

/** Make a move: `{repo, move, direction, base}`, base as the plan gave it, refused with a 409 once it's changed. */
export async function POST(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  const m = moveOf(body?.move, body?.direction);
  if (!m) return json({ error: `move is one of ${MOVES.join(", ")}, and direction here or back` }, 400);
  try {
    await makeMove(a.d, a.key, m.move, m.direction, a.repo, body.base, a.user.handle);
  } catch (e) {
    if (e instanceof PluginConflict) return json({ error: e.message }, 409);
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true });
}
