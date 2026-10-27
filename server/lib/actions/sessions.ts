// Live state of the Watchtower sessions that Actions and the watchtower-session plugin started. An Action's run
// recorded its session id; the plugin's session is the one named for the item, found through the repo's watchtower connection.
import type { Db } from "../db";
import { openConnection, type AddressGuard, type Connection } from "../plugins/connections";
import { connectionsFor } from "../plugins/host";
import { WATCHTOWER as PLUGIN } from "../plugins/port";
import { guardFor, hostSet } from "../plugins/store";
import { apiBase, sessionUrl, WATCHTOWER_URL } from "../watchtower";
import type { Fetch } from "./deliver";

const TIMEOUT_MS = 2_000;
/** The board looks only at sessions started this recently. */
const BOARD_DAYS = 7;

export type SessionStatus = "busy" | "idle" | "waiting" | "stopped" | "shell" | "unknown";

export interface SessionState {
  /** The Action's id, or `watchtower-session/<instance>` for the plugin's. */
  key: string;
  name: string;
  session: string;
  url: string;
  status: SessionStatus;
  waitingFor: string | null;
}

/** How this server reaches Watchtower; tests stand in for the network and DNS. */
export interface Net { fetch?: Fetch; lookup?: AddressGuard["lookup"] }

const STATUSES: SessionStatus[] = ["busy", "idle", "waiting", "stopped", "shell"];

/** A session's answer as its state; ids follow /clear, so the answer may name the session's new id. */
function stateOf(out: SessionState, base: string, s: any): SessionState {
  const status = STATUSES.includes(s?.status) ? s.status : "unknown";
  const session = s?.id ?? out.session;
  return { ...out, session, url: sessionUrl(base, session), status, waitingFor: status === "waiting" ? s.waitingFor ?? null : null };
}

// ── Actions ──────────────────────────────────────────────────────────────────
interface RunRow { item_uid: string; action_id: string; name: string; base: string; session: string }

