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
import type { Call, ResolvedConnection, RunResult } from "./types";

export const TIMEOUT_MS = 15_000;
const SNIPPET = 300;
const READ_ONLY_METHODS = ["GET", "HEAD"];
/** Pages of listTools read before deciding which tools are read-only. */
export const MAX_TOOL_PAGES = 20;

export interface Resolved { address: string; family: number }

/** Keeps connections off this host's own network: loopback, private, link-local, CGNAT and unique-local addresses. */
export interface AddressGuard {
  /** Hosts, or host:port pairs, reachable even on such an address. */
  allow: string[];
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

export interface Connection {
  send(call: Call): Promise<unknown>;
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

const BLOCKED = new net.BlockList();
for (const [net4, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
                            ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  BLOCKED.addSubnet(net4, bits, "ipv4");
}
for (const [net6, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  BLOCKED.addSubnet(net6, bits, "ipv6");
}

/** Whether an IP address is on a network a server must not reach on a plugin's behalf. */
export function blockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return true;
  // An IPv4-mapped IPv6 address is the IPv4 address it carries.
  const mapped = family === 6 && address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return BLOCKED.check(mapped[1], "ipv4");
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

const systemLookup = async (host: string): Promise<Resolved[]> => dnsLookup(host, { all: true, verbatim: true });

/** The address to connect to for `url`, once checked; null when the allow list waives the check. */
async function checkedAddress(name: string, url: URL, guard: AddressGuard): Promise<Resolved | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const allowed = guard.allow.map((a) => a.trim().toLowerCase().replace(/^\[(.*)\](:\d+)?$/, "$1$2"));
  if (allowed.includes(host) || allowed.includes(`${host}:${port}`)) return null;
  const refused = new CallError(`${name}: ${url.hostname} isn't an address this host connects to`);
  let found: Resolved[];
  try {
    found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await (guard.lookup ?? systemLookup)(host);
  } catch {
    throw new CallError(`${name}: ${url.hostname} doesn't resolve`, undefined, true);
  }
  if (!found.length || found.some((a) => blockedAddress(a.address))) throw refused;
  return found[0];
}

/** fetch over node:http, connecting to `pin` whatever the URL's host resolves to now. */
export function pinnedFetch(pin: Resolved): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const lookup = ((_host: string, opts: { all?: boolean }, done: (...a: unknown[]) => void) =>
      (opts?.all ? done(null, [pin]) : done(null, pin.address, pin.family))) as unknown as net.LookupFunction;
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, lookup, signal: init.signal ?? undefined }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
      const status = res.statusCode ?? 502;
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
async function fetchFor(name: string, url: string, opts: ConnectionOptions): Promise<typeof fetch> {
  if (!opts.guard) return opts.fetch ?? fetch;
  const pin = await checkedAddress(name, new URL(url), opts.guard);
  return pin && !opts.fetch ? pinnedFetch(pin) : opts.fetch ?? fetch;
}

function authHeaders(c: Extract<ResolvedConnection, { kind: "http" }>): Record<string, string> {
  if (!c.secret || !c.auth) return {};
  if (c.auth === "bearer") return { authorization: `Bearer ${c.secret}` };
  if (c.auth === "basic") return { authorization: `Basic ${Buffer.from(c.secret).toString("base64")}` };
  return { [c.auth.slice("header:".length)]: c.secret };
}

function httpConnection(name: string, c: Extract<ResolvedConnection, { kind: "http" }>, opts: ConnectionOptions): Connection {
  let fetcher: Promise<typeof fetch> | null = null;
  const base = c.url.replace(/\/+$/, "");
  const secrets = c.secret ? [c.secret, Buffer.from(c.secret).toString("base64")] : [];
  /** An answer can echo the credentials back; they never reach the plugin. */
  const hide = (t: string) => secrets.reduce((out, s) => out.split(s).join("***"), t);
  return {
    async send(call) {
      if (call.tool) throw new CallError(`${name}: an http connection takes method calls, not the tool ${call.tool}`);
      const method = (call.method ?? "GET").toUpperCase();
      const path = call.path?.startsWith("/") ? call.path : `/${call.path ?? ""}`;
      const what = `${name}: ${method} ${path}`;
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "todo-plugin-host", ...authHeaders(c) };
      if (call.input !== undefined) headers["content-type"] = "application/json";
      const f = await (fetcher ??= fetchFor(name, base, opts));
      let res: Response;
      try {
        res = await f(base + path, { method, headers, body: call.input === undefined ? undefined : JSON.stringify(call.input),
                                     redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
      } catch (e) {
        throw new CallError(`${what} failed: ${(e as Error).message}`, undefined, true);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new CallError(`${what} answered ${res.status}, a redirect, which isn't followed`, res.status);
      }
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new CallError(`${what} answered ${res.status}${text ? `: ${hide(text).slice(0, SNIPPET)}` : ""}`, res.status);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    async isReadOnly(call) {
      return READ_ONLY_METHODS.includes((call.method ?? "GET").toUpperCase());
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
  const f = opts.guard ? await fetchFor(name, c.url, opts) : undefined;
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

  /** A call went out that may have changed something. */
  wrote = false;
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
    if (!readOnly) this.wrote = true;
    try {
      return await this.withinDeadline(c.send(call), call);
    } catch (e) {
      if (e instanceof CallError) this.failure = e;
      throw e;
    }
  }

  /** Whether the run's failure can be retried: the last failed call was transient and nothing was written. */
  retryable(e: unknown): boolean {
    const failure = e instanceof CallError ? e : this.failure;
    return !!failure?.transient && !this.wrote;
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map((c) => c.close().catch(() => {})));
    this.open.clear();
  }
}
