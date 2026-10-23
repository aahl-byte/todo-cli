// Connections: named endpoints a plugin calls, over HTTP or MCP. Every call goes
// through Calls, which holds dry-run back and keeps to the run's deadline.
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

export interface ConnectionOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Stands in for the MCP transport, for tests. */
  mcpTransport?: (name: string) => Transport;
}

export interface Connection {
  send(call: Call): Promise<unknown>;
  isReadOnly(call: Call): Promise<boolean>;
  close(): Promise<void>;
}

export class CallError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
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

function authHeaders(c: Extract<ResolvedConnection, { kind: "http" }>): Record<string, string> {
  if (!c.secret || !c.auth) return {};
  if (c.auth === "bearer") return { authorization: `Bearer ${c.secret}` };
  if (c.auth === "basic") return { authorization: `Basic ${Buffer.from(c.secret).toString("base64")}` };
  return { [c.auth.slice("header:".length)]: c.secret };
}

function httpConnection(name: string, c: Extract<ResolvedConnection, { kind: "http" }>, opts: ConnectionOptions): Connection {
  const f = opts.fetch ?? fetch;
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
      let res: Response;
      try {
        res = await f(base + path, { method, headers, body: call.input === undefined ? undefined : JSON.stringify(call.input),
                                     redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
      } catch (e) {
        throw new CallError(`${what} failed: ${(e as Error).message}`);
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

function mcpTransport(name: string, c: Extract<ResolvedConnection, { kind: "mcp" }>, opts: ConnectionOptions): Transport {
  if (opts.mcpTransport) return opts.mcpTransport(name);
  if (c.command) return new StdioClientTransport({ command: c.command, args: c.args ?? [], stderr: "ignore" });
  if (!c.url) throw new CallError(`${name}: an mcp connection needs a url or a command`);
  return new StreamableHTTPClientTransport(new URL(c.url), {
    requestInit: c.secret ? { headers: { authorization: `Bearer ${c.secret}` } } : undefined,
  });
}

function mcpConnection(name: string, c: Extract<ResolvedConnection, { kind: "mcp" }>, opts: ConnectionOptions): Connection {
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  let client: Promise<Client> | null = null;
  let transport: Transport | null = null;
  let readOnly: Promise<Set<string>> | null = null;
  const connect = () => client ??= (async () => {
    const cl = new Client({ name: "todo-plugin-host", version: "1.0.0" });
    transport = mcpTransport(name, c, opts);
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

  /** Send a call, or in dry-run record it and answer null unless it only reads. */
  async send(call: Call): Promise<unknown> {
    this.checkDeadline();
    const c = this.connection(call.connection);
    if (this.opts.dryRun && !(await this.withinDeadline(c.isReadOnly(call), call))) {
      recordWouldSend(this.result, call);
      addLog(this.result, `would send ${describeCall(call)}`);
      return null;
    }
    return this.withinDeadline(c.send(call), call);
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map((c) => c.close().catch(() => {})));
    this.open.clear();
  }
}
