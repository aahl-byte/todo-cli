// Connections: named endpoints a plugin calls, over HTTP or MCP. Every call goes
// through Calls, which holds dry-run back and keeps to the run's deadline.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { addLog, recordWouldSend } from "./limits";
import type { Call, ConnectionOrigin, ResolvedConnection, RunResult } from "./types";

export const TIMEOUT_MS = 15_000;
const SNIPPET = 300;
const READ_ONLY_METHODS = ["GET", "HEAD"];
/** Pages of listTools read before deciding which tools are read-only. */
export const MAX_TOOL_PAGES = 20;

export interface Resolved { address: string; family: number }

/** Keeps connections off this host's own network: loopback, private, link-local, CGNAT, unique-local and the IPv6
 * forms that carry such an IPv4 address. Each allow list names hosts, or host:port pairs, reachable even there. */
export interface AddressGuard {
  /** For connections the host declared, which shipped plugins use. */
  allow: string[];
  /** For the repo's own connections. */
  repoAllow?: string[];
  /** For one host connection each, by name: the host:port someone let it reach. */
  named?: Record<string, string>;
  /** Stands in for DNS, for tests. */
  lookup?: (host: string) => Promise<Resolved[]>;
}

export interface ConnectionOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Stands in for the MCP transport, for tests. */
  mcpTransport?: (name: string) => Transport;
  /** Check each connection's address before connecting, and connect to the address checked. */
  guard?: AddressGuard;
}

/** A file a connection fetched as it is, for a doc. */
export interface Fetched { bytes: Buffer; type: string | null }

export interface Connection {
  send(call: Call): Promise<unknown>;
  /** GET a path's bytes, up to `max`; null when the answer is longer. */
  fetchBytes?(path: string, max: number): Promise<Fetched | null>;
  isReadOnly(call: Call): Promise<boolean>;
  close(): Promise<void>;
}

export class CallError extends Error {
  /** `network`: the call never got an answer. */
  constructor(message: string, readonly status?: number, readonly network = false) {
    super(message);
  }

  get transient(): boolean {
    return this.network || this.status === 429 || (this.status !== undefined && this.status >= 500);
  }
}

/** The path with its query appended, each value URL-encoded; lists repeat the key and empty values drop out. */
export function withQuery(path: string, query?: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one === undefined || one === null) continue;
      const text = typeof one === "string" ? one : JSON.stringify(one);
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(text)}`);
    }
  }
  if (!parts.length) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

const BLOCKED4 = new net.BlockList();
for (const [net4, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
                            ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
                            ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  BLOCKED4.addSubnet(net4, bits, "ipv4");
}
// IPv4-compatible, IPv4-mapped and IPv4-translated, NAT64, site-local, unique-local, link-local and multicast.
const BLOCKED6: [string, number][] = [["::", 96], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
                                       ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]];

/** An IPv6 address as eight 16-bit groups. */
function groups6(address: string): number[] {
  let text = address.split("%")[0];
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

function inPrefix(g: number[], prefix: string, bits: number): boolean {
  const p = groups6(prefix);
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((g[i] & mask) !== (p[i] & mask)) return false;
  }
  return true;
}

/** Whether an IP address is on a network a server must not reach on a plugin's behalf. */
export function blockedAddress(address: string): boolean {
  const family = net.isIP(address.split("%")[0]);
  if (family === 4) return BLOCKED4.check(address, "ipv4");
  if (family !== 6) return true;
  const g = groups6(address);
  if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true;
  if (BLOCKED6.some(([prefix, bits]) => inPrefix(g, prefix, bits))) return true;
  // 6to4 carries the IPv4 address it routes to.
  if (g[0] === 0x2002) return BLOCKED4.check(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`, "ipv4");
  return false;
}

const systemLookup = async (host: string): Promise<Resolved[]> => dnsLookup(host, { all: true, verbatim: true });

