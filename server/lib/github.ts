// Live pull-request status for PR links, read from GitHub's REST API and
// cached briefly in memory. GITHUB_TOKEN is optional: public repos work
// without it, private ones need it.

export type Fetch = typeof fetch;
export type PrState = "draft" | "open" | "merged" | "closed";
export type ChecksState = "pass" | "fail" | "pending";
export interface PrStatus { state: PrState; checks: ChecksState | null }
export interface PrRef { owner: string; repo: string; number: number }

const API = "https://api.github.com";
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

async function get(path: string, fetchImpl: Fetch): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetchImpl(API + path, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
               ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

/** The status, and whether any part of it failed to load. */
async function fetchStatus({ owner, repo, number }: PrRef, fetchImpl: Fetch): Promise<{ status: PrStatus; partial: boolean }> {
  const base = `/repos/${owner}/${repo}`;
  const pr = await get(`${base}/pulls/${number}`, fetchImpl);
  const state = prState(pr);
  if (state === "merged" || state === "closed") return { status: { state, checks: null }, partial: false };
  const sha = pr.head.sha;
  try {
    const [runs, combined] = await Promise.all([
      get(`${base}/commits/${sha}/check-runs?per_page=100`, fetchImpl),
      get(`${base}/commits/${sha}/status`, fetchImpl),
    ]);
    return { status: { state, checks: checksState(runs.check_runs ?? [], combined.statuses ?? []) }, partial: false };
  } catch {
    return { status: { state, checks: null }, partial: true };
  }
}

/** A PR's status, or null when GitHub can't tell us; failed lookups, checks included, retry after a short pause. */
export function prStatus(ref: PrRef, fetchImpl: Fetch = fetch): Promise<PrStatus | null> {
  const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: FRESH_MS, value: Promise.resolve<PrStatus | null>(null) };
  entry.value = fetchStatus(ref, fetchImpl).then(
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

/** Statuses for every link pointing at a GitHub PR, keyed by the link's uid. */
export async function linkPrStatuses(links: Record<string, any>[], fetchImpl?: Fetch): Promise<Record<string, PrStatus>> {
  const found = await Promise.all(links.map(async (l) => {
    const ref = parsePrUrl(l.meta?.url);
    return [l.uid, ref && (await prStatus(ref, fetchImpl))] as const;
  }));
  return Object.fromEntries(found.filter((f): f is readonly [string, PrStatus] => !!f[1]));
}
