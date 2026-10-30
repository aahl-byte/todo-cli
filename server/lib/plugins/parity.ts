// Parity between the old Action and Jira-trigger code and the plugin instances
// a port makes: recent status moves and manual Action runs are replayed through
// both, in dry-run, and what each would send is compared. Reads reach the
// services as they would in dry-run; nothing is written anywhere.
import type { Db, Row } from "../db";
import { checkoutDir } from "../checkouts";
import type { Fetch } from "../gitfacts";
import { deliver } from "../actions/deliver";
import { firesOn, itemVars, render, storedActions, type ItemLike, type Request } from "../actions/model";
import { outboundRules, outboundTarget } from "../jira/rules";
import type { AddressGuard } from "./connections";
import { connectionsFor, runInstance } from "./host";
import { actionInstanceId, planPort, type PortPlan } from "./port";
import { pluginItem } from "./server";
import { SHIPPED } from "./shipped";
import { redactHeaders } from "./limits";
import { guardFor, hostSecrets, hostSet, type HostSet } from "./store";
import { settingRef } from "./load";
import { pickInstances } from "./triggers";
import { jiraKeys } from "./yaml-runner";
import type { Call, ConnectionDef, PluginEvent, ResolvedConnection } from "./types";

/** Handles whose moves the old Jira code never echoed back, and which run no plugins, as apply.ts has it. */
const BRIDGES = ["jira-bridge", "plugin"];
/** A bridge's new request version sends an item back to requested; that move reaches Jira and plugins all the same. */
const isBounce = (m: Row) => m.to_status === "requested" && /^request v\d+$/.test(String(m.note ?? ""));

export interface ParityCase { at: string; item: string; trigger: string; old: string[]; plugins: string[]; same: boolean }
export interface ParityResult { cases: ParityCase[]; diffs: number; plan: PortPlan }

export interface ParityOptions {
  since: Date;
  plan?: PortPlan;
  /** The network both paths read through; every write is held back. */
  fetch?: Fetch;
  lookup?: AddressGuard["lookup"];
}

const canonical = (v: unknown): string => {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, sort(y)])) : x;
  return JSON.stringify(sort(v));
};

function bodyText(body: unknown): string {
  if (body === undefined || body === null || body === "") return "";
  if (typeof body !== "string") return ` ${canonical(body)}`;
  try {
    return ` ${canonical(JSON.parse(body))}`;
  } catch {
    return ` ${JSON.stringify(body)}`;
  }
}

const lower = (h: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]).sort(([a], [b]) => a.localeCompare(b)));

/** A send in words, each credential header's value masked. */
function sendLine(id: string, method: string, url: string, body: unknown, headers?: Record<string, string>): string {
  const h = headers && Object.keys(headers).length ? ` headers ${canonical(redactHeaders(lower(headers)))}` : "";
  return `action ${id}: ${method} ${url}${h}${bodyText(body)}`;
}

class Held extends Error {}

/** A fetch that lets reads under `reads` through and records the first write, then refuses every other. */
function holding(net: Fetch, reads: () => string[]) {
  const writes: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && reads().some((r) => url.startsWith(r))) return net(url, init);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    if (!writes.length) writes.push({ method, url, headers, body: init.body ?? undefined });
    throw new Held("held back by the parity check");
  }) as Fetch;
  return { f, writes };
}

async function oldAction(req: Request, id: string, net: Fetch, reads: string[]): Promise<string[]> {
  const { f, writes } = holding(net, () => reads);
  await deliver(req, f, async () => {}).catch(() => {});
  const w = writes[0];
  if (!w) return [`action ${id}: sends nothing`];
  return [sendLine(id, w.method, w.url, w.body, req.kind === "rest" ? req.headers : undefined)];
}

/** What the plugin instances an event fires would send, in the same words as the old side. */
async function pluginSends(plan: PortPlan, item: Awaited<ReturnType<typeof pluginItem>>, event: PluginEvent, connections: Record<string, ResolvedConnection>,
                           net: Fetch, reads: string[], guard: AddressGuard): Promise<string[]> {
  const out: string[] = [];
  for (const [plugin, list] of Object.entries(plan.instances)) {
    const { def, code } = SHIPPED[plugin];
    for (const inst of pickInstances(def, list, event)) {
      const { f, writes } = holding(net, () => reads);
      const result = await runInstance({ plugin: def, name: plugin, code, instance: inst, item, event, connections, dryRun: true, shipped: true },
                                       { fetch: f, guard, isolation: "inline" });
      const id = inst.id.replace(/^action-/, "");
      const held = writes[0];
      if ((result.skipped || result.error) && !held) {
        out.push(`${plugin} ${inst.id}: ${result.skipped ? `skipped: ${result.skipped}` : `error: ${result.error}`}`);
        continue;
      }
      if (plugin === "jira-transition") {
        for (const k of jiraKeys(item)) out.push(`jira ${k} → ${(inst.settings as { to: string }).to}`);
        continue;
      }
      if (plugin === "jira-issue") continue;
      const conn = connections[settingRef(def.connections?.[0]) ? String(inst.settings?.connection) : def.connections![0]];
      const base = conn && "url" in conn ? String(conn.url).replace(/\/+$/, "") : "";
      const sent: Call | undefined = result.wouldSend[0];
      const rest = plugin === "rest";
      // The connection's own credential goes out as a header too.
      const auth = conn?.kind === "http" && conn.auth ? (conn.auth.startsWith("header:") ? conn.auth.slice(7) : "authorization").toLowerCase() : null;
      const withAuth = (h: Record<string, string>) => (auth ? { ...h, [auth]: "***" } : h);
      if (sent) out.push(sendLine(id, sent.method ?? "", base + sent.path, sent.text ?? sent.input, rest ? withAuth(sent.headers ?? {}) : undefined));
      else if (held) {
        // A rest GET reads, so dry-run sends it; the parity check holds it back like a write.
        const { accept: _a, "user-agent": _u, ...headers } = lower(held.headers);
        out.push(sendLine(id, held.method, held.url, held.body, rest ? withAuth(headers) : undefined));
      }
      else out.push(`action ${id}: sends nothing`);
    }
  }
  return out;
}

