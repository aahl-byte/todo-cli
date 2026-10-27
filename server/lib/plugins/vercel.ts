// What vercel-preview's settings can be: the teams the project's vercel
// connection can see, and a team's projects, read through that connection as a
// shipped plugin would call it, so its address rule and token binding hold.
import type { Db } from "../db";
import { CallError, openConnection, type AddressGuard } from "./connections";
import { guardFor, hostSet } from "./store";

const VERCEL = "vercel";
const LISTED = 100;

export interface Choice { id: string; name: string }
export interface VercelChoices { teams: Choice[]; projects: Choice[]; error: string | null }

const choices = (rows: unknown, label: (r: Record<string, unknown>) => unknown): Choice[] =>
  (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === "string")
    .map((r) => ({ id: r.id as string, name: String(label(r) ?? r.id) })).sort((a, b) => a.name.localeCompare(b.name));

export async function vercelChoices(d: Pick<Db, "query">, project: string, repo: string, team: string | null,
                                    opts: { fetch?: typeof fetch; lookup?: AddressGuard["lookup"] } = {}): Promise<VercelChoices> {
  const host = await hostSet(d, project, repo);
  const def = host.connections[VERCEL];
  const secret = host.secrets[VERCEL];
  if (!def || !("http" in def) || !secret) return { teams: [], projects: [], error: "todo has no Vercel token for this project yet" };
  const conn = openConnection(VERCEL, { kind: "http", url: def.http.url, auth: def.http.auth, secret, origin: "host" },
                              { guard: guardFor(repo, opts.lookup, host.privateOk), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  try {
    const teams = (await conn.send({ connection: VERCEL, method: "GET", path: `/v2/teams?limit=${LISTED}` })) as { teams?: unknown };
    const projects = team
      ? (await conn.send({ connection: VERCEL, method: "GET", path: `/v9/projects?limit=${LISTED}&teamId=${encodeURIComponent(team)}` })) as { projects?: unknown }
      : {};
    return { teams: choices(teams?.teams, (r) => r.name ?? r.slug), projects: choices(projects?.projects, (r) => r.name), error: null };
  } catch (e) {
    return { teams: [], projects: [], error: e instanceof CallError ? e.message : "Vercel didn't answer" };
  } finally {
    await conn.close();
  }
}
