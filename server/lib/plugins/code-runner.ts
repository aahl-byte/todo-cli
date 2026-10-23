// Code plugins run in QuickJS (asyncify build): no file system, no timers, no
// network but their declared connections, a memory limit and a total deadline.
// Host calls look synchronous to the plugin; the host awaits them in between.
import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant, type JSPromiseState, type QuickJSAsyncContext, type QuickJSAsyncRuntime, type QuickJSHandle,
} from "quickjs-emscripten-core";
import { AttachError, makeAttachment } from "./attachments";
import { CallError, withQuery, type Calls } from "./connections";
import { ATTACHMENT_KINDS, DEFAULT_MEMORY_BYTES, type Attachment, type AttachmentKind, type Call, type PluginDef, type PluginEvent,
  type PluginItem, type RunResult } from "./types";

export interface CodeRun {
  plugin: PluginDef;
  code: string;
  item: PluginItem;
  event: PluginEvent;
  settings: Record<string, unknown>;
  calls: Calls;
  result: RunResult;
  deadline: number;
  memoryBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

class DeadlineError extends Error {}

/** Builds the run() argument inside the sandbox from the raw host functions, then hides them. */
const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const ms = (d) => {
    if (typeof d === "number" && d >= 0) return d;
    const m = typeof d === "string" && d.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
    if (!m) throw new Error("not a duration: " + JSON.stringify(d));
    return Number(m[1]) * UNITS[m[2]];
  };
  const answer = (raw) => {
    const r = JSON.parse(raw);
    if ("error" in r) throw Object.assign(new Error(r.error), r.status === undefined ? {} : { status: r.status });
    return r.value;
  };
  const sleep = (d) => answer(host.sleep(ms(d)));
  const freeze = (v) => {
    if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
  };
  const client = (name) => {
    const send = async (call) => answer(host.call(name, JSON.stringify(call)));
    const http = (method) => async (path, body) => send({ method, path, body });
    return Object.freeze({
      call: async (tool, input) => send({ tool, input: input === undefined ? {} : input }),
      get: async (path, query) => send({ method: "GET", path, query }),
      post: http("POST"), put: http("PUT"), patch: http("PATCH"), delete: http("DELETE"),
    });
  };
  const attach = {};
  for (const kind of host.kinds) {
    attach[kind] = (fields) => {
      answer(host.attach(kind, JSON.stringify(fields === undefined ? null : fields)));
    };
  }
  const wait = Object.freeze({
    async until(fn, opts = {}) {
      const every = ms(opts.every === undefined ? "1s" : opts.every);
      const timeout = opts.timeout === undefined ? "1m" : opts.timeout;
      const end = Date.now() + ms(timeout);
      for (;;) {
        const v = await fn();
        if (v) return v;
        const left = end - Date.now();
        if (left <= 0) throw new Error("wait.until gave up after " + timeout);
        sleep(Math.min(every, left));
      }
    },
    async retry(fn, opts = {}) {
      const attempts = opts.attempts === undefined ? 3 : opts.attempts;
      const every = ms(opts.every === undefined ? "1s" : opts.every);
      for (let i = 1; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i >= attempts || (opts.when && !(await opts.when(e)))) throw e;
          sleep(every);
        }
      }
    },
  });
  const ctx = {};
  for (const name of host.connections) ctx[name] = client(name);
  Object.assign(ctx, {
    item: freeze(JSON.parse(host.item)), event: freeze(JSON.parse(host.event)), settings: freeze(JSON.parse(host.settings)),
    attach: Object.freeze(attach), wait,
  });
  globalThis.__main = async (mod) => {
    const run = mod.run === undefined ? mod.default : mod.run;
    if (typeof run !== "function") throw new Error("the plugin exports no run function");
    await run(Object.freeze(ctx));
  };
})();
`;

const START = `(() => { const main = globalThis.__main, mod = globalThis.__plugin; delete globalThis.__main; delete globalThis.__plugin; return main(mod); })()`;

const envelope = (r: { value?: unknown } | { error: string; status?: number }) => JSON.stringify(r);

/** What the plugin threw, as its message; a built-in error kind such as TypeError leads it. */
function thrown(ctx: QuickJSAsyncContext, handle: QuickJSHandle): string {
  const e = ctx.dump(handle);
  if (e && typeof e === "object" && "message" in e) {
    const { name, message } = e as { name?: unknown; message: unknown };
    return typeof name === "string" && name !== "Error" ? `${name}: ${message}` : String(message);
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** The emscripten internals quickjs-emscripten keeps private, needed to run queued jobs asynchronously. */
interface Internals {
  module: { cwrap(name: string, ret: string, args: string[], opts: { async: true }): (...a: number[]) => Promise<number>;
            _malloc(n: number): number; _free(p: number): void; HEAPU8: Uint8Array };
  rt: { value: number };
}

/**
 * Run one queued job with the asyncified entry point, so a host call made from
 * an `await` continuation can suspend. The core's executePendingJobs can't.
 */
function jobRunner(rt: QuickJSAsyncRuntime, ctx: QuickJSAsyncContext) {
  const { module, rt: ptr } = rt as unknown as Internals;
  const execute = module.cwrap("QTS_ExecutePendingJob", "number", ["number", "number", "number"], { async: true });
  return async (): Promise<string | null> => {
    const out = module._malloc(4);
    try {
      new Int32Array(module.HEAPU8.buffer, out, 1)[0] = 0;
      const valuePtr = await execute(ptr.value, 1, out);
      const value = ctx.getMemory(ptr.value as never).heapValueHandle(valuePtr as never);
      try {
        return ctx.typeof(value) === "number" ? null : thrown(ctx, value);
      } finally {
        value.dispose();
      }
    } finally {
      module._free(out);
    }
  };
}

function callOf(connection: string, raw: Record<string, unknown>): Call {
  if (typeof raw.tool === "string") return { connection, tool: raw.tool, input: raw.input ?? {} };
  const path = typeof raw.path === "string" ? raw.path : "/";
  const call: Call = { connection, method: String(raw.method), path: withQuery(path, raw.query as Record<string, unknown> | undefined) };
  if (raw.body !== undefined && raw.body !== null) call.input = raw.body;
  return call;
}

export async function runCode(run: CodeRun): Promise<Attachment[]> {
  const { calls, deadline } = run;
  const attached: Attachment[] = [];
  const connections = run.plugin.connections ?? [];
  const sleep = run.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const capable = run.plugin.capabilities?.includes("post-request") ?? false;
  let timedOut = false;
  const pastDeadline = () => {
    if (Date.now() >= deadline) timedOut = true;
    return timedOut;
  };

  // A fresh WebAssembly module per run: asyncify can suspend only one call per module at a time.
  const wasm = await newQuickJSAsyncWASMModuleFromVariant(variant);
  const rt = wasm.newRuntime();
  rt.setMemoryLimit(run.memoryBytes ?? DEFAULT_MEMORY_BYTES);
  rt.setInterruptHandler(pastDeadline);
  const ctx = rt.newContext();
  const handles: QuickJSHandle[] = [];
  const keep = (h: QuickJSHandle) => (handles.push(h), h);

  try {
    const host = keep(ctx.newObject());
    const str = (v: unknown) => keep(ctx.newString(typeof v === "string" ? v : JSON.stringify(v)));
    ctx.setProp(host, "item", str(run.item));
    ctx.setProp(host, "event", str(run.event));
    ctx.setProp(host, "settings", str(run.settings));
    ctx.setProp(host, "connections", keep(ctx.unwrapResult(ctx.evalCode(JSON.stringify(connections)))));
    ctx.setProp(host, "kinds", keep(ctx.unwrapResult(ctx.evalCode(JSON.stringify(ATTACHMENT_KINDS)))));

    ctx.setProp(host, "call", keep(ctx.newAsyncifiedFunction("call", async (nameH, callH) => {
      const name = ctx.getString(nameH);
      try {
        if (pastDeadline()) throw new DeadlineError("the run passed its deadline");
        if (!connections.includes(name)) throw new CallError(`${name} isn't one of the plugin's connections`);
        const value = await calls.send(callOf(name, JSON.parse(ctx.getString(callH))));
        return ctx.newString(envelope({ value: value ?? null }));
      } catch (e) {
        pastDeadline();
        return ctx.newString(envelope({ error: (e as Error).message, status: e instanceof CallError ? e.status : undefined }));
      }
    })));

    ctx.setProp(host, "sleep", keep(ctx.newAsyncifiedFunction("sleep", async (msH) => {
      const want = ctx.getNumber(msH);
      const left = deadline - Date.now();
      await sleep(Math.max(0, Math.min(want, left)));
      if (want >= left || pastDeadline()) {
        timedOut = true;
        return ctx.newString(envelope({ error: "the run passed its deadline" }));
      }
      return ctx.newString(envelope({ value: null }));
    })));

    ctx.setProp(host, "attach", keep(ctx.newFunction("attach", (kindH, fieldsH) => {
      const kind = ctx.getString(kindH) as AttachmentKind;
      try {
        if (kind === "request" && !capable) throw new AttachError("attach.request needs the post-request capability");
        const fields = JSON.parse(ctx.getString(fieldsH));
        const key = fields && typeof fields === "object" ? fields.key : undefined;
        attached.push(makeAttachment(kind, fields, key));
        return ctx.newString(envelope({ value: null }));
      } catch (e) {
        return ctx.newString(envelope({ error: (e as Error).message }));
      }
    })));
    ctx.setProp(ctx.global, "__host", host);

    const runJob = jobRunner(rt, ctx);
    const settle = async (h: QuickJSHandle): Promise<Exclude<JSPromiseState, { type: "pending" }>> => {
      for (;;) {
        const state = ctx.getPromiseState(h);
        if (state.type !== "pending") return state;
        if (pastDeadline()) throw new DeadlineError("");
        if (!rt.hasPendingJob()) throw new Error("run() is waiting on something that never finishes");
        const failed = await runJob();
        if (failed !== null && !pastDeadline()) throw new Error(failed);
      }
    };
    const evaluate = async (code: string, filename: string, type: "global" | "module") => {
      const r = await ctx.evalCodeAsync(code, filename, { type });
      if (r.error) {
        const msg = thrown(ctx, r.error);
        r.error.dispose();
        throw pastDeadline() ? new DeadlineError("") : new Error(msg);
      }
      return keep(r.value);
    };
    const outcome = async (h: QuickJSHandle) => {
      const state = await settle(h);
      if (state.type === "rejected") {
        const msg = thrown(ctx, state.error);
        state.error.dispose();
        throw pastDeadline() ? new DeadlineError("") : new Error(msg);
      }
      if (!state.notAPromise) keep(state.value);
      return state.value;
    };

    await evaluate(PRELUDE, "prelude.js", "global");
    const ns = await outcome(await evaluate(run.code, run.plugin.code ?? "plugin.js", "module"));
    ctx.setProp(ctx.global, "__plugin", ns);
    await outcome(await evaluate(START, "start.js", "global"));
    if (timedOut) throw new DeadlineError("");
    return attached;
  } catch (e) {
    if (e instanceof DeadlineError || timedOut) throw new Error("the run passed its deadline");
    throw e;
  } finally {
    for (const h of handles.reverse()) if (h.alive) h.dispose();
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      // a run cut short can leave the runtime mid-job; its module is dropped either way
    }
  }
}
