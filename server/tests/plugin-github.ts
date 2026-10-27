// A fake GitHub (and any other endpoint a test names) for the server's plugin runner, a repo's plugin config stored
// straight from the YAML map it composes to, and request helpers.
import { parse, stringify } from "yaml";
import type { Db } from "@/lib/db";
import type { Fetch } from "@/lib/gitfacts";
import type { Resolved } from "@/lib/plugins/connections";
import { SHIPPED } from "@/lib/plugins/shipped";

export const API = "https://api.github.com";
export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const PR = (number: number, title = `PR ${number}`) => ({ number, title, html_url: `https://github.com/acme/web/pull/${number}` });

export interface Spec {
  prs?: Record<string, unknown[]>;
  tips?: Record<string, string>;
  etag?: string;
  /** Anything outside GitHub, such as a repo connection's endpoint. */
  other?: (url: string, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>;
}

export interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

/** GitHub as recorded answers: the repo, PRs by head and the branch list. */
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

export interface Configured extends Spec {
  /** The repo's config as the one YAML map it composes to: track, connections, plugins, and instances to store beside it. */
  file?: string;
  /** Code by the file name a plugin's code: key gives. */
  code?: Record<string, string>;
}

/** Store a repo's plugin config from the YAML map it composes to, as written, skipping the checks a save makes; instances
 * under `instances:` are stored too. */
export async function storeConfig(d: Pick<Db, "query">, text: string, code: Record<string, string> = {}, project = "p", repo = "acme/web"): Promise<void> {
  const raw = (parse(text) ?? {}) as Record<string, any>;
  const plugins = Object.entries((raw.plugins ?? {}) as Record<string, any>);
  const shipped = plugins.filter(([n, def]) => def?.use === "shipped" && n in SHIPPED).map(([n]) => n);
  await d.query(
    `insert into plugin_configs (project, repo, track, shipped, connections, updated_by) values ($1, $2, $3, $4, $5::jsonb, 'test')
     on conflict (project, repo) do update set track = excluded.track, shipped = excluded.shipped, connections = excluded.connections`,
    [project, repo, raw.track ?? [], shipped, JSON.stringify(raw.connections ?? {})]);
  await d.query("delete from plugin_custom where project = $1 and repo = $2", [project, repo]);
  for (const [name, def] of plugins) {
    if (def?.use !== undefined) continue;
    await d.query("insert into plugin_custom (project, repo, name, manifest, code, updated_by) values ($1, $2, $3, $4, $5, 'test')",
                  [project, repo, name, stringify(def ?? {}), def?.code ? code[def.code] ?? null : null]);
  }
  for (const [plugin, list] of Object.entries((raw.instances ?? {}) as Record<string, any[]>)) {
    for (const [i, inst] of list.entries()) {
      await d.query(
        `insert into plugin_instances (project, repo, plugin, id, def, position, updated_by) values ($1, $2, $3, $4, $5::jsonb, $6, 'test')
         on conflict (project, repo, plugin, id) do update set def = excluded.def, position = excluded.position`,
        [project, repo, plugin, inst.id, JSON.stringify(inst), i]);
    }
  }
}

/** Store the spec's config, then fake GitHub for the rest of it. */
export async function configured(d: Pick<Db, "query">, spec: Configured) {
  const { file, code, ...rest } = spec;
  if (file !== undefined) await storeConfig(d, file, code);
  return fakeGitHub(rest);
}
