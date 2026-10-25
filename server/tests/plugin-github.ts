// A fake GitHub (and any other endpoint a test names) for the server's plugin runner, and request helpers.
import type { Fetch } from "@/lib/gitfacts";
import type { Resolved } from "@/lib/plugins/connections";

export const API = "https://api.github.com";
export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const PR = (number: number, title = `PR ${number}`) => ({ number, title, html_url: `https://github.com/acme/web/pull/${number}` });

export interface Spec {
  sha?: string;
  file?: string;
  code?: Record<string, string>;
  prs?: Record<string, unknown[]>;
  tips?: Record<string, string>;
  etag?: string;
  /** Anything outside GitHub, such as a repo connection's endpoint. */
  other?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
}

export interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

/** GitHub as recorded answers: the repo, its default branch's head, its .todo-plugins files, PRs by head and the branch list. */
export function fakeGitHub(spec: Spec) {
  const sent: Sent[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
    sent.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const other = await spec.other?.(url, init);
    if (other) return other;
    if (!url.startsWith(API)) return new Response("", { status: 404 });
    const p = url.slice(API.length);
    if (p === "/repos/acme/web") return Response.json({ default_branch: "main" });
    if (p === "/repos/acme/web/branches/main") return Response.json({ commit: { sha: spec.sha ?? "s1" } });
    const content = p.match(/^\/repos\/acme\/web\/contents\/\.todo-plugins\/(.+)\?ref=(\w+)$/);
    if (content) {
      const name = decodeURIComponent(content[1]);
      const text = name === "plugins.yaml" ? spec.file : spec.code?.[name];
      return text === undefined ? new Response("", { status: 404 }) : Response.json({ content: b64(text) });
    }
    const pulls = p.match(/^\/repos\/acme\/web\/pulls\?head=acme%3A([^&]+)&state=all$/);
    if (pulls) return Response.json(spec.prs?.[decodeURIComponent(pulls[1])] ?? []);
    if (p.startsWith("/repos/acme/web/branches?")) {
      if (spec.etag && headers["if-none-match"] === spec.etag) return new Response(null, { status: 304 });
      return Response.json(Object.entries(spec.tips ?? {}).map(([name, sha]) => ({ name, commit: { sha } })),
                           { headers: spec.etag ? { etag: spec.etag } : {} });
    }
    return new Response("", { status: 404 });
  }) as Fetch;
  return { impl, sent };
}

export const req = (url: string, method: string, token: string | null, body?: unknown) => new Request(`http://x${url}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
export const params = (key: string) => ({ params: Promise.resolve({ key }) });

/** DNS for the address guard: every name is public. */
export const publicDns = async (): Promise<Resolved[]> => [{ address: "93.184.216.34", family: 4 }];