/** A URL's host:port, the port its scheme implies when it names none. */
export function hostPort(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

/** Whether the allow list for the connection's origin names the URL's host or host:port, or, for a host connection, whether it is
 * the one connection someone let reach that host:port. */
function waived(url: URL, guard: AddressGuard, origin: ConnectionOrigin, name?: string): boolean {
  if (namedWaiver(url, guard, origin, name)) return true;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const list = origin === "host" ? guard.allow : guard.repoAllow ?? [];
  const allowed = list.map((a) => a.trim().toLowerCase().replace(/^\[(.*)\](:\d+)?$/, "$1$2"));
  return allowed.includes(host) || allowed.includes(hostPort(url));
}

/** Whether the waiver is one a project gave its own connection: that never opens a link-local address, whatever it resolves to now. */
const namedWaiver = (url: URL, guard: AddressGuard, origin: ConnectionOrigin, name?: string) =>
  origin === "host" && name !== undefined && Object.hasOwn(guard.named ?? {}, name) && guard.named![name] === hostPort(url);

/** The address to connect to for `url`: resolved, and checked unless the allow list for the connection's origin names it. */
async function checkedAddress(name: string, url: URL, guard: AddressGuard, origin: ConnectionOrigin = "repo"): Promise<Resolved> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const open = waived(url, guard, origin, name);
  // A page's allowance, unlike the host's list, gives way to a link-local address the name resolves to now.
  const pageOnly = open && namedWaiver(url, guard, origin, name) && !waived(url, { ...guard, named: {} }, origin, name);
  let found: Resolved[];
  try {
    found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await (guard.lookup ?? systemLookup)(host);
  } catch {
    throw new CallError(`${name}: ${url.hostname} doesn't resolve`, undefined, true);
  }
  if (!found.length || (!open && found.some((a) => blockedAddress(a.address))) || (pageOnly && found.some((a) => linkLocal(a.address)))) {
    throw new CallError(`${name}: ${url.hostname} isn't an address this host connects to`);
  }
  return found[0];
}

/** Whether the guard lets connection `name` to `url` through, without connecting. */
export async function addressAllowed(url: string, guard: AddressGuard, origin: ConnectionOrigin = "repo", name?: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (waived(u, guard, origin, name) && !namedWaiver(u, guard, origin, name)) return true;
    await checkedAddress(name ?? "check", u, guard, origin);
    return true;
  } catch {
    return false;
  }
}

const LINK_LOCAL = new net.BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");
// A cloud's instance metadata service, on IPv6.
LINK_LOCAL.addAddress("fd00:ec2::254", "ipv6");

/** Whether an address is link-local, where a cloud's metadata service answers: never opened from a page, only by the host's allow list. */
export function linkLocal(address: string): boolean {
  const bare = address.split("%")[0];
  const family = net.isIP(bare);
  if (family === 4) return LINK_LOCAL.check(bare, "ipv4");
  if (family !== 6) return false;
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? LINK_LOCAL.check(mapped[1], "ipv4") : LINK_LOCAL.check(bare, "ipv6");
}

/** Where a host connection to `url` lands, as the guard judges it: on a public address or one the guard opens, on a private one,
 * on a link-local one; null when it doesn't resolve here, or isn't a URL. */
export async function privateAddress(url: string, guard: AddressGuard): Promise<"public" | "private" | "link-local" | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (waived(u, guard, "host")) return "public";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  try {
    const found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await (guard.lookup ?? systemLookup)(host);
    if (!found.length) return null;
    if (found.some((a) => linkLocal(a.address))) return "link-local";
    return found.some((a) => blockedAddress(a.address)) ? "private" : "public";
  } catch {
    return null;
  }
}

/** fetch over node:http, connecting to `pin` whatever the URL's host resolves to now. Redirects come back as they are,
 * or, with `refuseRedirects`, fail. */
