// Live pull-request status for PR links, read from GitHub's API and cached
// briefly in memory. A token is optional: public repos work without it, private
// ones need it, and unresolved review threads (GraphQL only) need it. Callers
// pass the project's (github-token.ts); it defaults to the server's GITHUB_TOKEN.
import crypto from "node:crypto";

export type Fetch = typeof fetch;
export type PrState = "draft" | "open" | "merged" | "closed";
export type ChecksState = "pass" | "fail" | "pending";
/** `unresolved` counts open review threads; null when it couldn't be read. */
export interface PrStatus { state: PrState; checks: ChecksState | null; unresolved: number | null }
export interface PrRef { owner: string; repo: string; number: number }

/** GitHub's REST base; GITHUB_API_URL points it elsewhere, such as GitHub Enterprise. */
export const githubApi = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const TIMEOUT_MS = 5_000;
const FRESH_MS = 2 * 60_000;
const FAILED_MS = 30_000;
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function parsePrUrl(url: unknown): PrRef | null {
  const m = typeof url === "string" && url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export function prState(pr: { state: string; draft?: boolean; merged_at?: string | null }): PrState {
  if (pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

/** One verdict over check runs and legacy commit statuses: any failure wins, then anything unfinished. */
export function checksState(runs: { status: string; conclusion: string | null }[], statuses: { state: string }[]): ChecksState | null {
  if (!runs.length && !statuses.length) return null;
  if (runs.some((r) => r.conclusion && FAILING.has(r.conclusion)) || statuses.some((s) => s.state === "failure" || s.state === "error")) return "fail";
  if (runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending")) return "pending";
  return "pass";
}

const cache = new Map<string, { at: number; ttl: number; value: Promise<PrStatus | null> }>();

export function resetPrCache(): void {
  cache.clear();
}

function headers(token: string | undefined): Record<string, string> {
  return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
           ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function get(path: string, fetchImpl: Fetch, token: string | undefined): Promise<any> {
  const res = await fetchImpl(githubApi() + path, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved } } } }
}`;

/** Unresolved review threads on a PR. GitHub's GraphQL API needs a token, so with none this is null. */
async function unresolvedThreads({ owner, repo, number }: PrRef, fetchImpl: Fetch, token: string | undefined): Promise<number | null> {
  if (!token) return null;
  const res = await fetchImpl(`${githubApi()}/graphql`, {
    method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: headers(token),
    body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, repo, number } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL: ${res.status}`);
  const body = await res.json();
  const threads = body?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(threads)) throw new Error("GitHub GraphQL: no review threads");
  return threads.filter((t: { isResolved: boolean }) => !t.isResolved).length;
}

async function checksFor(base: string, sha: string, fetchImpl: Fetch, token: string | undefined): Promise<ChecksState | null> {
  const [runs, combined] = await Promise.all([
    get(`${base}/commits/${sha}/check-runs?per_page=100`, fetchImpl, token),
    get(`${base}/commits/${sha}/status`, fetchImpl, token),
  ]);
  return checksState(runs.check_runs ?? [], combined.statuses ?? []);
}

/** The status, and whether any part of it failed to load. */
async function fetchStatus({ owner, repo, number }: PrRef, fetchImpl: Fetch, token: string | undefined): Promise<{ status: PrStatus; partial: boolean }> {
  const base = `/repos/${owner}/${repo}`;
  const pr = await get(`${base}/pulls/${number}`, fetchImpl, token);
  const state = prState(pr);
  const finished = state === "merged" || state === "closed";
  const [checks, unresolved] = await Promise.allSettled([
    finished ? Promise.resolve(null) : checksFor(base, pr.head.sha, fetchImpl, token),
    unresolvedThreads({ owner, repo, number }, fetchImpl, token),
  ]);
  return {
    status: { state, checks: checks.status === "fulfilled" ? checks.value : null,
              unresolved: unresolved.status === "fulfilled" ? unresolved.value : null },
    partial: checks.status === "rejected" || unresolved.status === "rejected",
  };
}

const tokenKey = (token: string | undefined) => (token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 16) : "");

/** A PR's status, or null when GitHub can't tell us; failed lookups, checks included, retry after a short pause. Each token's
 * answers are cached apart, since what a token sees is its own. */
export function prStatus(ref: PrRef, fetchImpl: Fetch = fetch, token: string | null | undefined = process.env.GITHUB_TOKEN): Promise<PrStatus | null> {
  const auth = token || undefined;
  const key = `${tokenKey(auth)}:${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: FRESH_MS, value: Promise.resolve<PrStatus | null>(null) };
  entry.value = fetchStatus(ref, fetchImpl, auth).then(
    ({ status, partial }) => {
      if (partial) entry.ttl = FAILED_MS;
      return status;
    },
    () => {
      entry.ttl = FAILED_MS;
      return null;
    });
  cache.set(key, entry);
  return entry.value;
}

/** Statuses for every link pointing at a GitHub PR, keyed by the link's uid, each read with the token `tokenFor` gives its repo
 * (the server's by default). */
export async function linkPrStatuses(links: Record<string, any>[], fetchImpl?: Fetch,
                                     tokenFor: (repo: string) => string | null = () => process.env.GITHUB_TOKEN ?? null): Promise<Record<string, PrStatus>> {
  const found = await Promise.all(links.map(async (l) => {
    const ref = parsePrUrl(l.meta?.url);
    return [l.uid, ref && (await prStatus(ref, fetchImpl, tokenFor(`${ref.owner}/${ref.repo}`.toLowerCase())))] as const;
  }));
  return Object.fromEntries(found.filter((f): f is readonly [string, PrStatus] => !!f[1]));
}