async function look(r: RunRow, f: Fetch): Promise<SessionState> {
  const out: SessionState = { key: r.action_id, name: r.name, session: r.session, url: sessionUrl(r.base, r.session), status: "unknown", waitingFor: null };
  try {
    const res = await f(`${apiBase(r.base)}/api/sessions/${encodeURIComponent(r.session)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { ...out, status: "stopped" };
    if (!res.ok) return out;
    return stateOf(out, r.base, await res.json());
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

// ── the watchtower-session plugin ────────────────────────────────────────────
interface PluginRunRow { item_uid: string; item_id: string; repo: string; instance: string; name: string | null; link: string | null }

interface RosterSession { id: string; name?: string; state?: string; lastActivity?: number }

/** The latest run per item and instance that reached Watchtower: not a dry run, not skipped, not failed. */
async function latestPluginRuns(d: Db, project: string, where: string, params: unknown[]): Promise<PluginRunRow[]> {
  return d.query(
    `select distinct on (r.item_uid, r.instance) r.item_uid, i.id as item_id, r.repo, r.instance,
            p.def->>'name' as name, p.def->'settings'->>'link' as link
       from plugin_runs r
       join items i on i.project = r.project and i.uid = r.item_uid
       left join plugin_instances p on p.project = r.project and p.repo = r.repo and p.plugin = r.plugin and p.id = r.instance
      where r.project = $1 and r.plugin = $2 and not r.dry_run and r.result->>'error' is null and r.result->>'skipped' is null ${where}
      order by r.item_uid, r.instance, r.id desc`, [project, PLUGIN, ...params]) as Promise<PluginRunRow[]>;
}

/** The repo's watchtower connection, as the plugin's own runs open it. */
async function towerFor(d: Db, project: string, repo: string, net: Net): Promise<Connection | null> {
  const host = await hostSet(d, project, repo);
  const c = connectionsFor({ hostConnections: host.connections, secrets: { host: host.secrets } }, {}, true).watchtower;
  return c ? openConnection("watchtower", c, { fetch: net.fetch, timeoutMs: TIMEOUT_MS, guard: guardFor(repo, net.lookup, host.privateOk) }) : null;
}

/** The item's own session: its live one, else its newest stopped one. */
function itemSession(sessions: RosterSession[], itemId: string): RosterSession | undefined {
  const named = sessions.filter((s) => s?.name === `todo: ${itemId}`);
  return named.find((s) => s.state === "active")
    ?? named.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
}

/** Each run's session, read through its repo's connection; a run whose item has no session yet has none. */
async function pluginStates(d: Db, project: string, runs: PluginRunRow[], net: Net): Promise<{ uid: string; s: SessionState }[]> {
  const byRepo = new Map<string, PluginRunRow[]>();
  for (const r of runs) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const repos = await Promise.all([...byRepo].map(async ([repo, rows]) => {
    const tower = await towerFor(d, project, repo, net).catch(() => null);
    try {
      const roster = tower ? await tower.send({ connection: "watchtower", path: "/api/roster" }).catch(() => null) as { sessions?: RosterSession[] } | null : null;
      const asked = new Map<string, Promise<unknown>>();
      // An item's instances share its one session, so each session is asked once.
      const status = (id: string) => {
        if (!asked.has(id)) asked.set(id, tower!.send({ connection: "watchtower", path: `/api/sessions/${encodeURIComponent(id)}` }).catch(() => null));
        return asked.get(id)!;
      };
      return Promise.all(rows.map(async (r) => {
        const base = (r.link || WATCHTOWER_URL).replace(/\/+$/, "");
        const out: SessionState = { key: `${PLUGIN}/${r.instance}`, name: r.name ?? r.instance, session: "", url: base, status: "unknown", waitingFor: null };
        if (!roster) return { uid: r.item_uid, s: out };
        const found = itemSession(roster.sessions ?? [], r.item_id);
        if (!found) return null;
        const at = { ...out, session: found.id, url: sessionUrl(base, found.id) };
        if (found.state === "stopped") return { uid: r.item_uid, s: { ...at, status: "stopped" as const } };
        const s = await status(found.id);
        return { uid: r.item_uid, s: s ? stateOf(at, base, s) : at };
      }));
    } finally {
      await tower?.close();
    }
  }));
  return repos.flat().filter((x): x is { uid: string; s: SessionState } => x !== null);
}

// ── what the page asks for ───────────────────────────────────────────────────
export async function itemSessions(d: Db, project: string, itemUid: string, net: Net = {}): Promise<SessionState[]> {
  const [runs, plugins] = await Promise.all([latestRuns(d, project, "and item_uid = $2", [itemUid]),
                                             latestPluginRuns(d, project, "and r.item_uid = $3", [itemUid])]);
  const actions = await Promise.all(runs.map((r) => look(r, net.fetch ?? fetch)));
  return [...actions, ...(await pluginStates(d, project, plugins, net)).map((p) => p.s)];
}

const RANK: Record<SessionStatus, number> = { busy: 3, waiting: 2, idle: 1, shell: 0, stopped: 0, unknown: 0 };

/** For the board: each recently run item's liveliest session, when it's working or waiting. */
export async function boardSessions(d: Db, project: string, net: Net = {}): Promise<Record<string, { status: SessionStatus; waitingFor: string | null }>> {
  const [runs, plugins] = await Promise.all([latestRuns(d, project, "and created > now() - make_interval(days => $2)", [BOARD_DAYS]),
                                             latestPluginRuns(d, project, "and r.at > now() - make_interval(days => $3)", [BOARD_DAYS])]);
  const states = [
    ...await Promise.all(runs.map(async (r) => ({ uid: r.item_uid, s: await look(r, net.fetch ?? fetch) }))),
    ...await pluginStates(d, project, plugins, net),
  ];
  const out: Record<string, { status: SessionStatus; waitingFor: string | null }> = {};
  for (const { uid, s } of states) {
    if (RANK[s.status] < 2 || (out[uid] && RANK[out[uid].status] >= RANK[s.status])) continue;
    out[uid] = { status: s.status, waitingFor: s.waitingFor };
  }
  return out;
}