/** The plan's connections, under the project's and the server's own; each secret from where its connection came. */
function connectionsOf(plan: PortPlan, host: HostSet): Record<string, ResolvedConnection> {
  const defs: Record<string, ConnectionDef> = { ...plan.connections, ...host.connections };
  return connectionsFor({ hostConnections: defs, secrets: { host: { ...hostSecrets(plan.connections), ...host.secrets } } }, {});
}

export async function parity(d: Db, project: string, opts: ParityOptions): Promise<ParityResult> {
  const plan = opts.plan ?? (await planPort(d, project));
  const net = opts.fetch ?? fetch;
  const host = await hostSet(d, project, plan.repos[0] ?? "");
  const connections = connectionsOf(plan, host);
  // Only Jira and Watchtower are read; a rest Action's every call is held back, a GET too.
  const reads = ["jira", "watchtower"].map((n) => connections[n]).filter((c) => c && "url" in c && c.url)
    .map((c) => String((c as { url: string }).url).replace(/\/+$/, ""));
  const [p] = await d.query("select actions, jira_outbound from projects where key = $1", [project]);
  const actions = storedActions(p?.actions);
  const rules = outboundRules(p?.jira_outbound);
  const since = opts.since.toISOString();
  const cases: ParityCase[] = [];

  const replay = async (it: Row, at: string, trigger: string, by: string, event: PluginEvent, old: string[], runsPlugins = true) => {
    const key = String(it.extra?.repo ?? "");
    const repo = plan.repos.find((r) => r === key.toLowerCase().replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/"));
    let plugins: string[];
    if (!runsPlugins) plugins = [];
    else if (!repo) plugins = old.length ? [`no plugin runs: the item's repo ${key || "(none)"} isn't one the project runs plugins for`] : [];
    else plugins = await pluginSends(plan, await pluginItem(d, project, it, by), event, connections, net, reads, guardFor(repo, opts.lookup, host.privateOk));
    const same = canonical([...old].sort()) === canonical([...plugins].sort());
    cases.push({ at, item: it.id, trigger, old, plugins, same });
  };

  const places = async (it: Row, by: string) => {
    const own = await checkoutDir(d, project, "", by);
    const repo = String(it.extra?.repo ?? "");
    return { itemDir: repo ? (await checkoutDir(d, project, repo, by)).dir : own.dir, projectDir: own.dir, projectRepo: own.repo };
  };

  const moves = await d.query(
    `select * from status_history where project = $1 and field is null and from_status is not null and ts >= $2 order by ts, n`, [project, since]);
  for (const m of moves) {
    const [it] = await d.query("select * from items where project = $1 and uid = $2", [project, m.item_uid]);
    if (!it) continue;
    const old: string[] = [];
    const fires = !BRIDGES.includes(m.by) || isBounce(m);
    const target = rules && fires ? outboundTarget(rules, m.from_status, m.to_status) : null;
    if (target) {
      const keys = await d.query("select jira_key from jira_links where project = $1 and item_uid = $2 and source = 'field' order by jira_key",
                                 [project, it.uid]);
      for (const k of keys) old.push(`jira ${k.jira_key} → ${target}`);
    }
    for (const a of actions.filter((x) => firesOn(x, m.from_status, m.to_status))) {
      const req = render(a, itemVars(project, it as ItemLike, m.from_status, m.by, process.env.PUBLIC_URL ?? "", await places(it, m.by)));
      old.push(...(await oldAction(req, a.id, net, reads)));
    }
    await replay(it, m.ts, `${m.from_status} → ${m.to_status} by ${m.by}`, m.by, { type: "status", from: m.from_status, to: m.to_status }, old, fires);
  }

  const manual = await d.query("select * from action_runs where project = $1 and trigger = 'manual' and created >= $2 order by id", [project, since]);
  for (const r of manual) {
    const [it] = await d.query("select * from items where project = $1 and uid = $2", [project, r.item_uid]);
    const a = actions.find((x) => x.id === r.action_id);
    if (!it || !a) continue;
    const req = render(a, itemVars(project, it as ItemLike, "", r.by, process.env.PUBLIC_URL ?? "", await places(it, r.by)));
    await replay(it, new Date(r.created).toISOString(), `manual ${a.id} by ${r.by}`, r.by,
                 { type: "manual", instance: actionInstanceId(a) }, await oldAction(req, a.id, net, reads));
  }
  return { cases, diffs: cases.filter((c) => !c.same).length, plan };
}

export function describeParity(r: ParityResult): string {
  const lines: string[] = [];
  for (const c of r.cases) {
    lines.push(`${c.at} ${c.item} ${c.trigger}: ${c.same ? `same (${c.old.length} send${c.old.length === 1 ? "" : "s"})` : "DIFFERENT"}`);
    if (!c.same) {
      for (const o of c.old) lines.push(`  old:     ${o}`);
      for (const n of c.plugins) lines.push(`  plugins: ${n}`);
    }
  }
  lines.push(`${r.cases.length} replayed, ${r.diffs} different`);
  return lines.join("\n");
}
