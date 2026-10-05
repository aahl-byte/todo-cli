import { jiraReadOnly, type JiraConfig } from "./config";

export type Fetch = typeof fetch;

/** Well under the outbox lease, so a slow call can't outlive its claim. */
const TIMEOUT_MS = 60_000;

export class JiraClient {
  constructor(private cfg: JiraConfig, private fetchImpl: Fetch = fetch) {}

  async call(method: string, path: string, body?: unknown): Promise<any> {
    // Search is a POST that only reads; every other non-GET writes.
    if (jiraReadOnly() && method !== "GET" && !path.startsWith("/rest/api/3/search")) {
      throw new Error(`Jira is read-only here: refused ${method} ${path}`);
    }
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString("base64");
    const res = await this.fetchImpl(this.cfg.baseUrl + path, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Basic ${auth}`, accept: "application/json",
                 ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.trim());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /** Where Jira redirects an attachment request, without fetching the file. */
  async locate(path: string): Promise<string | null> {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString("base64");
    const res = await this.fetchImpl(this.cfg.baseUrl + path, {
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Basic ${auth}`, accept: "*/*" } });
    await res.body?.cancel();
    return res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  }

  /** An attachment's bytes, and the media URL Jira redirected to (it names the media id). */
  async download(path: string): Promise<{ bytes: Uint8Array; location: string | null; type: string | null }> {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString("base64");
    const first = await this.fetchImpl(this.cfg.baseUrl + path, {
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Basic ${auth}`, accept: "*/*" } });
    const location = first.status >= 300 && first.status < 400 ? first.headers.get("location") : null;
    // The media host's URL carries its own token, so the second hop sends no credentials.
    const res = location ? await this.fetchImpl(location, { signal: AbortSignal.timeout(TIMEOUT_MS) }) : first;
    if (!res.ok) throw new Error(`Jira GET ${path}: ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), location, type: res.headers.get("content-type") };
  }
}
