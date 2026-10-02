import type { JiraConfig } from "./config";

export type Fetch = typeof fetch;

export class JiraClient {
  constructor(private cfg: JiraConfig, private fetchImpl: Fetch = fetch) {}

  async call(method: string, path: string, body?: unknown): Promise<any> {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString("base64");
    const res = await this.fetchImpl(this.cfg.baseUrl + path, {
      method,
      headers: { authorization: `Basic ${auth}`, accept: "application/json",
                 ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.trim());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
}
