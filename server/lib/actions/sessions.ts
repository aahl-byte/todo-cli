// Live state of the Watchtower sessions Actions started, read from Watchtower
// by each run's recorded session id.
import type { Db } from "../db";
import { apiBase, sessionUrl } from "../watchtower";
import type { Fetch } from "./deliver";

const TIMEOUT_MS = 2_000;
/** The board looks only at sessions started this recently. */
const BOARD_DAYS = 7;

export type SessionStatus = "busy" | "idle" | "waiting" | "stopped" | "shell" | "unknown";

export interface SessionState {
  actionId: string;
  name: string;
  session: string;
  url: string;
  status: SessionStatus;
  waitingFor: string | null;
}

interface RunRow { item_uid: string; action_id: string; name: string; base: string; session: string }

async function look(r: RunRow, f: Fetch): Promise<SessionState> {
  const out: SessionState = { actionId: r.action_id, name: r.name, session: r.session, url: sessionUrl(r.base, r.session), status: "unknown", waitingFor: null };
  try {
    const res = await f(`${apiBase(r.base)}/api/sessions/${encodeURIComponent(r.session)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { ...out, status: "stopped" };
    if (!res.ok) return out;
    const s = await res.json();
    const status = ["busy", "idle", "waiting", "stopped", "shell"].includes(s.status) ? s.status : "unknown";
    // Ids follow /clear: the answer may name the session's new id.
    const session = s.id ?? r.session;
    return { ...out, session, url: sessionUrl(r.base, session), status, waitingFor: status === "waiting" ? s.waitingFor ?? null : null };
  } catch {
    return out;
  }
}

/** The latest delivered Watchtower run per item and Action. */
async function latestRuns(d: Db, project: string, where: string, params: unknown[]): Promise<RunRow[]> {
  return d.query(
    `select distinct on (item_uid, action_id) item_uid, action_id, name, request->>'base' as base,
            result->>'session' as session
       from action_runs
      where project = $1 and request->>'kind' = 'watchtower' and result->>'session' is not null ${where}
      order by item_uid, action_id, id desc`, [project, ...params]) as Promise<RunRow[]>;
}

export async function itemSessions(d: Db, project: string, itemUid: string, f: Fetch = fetch): Promise<SessionState[]> {
  const runs = await latestRuns(d, project, "and item_uid = $2", [itemUid]);
  return Promise.all(runs.map((r) => look(r, f)));
}

const RANK: Record<SessionStatus, number> = { busy: 3, waiting: 2, idle: 1, shell: 0, stopped: 0, unknown: 0 };

/** For the board: each recently run item's liveliest session, when it's working or waiting. */
export async function boardSessions(d: Db, project: string, f: Fetch = fetch): Promise<Record<string, { status: SessionStatus; waitingFor: string | null }>> {
  const runs = await latestRuns(d, project, "and created > now() - make_interval(days => $2)", [BOARD_DAYS]);
  const states = await Promise.all(runs.map(async (r) => ({ uid: r.item_uid, s: await look(r, f) })));
  const out: Record<string, { status: SessionStatus; waitingFor: string | null }> = {};
  for (const { uid, s } of states) {
    if (RANK[s.status] < 2 || (out[uid] && RANK[out[uid].status] >= RANK[s.status])) continue;
    out[uid] = { status: s.status, waitingFor: s.waitingFor };
  }
  return out;
}