export function pinnedFetch(pin: Resolved, opts: { refuseRedirects?: boolean } = {}): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const lookup = ((_host: string, o: { all?: boolean }, done: (...a: unknown[]) => void) =>
      (o?.all ? done(null, [pin]) : done(null, pin.address, pin.family))) as unknown as net.LookupFunction;
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, lookup, signal: init.signal ?? undefined }, (res) => {
      const status = res.statusCode ?? 502;
      if (opts.refuseRedirects && status >= 300 && status < 400) {
        res.resume();
        reject(new CallError(`${url.host} answered ${status}, a redirect, which isn't followed`, status));
        return;
      }
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
      const empty = method === "HEAD" || status === 204 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }));
    });
    req.on("error", reject);
    const body = init.body;
    if (body === undefined || body === null) req.end();
    else if (typeof body === "string" || body instanceof Uint8Array) req.end(body);
    else reject(new TypeError("pinnedFetch sends only string or byte bodies"));
  })) as typeof fetch;
}

/** The fetch a connection to `url` uses: checked and pinned under a guard, else as given. */
async function fetchFor(name: string, url: string, origin: ConnectionOrigin | undefined, opts: ConnectionOptions,
                        refuseRedirects = false): Promise<typeof fetch> {
  if (!opts.guard) return opts.fetch ?? fetch;
  const pin = await checkedAddress(name, new URL(url), opts.guard, origin);
  return opts.fetch ?? pinnedFetch(pin, { refuseRedirects });
}

function authHeaders(c: Extract<ResolvedConnection, { kind: "http" }>): Record<string, string> {
  if (!c.secret || !c.auth) return {};
  if (c.auth === "bearer") return { authorization: `Bearer ${c.secret}` };
  if (c.auth === "basic") return { authorization: `Basic ${Buffer.from(c.secret).toString("base64")}` };
  return { [c.auth.slice("header:".length)]: c.secret };
}

