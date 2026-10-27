// The GitHub token todo reads a project's repos with, for git facts, polling and
// plugins: the one given for the project on Settings → Automation, else the
// server's GITHUB_TOKEN for a repo of an owner TODO_PLUGIN_OWNERS lists.
import crypto from "node:crypto";
import type { Db } from "./db";
import { pluginOwners } from "./checkouts";
import { githubApi } from "./github";
import { decryptSecret, projectSecretScope } from "./plugins/secrets";

export const GITHUB = "github";

/** Whose token reads a repo: the project's own, or the server's. */
export type GithubSource = "page" | "server";
export interface GithubAuth { token: string; source: GithubSource }

/** Whether the project gave a GitHub token of its own, and that token, or null when this server can't read it (another
 * TODO_SECRET_KEY, or another GITHUB_API_URL than it was given for). */
export async function pageGithub(d: Pick<Db, "query">, project: string): Promise<{ given: boolean; token: string | null }> {
  const [row] = await d.query("select secret_enc from project_connections where project = $1 and name = $2", [project, GITHUB]);
  if (!row?.secret_enc) return { given: false, token: null };
  return { given: true, token: decryptSecret(row.secret_enc, projectSecretScope(project, GITHUB, githubApi())) };
}

/** The project's own GitHub token, or null when it has none this server can read. */
export async function pageGithubToken(d: Pick<Db, "query">, project: string): Promise<string | null> {
  return (await pageGithub(d, project)).token;
}

const serverToken = () => process.env.GITHUB_TOKEN?.trim() || null;

/** The server's GITHUB_TOKEN, for a repo of an owner TODO_PLUGIN_OWNERS lists. */
export function serverGithubToken(repo: string): string | null {
  const token = serverToken();
  return token && pluginOwners().includes(repo.split("/")[0]?.toLowerCase()) ? token : null;
}

/** The token that reads one of the project's repos, or null when todo has none for it. A project that gave its own never falls
 * back to the server's, even while its own can't be read. */
export async function githubToken(d: Pick<Db, "query">, project: string, repo: string): Promise<GithubAuth | null> {
  const page = await pageGithub(d, project);
  if (page.given) return page.token ? { token: page.token, source: "page" } : null;
  const server = serverGithubToken(repo);
  return server ? { token: server, source: "server" } : null;
}

/** What reads a project's pull-request links, by the link's repo: its own token, else the server's for a repo of its owners. */
export async function prTokens(d: Pick<Db, "query">, project: string): Promise<(repo: string) => string | null> {
  const page = await pageGithub(d, project);
  return (repo) => (page.given ? page.token : serverGithubToken(repo));
}

/** A token's fingerprint, for telling apart what each token saw without keeping the token. */
export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Whether any project could read GitHub here, so a tick has work to look for. */
export async function anyGithubToken(d: Pick<Db, "query">): Promise<boolean> {
  if (serverToken() && pluginOwners().length) return true;
  const [row] = await d.query("select 1 from project_connections where name = $1 and secret_enc is not null limit 1", [GITHUB]);
  return !!row;
}
