// The Jira statuses jira-transition's pickers offer, read through the project's
// jira connection as a shipped plugin would call it, so its address rule and
// credential hold: the statuses of the Jira projects the items link, or every
// status on the site while they link none.
import type { Db } from "../db";
import { linkedJiraProjects } from "../jira/settings";
import { CallError, openConnection, type AddressGuard } from "./connections";
import { guardFor, hostSet } from "./store";

const JIRA = "jira";

export interface JiraChoices { statuses: string[] | null; error: string | null }

const names = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((s) => s?.name).filter((n): n is string => typeof n === "string");

export async function jiraChoices(d: Pick<Db, "query">, project: string, repo: string,
                                  opts: { fetch?: typeof fetch; lookup?: AddressGuard["lookup"] } = {}): Promise<JiraChoices> {
  const host = await hostSet(d, project, repo);
  const def = host.connections[JIRA];
  const secret = host.secrets[JIRA];
  if (!def || !("http" in def)) return { statuses: null, error: "todo isn't connected to Jira yet" };
  if (def.http.auth && !secret) return { statuses: null, error: "todo has no Jira email and API token for this project yet" };
  const conn = openConnection(JIRA, { kind: "http", url: def.http.url, auth: def.http.auth, secret, origin: "host" },
                              { guard: guardFor(repo, opts.lookup, host.privateOk), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  try {
    const projects = (await linkedJiraProjects(d, project)) ?? [];
    const found = new Set<string>();
    if (!projects.length) for (const n of names(await conn.send({ connection: JIRA, method: "GET", path: "/rest/api/3/status" }))) found.add(n);
    for (const p of projects) {
      const types = await conn.send({ connection: JIRA, method: "GET", path: `/rest/api/3/project/${encodeURIComponent(p)}/statuses` });
      for (const t of Array.isArray(types) ? types : []) for (const n of names(t?.statuses)) found.add(n);
    }
    return { statuses: [...found].sort(), error: null };
  } catch (e) {
    return { statuses: null, error: e instanceof CallError ? e.message : "Jira didn't answer" };
  } finally {
    await conn.close();
  }
}