/** Whether a call's path, as the URL resolves it, lies under one of the connection's path prefixes; true when it has none. */
export function pathAllowed(base: string, path: string, prefixes: string[] | undefined): boolean {
  if (!prefixes) return true;
  // An encoded separator or dot could mean another path to the far end than the one checked here.
  if (/%(2f|5c|2e)/i.test(path.split(/[?#]/)[0])) return false;
  let at: string;
  try {
    at = new URL(base + path).pathname.toLowerCase();
  } catch {
    return false;
  }
  return prefixes.some((p) => at.startsWith(p.toLowerCase()));
}

function httpConnection(name: string, c: Extract<ResolvedConnection, { kind: "http" }>, opts: ConnectionOptions): Connection {
  let fetcher: Promise<typeof fetch> | null = null;
  const base = c.url.replace(/\/+$/, "");
  const secrets = c.secret ? [c.secret, Buffer.from(c.secret).toString("base64")] : [];
  /** An answer can echo the credentials back; they never reach the plugin. */
  const hide = (t: string) => secrets.reduce((out, s) => out.split(s).join("***"), t);
  /** One request: headers the call adds under the connection's own, an answer that isn't a redirect or an error. */
  const request = async (call: Call, accept: string, redirects = false): Promise<{ res: Response; what: string }> => {
    const method = (call.method ?? "GET").toUpperCase();
    const path = call.path?.startsWith("/") ? call.path : `/${call.path ?? ""}`;
    const what = `${name}: ${method} ${path}`;
    if (!pathAllowed(base, path, c.paths)) throw new CallError(`${what}: this host's token for ${name} reaches only ${c.paths!.join(", ")}`);
    const headers: Record<string, string> = { accept, "user-agent": "todo-plugin-host" };
    if (call.text !== undefined) headers["content-type"] = "text/plain; charset=utf-8";
    else if (call.input !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, call.headers ?? {}, authHeaders(c));
    const f = await (fetcher ??= fetchFor(name, base, c.origin, opts));
    let res: Response;
    try {
      res = await f(base + path, { method, headers, body: call.text ?? (call.input === undefined ? undefined : JSON.stringify(call.input)),
                                   redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      throw new CallError(`${what} failed: ${(e as Error).message}`, undefined, true);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      if (redirects) return { res, what };
      throw new CallError(`${what} answered ${res.status}, a redirect, which isn't followed`, res.status);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CallError(`${what} answered ${res.status}${text ? `: ${hide(text).slice(0, SNIPPET)}` : ""}`, res.status);
    }
    return { res, what };
  };
  return {
    async send(call) {
      if (call.tool) throw new CallError(`${name}: an http connection takes method calls, not the tool ${call.tool}`);
      if (call.locate) {
        const { res } = await request({ ...call, method: "GET" }, "*/*", true);
        if (res.status >= 300 && res.status < 400) return res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const { res } = await request(call, "application/json");
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return call.full ? { status: res.status, body } : body;
    },
    async fetchBytes(path, max) {
      const { res, what } = await request({ connection: name, method: "GET", path }, "*/*");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) {
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(value);
        }
      } catch (e) {
        throw new CallError(`${what} failed: ${(e as Error).message}`, undefined, true);
      }
      return { bytes: Buffer.concat(chunks), type: res.headers.get("content-type") };
    },
    async isReadOnly(call) {
      return !!call.locate || READ_ONLY_METHODS.includes((call.method ?? "GET").toUpperCase());
    },
    async close() {},
  };
}

/** A tool's answer: its structured content, else its text parsed as JSON, else the text. */
export function toolResult(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): unknown {
  const texts = Array.isArray(result.content)
    ? result.content.filter((c: { type?: string }) => c?.type === "text").map((c: { text: string }) => c.text) : [];
  const text = texts.join("\n");
  if (result.isError) throw new CallError(text || "the tool reported an error");
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if (!texts.length) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mcpTransport(name: string, c: Extract<ResolvedConnection, { kind: "mcp" }>, opts: ConnectionOptions): Promise<Transport> {
  if (opts.mcpTransport) return opts.mcpTransport(name);
  if (c.command) return new StdioClientTransport({ command: c.command, args: c.args ?? [], stderr: "ignore" });
  if (!c.url) throw new CallError(`${name}: an mcp connection needs a url or a command`);
  const f = opts.guard ? await fetchFor(name, c.url, c.origin, opts, true) : undefined;
  return new StreamableHTTPClientTransport(new URL(c.url), {
    requestInit: c.secret ? { headers: { authorization: `Bearer ${c.secret}` } } : undefined, ...(f ? { fetch: f } : {}),
  });
}

function mcpConnection(name: string, c: Extract<ResolvedConnection, { kind: "mcp" }>, opts: ConnectionOptions): Connection {
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  let client: Promise<Client> | null = null;
  let transport: Transport | null = null;
  let readOnly: Promise<Set<string>> | null = null;
  const connect = () => client ??= (async () => {
    const cl = new Client({ name: "todo-plugin-host", version: "1.0.0" });
    transport = await mcpTransport(name, c, opts);
    await cl.connect(transport, { timeout });
    return cl;
  })();
  const readOnlyTools = () => readOnly ??= (async () => {
    const cl = await connect();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const listed = await cl.listTools(cursor ? { cursor } : {}, { timeout });
      for (const t of listed.tools) if (t.annotations?.readOnlyHint === true) names.add(t.name);
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return names;
  })();
  return {
    async send(call) {
      if (!call.tool) throw new CallError(`${name}: an mcp connection takes tool calls, not ${call.method} ${call.path}`);
      try {
        const cl = await connect();
        const res = await cl.callTool({ name: call.tool, arguments: (call.input ?? {}) as Record<string, unknown> }, undefined, { timeout });
        return toolResult(res as Parameters<typeof toolResult>[0]);
      } catch (e) {
        if (e instanceof CallError) throw new CallError(`${name}: ${call.tool}: ${e.message}`);
        throw new CallError(`${name}: ${call.tool} failed: ${(e as Error).message}`);
      }
    },
    async isReadOnly(call) {
      return !!call.tool && (await readOnlyTools()).has(call.tool);
    },
    async close() {
      // The transport, not the client: a connect still under way may never settle.
      await transport?.close().catch(() => {});
    },
  };
}

export function openConnection(name: string, c: ResolvedConnection, opts: ConnectionOptions = {}): Connection {
  return c.kind === "http" ? httpConnection(name, c, opts) : mcpConnection(name, c, opts);
}

export function describeCall(call: Call): string {
  return call.tool ? `${call.connection} ${call.tool}` : `${call.connection} ${call.method} ${call.path}`;
}

/** A YAML plugin's fail step: it ran again, as a failed send did, until a write goes through. */
export class PluginFailure extends Error {}

export class DeadlineError extends Error {
  constructor(message = "the run passed its deadline") {
    super(message);
  }
}

/** One run's calls: opened lazily, closed together, held back in dry-run, bounded by the deadline. */
export class Calls {
  private open = new Map<string, Connection>();

  constructor(private defs: Record<string, ResolvedConnection>, private result: RunResult,
              private opts: ConnectionOptions & { dryRun: boolean; deadline: number }) {}

  private connection(name: string): Connection {
    let c = this.open.get(name);
    if (!c) {
      const def = this.defs[name];
      if (!def) throw new CallError(`no connection named ${name}`);
      c = openConnection(name, def, this.opts);
      this.open.set(name, c);
    }
    return c;
  }

  remaining(): number {
    return this.opts.deadline - Date.now();
  }

  checkDeadline(): void {
    if (this.remaining() <= 0) throw new DeadlineError();
  }

  /** Whatever work a call needs, connecting and listing tools included, cut off at the deadline. */
  private async withinDeadline<T>(work: Promise<T>, call: Call): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(`the run passed its deadline during ${describeCall(call)}`)), Math.max(0, this.remaining()));
    });
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A write went through, so running the run again could repeat it. */
  wroteOk = false;
  /** The last call that failed. */
  failure?: CallError;

  /** Send a call, or in dry-run record it and answer null unless it only reads. */
  async send(call: Call): Promise<unknown> {
    this.checkDeadline();
    const c = this.connection(call.connection);
    const readOnly = await this.withinDeadline(c.isReadOnly(call), call);
    if (this.opts.dryRun && !readOnly) {
      recordWouldSend(this.result, call);
      addLog(this.result, `would send ${describeCall(call)}`);
      return null;
    }
    try {
      const answer = await this.withinDeadline(c.send(call), call);
      if (!readOnly) this.wroteOk = true;
      if (call.full && answer && typeof answer === "object") {
        const def = this.defs[call.connection];
        const base = def && "url" in def && def.url ? def.url.replace(/\/+$/, "") : "";
        return { ...(answer as object), method: call.method, url: base + (call.path ?? "") };
      }
      return answer;
    } catch (e) {
      if (e instanceof CallError) this.failure = e;
      throw e;
    }
  }

  /** GET a file through an http connection, as bytes; null past `max`. A fetch only reads, so dry-run sends it too. */
  async fetchBytes(connection: string, path: string, max: number): Promise<Fetched | null> {
    this.checkDeadline();
    const c = this.connection(connection);
    if (!c.fetchBytes) throw new CallError(`${connection}: only an http connection fetches a doc`);
    const call: Call = { connection, method: "GET", path };
    try {
      return await this.withinDeadline(c.fetchBytes(path, max), call);
    } catch (e) {
      if (e instanceof CallError) this.failure = e;
      throw e;
    }
  }

  /** Whether the run's failure can be retried: no write went through, and the failure was transient or the plugin's own. */
  retryable(e: unknown): boolean {
    if (this.wroteOk) return false;
    if (e instanceof PluginFailure) return true;
    const failure = e instanceof CallError ? e : this.failure;
    return !!failure?.transient;
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map((c) => c.close().catch(() => {})));
    this.open.clear();
  }
}
