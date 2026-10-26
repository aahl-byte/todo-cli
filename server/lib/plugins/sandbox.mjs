// The QuickJS sandbox a code plugin runs in (asyncify build): no file system, no
// timers, no network but the host functions it's given, a memory limit and a
// deadline. Plain JS so a worker thread can load it as it stands.
import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";

const PLUGIN_MODULE = "plugin.js";
/** How much of a thrown value is read back; the host caps it further. */
const MAX_THROWN = 16 * 1024;
/** QuickJS's own stack limit, below what a worker thread or the main thread can hold, so deep recursion is a plain error. */
const MAX_STACK_BYTES = 256 * 1024;

/** Builds the run() argument from the raw host functions, before any plugin code can change a global it uses. */
const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const { stringify, parse } = JSON;
  const { freeze, assign, values } = Object;
  const Err = Error, Str = String, Num = Number, min = Math.min, now = Date.now;
  const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/;
  const exec = RegExp.prototype.exec;
  const isArray = Array.isArray;
  const ms = (d) => {
    if (typeof d === "number" && d >= 0) return d;
    const m = typeof d === "string" ? exec.call(DURATION, d) : null;
    if (!m) throw new Err("not a duration: " + stringify(d));
    return Num(m[1]) * UNITS[m[2]];
  };
  const answer = (raw) => {
    const r = parse(raw);
    if ("error" in r) throw assign(new Err(r.error), r.status === undefined ? {} : { status: r.status });
    return r.value;
  };
  const sleep = (d) => answer(host.sleep(ms(d)));
  const deepFreeze = (v) => {
    if (v && typeof v === "object") { for (const x of values(v)) deepFreeze(x); freeze(v); }
    return v;
  };
  const json = (v) => { const s = stringify(v === undefined ? null : v); return s === undefined ? "null" : s; };
  const client = (name) => {
    const send = async (call) => answer(host.call(name, json(call)));
    const http = (method) => async (path, body) => send({ method, path, body });
    return freeze({
      call: async (tool, input) => send({ tool, input: input === undefined ? {} : input }),
      get: async (path, query) => send({ method: "GET", path, query }),
      post: http("POST"), put: http("PUT"), patch: http("PATCH"), delete: http("DELETE"),
    });
  };
  const attach = {};
  for (const kind of host.kinds) attach[kind] = (fields) => { answer(host.attach(kind, json(fields))); };
  const wait = freeze({
    async until(fn, opts = {}) {
      const every = ms(opts.every === undefined ? "1s" : opts.every);
      const timeout = opts.timeout === undefined ? "1m" : opts.timeout;
      const end = now() + ms(timeout);
      for (;;) {
        const v = await fn();
        if (v) return v;
        const left = end - now();
        if (left <= 0) throw new Err("wait.until gave up after " + timeout);
        sleep(min(every, left));
      }
    },
    async retry(fn, opts = {}) {
      const attempts = opts.attempts === undefined ? 3 : opts.attempts;
      const given = opts.every === undefined ? "1s" : opts.every;
      // A list waits each duration in turn, then its last one again.
      const waits = isArray(given) ? given.map(ms) : [ms(given)];
      if (!waits.length) throw new Err("wait.retry needs at least one duration in every");
      for (let i = 1; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i >= attempts || (opts.when && !(await opts.when(e)))) throw e;
          sleep(waits[min(i, waits.length) - 1]);
        }
      }
    },
  });
  const ctx = {};
  for (const name of host.connections) ctx[name] = client(name);
  assign(ctx, {
    item: deepFreeze(parse(host.item)), event: deepFreeze(parse(host.event)), settings: deepFreeze(parse(host.settings)),
    attach: freeze(attach), wait,
  });
  freeze(ctx);
  /** What the plugin threw, as text, read here so no plugin code runs while the host reads it. */
  const describe = (e) => {
    try {
      if (e !== null && typeof e === "object" && typeof e.message === "string") {
        return typeof e.name === "string" && e.name !== "Error" ? e.name + ": " + e.message : e.message;
      }
      return typeof e === "string" ? e : Str(e);
    } catch (_) {
      return "the plugin threw something that can't be read";
    }
  };
  globalThis.__main = async () => {
    try {
      const mod = await import("${PLUGIN_MODULE}");
      const run = mod.run === undefined ? mod.default : mod.run;
      if (typeof run !== "function") throw new Err("the plugin exports no run function");
      await run(ctx);
      return true;
    } catch (e) {
      const text = describe(e);
      return typeof text === "string" ? text : "the plugin threw something that can't be read";
    }
  };
})();
`;

const START = `(() => { const main = globalThis.__main; delete globalThis.__main; return main(); })()`;

class Deadline extends Error {}

/** A host-side failure as one line, without file paths. */
export function hostFailure(e) {
  const first = String(e?.message ?? e).split("\n")[0];
  return first.replace(/(file:\/\/)?(\/[^\s/:()]+)+\.(m?js|cjs|ts|c|wasm)(:\d+)*/g, "…").trim();
}

/**
 * Run one queued job through the asyncified entry point, so a host call made in
 * an `await` continuation can suspend; the library's executePendingJobs can't.
 * It reaches emscripten internals that quickjs-emscripten keeps private.
 */
function jobRunner(rt, ctx) {
  const { module, rt: ptr } = rt;
  const execute = module.cwrap("QTS_ExecutePendingJob", "number", ["number", "number", "number"], { async: true });
  return async () => {
    const out = module._malloc(4);
    try {
      new Int32Array(module.HEAPU8.buffer, out, 1)[0] = 0;
      const valuePtr = await execute(ptr.value, 1, out);
      const value = ctx.getMemory(ptr.value).heapValueHandle(valuePtr);
      try {
        return ctx.typeof(value) === "number";
      } finally {
        value.dispose();
      }
    } finally {
      module._free(out);
    }
  };
}

/**
 * Run a plugin's module. `host` answers call(name, json), attach(kind, json) and
 * sleep(ms), each with a JSON envelope {value} or {error, status?}. Never throws;
 * resolves {error} when the run failed.
 */
export async function runSandbox(job, host) {
  let timedOut = false;
  const pastDeadline = () => {
    if (Date.now() >= job.deadline) timedOut = true;
    return timedOut;
  };
  let rt, ctx;
  const handles = [];
  const keep = (h) => (handles.push(h), h);
  try {
    // A fresh WebAssembly module per run: asyncify can suspend only one call per module at a time.
    const wasm = await newQuickJSAsyncWASMModuleFromVariant(variant);
    rt = wasm.newRuntime();
    rt.setMemoryLimit(job.memoryBytes);
    rt.setMaxStackSize(MAX_STACK_BYTES);
    rt.setInterruptHandler(pastDeadline);
    rt.setModuleLoader((name) => (name === PLUGIN_MODULE ? job.code : { error: new Error(`${name} can't be imported in a plugin`) }));
    ctx = rt.newContext();

    const typeError = (message) => ({ error: ctx.newError({ name: "TypeError", message }) });
    /** A host function that takes only the given argument types and answers with the host's envelope. */
    const hostFn = (name, types, answer) => keep(ctx.newAsyncifiedFunction(name, async (...args) => {
      for (let i = 0; i < types.length; i++) {
        if (!args[i] || ctx.typeof(args[i]) !== types[i]) return typeError(`${name} takes a ${types[i]} as argument ${i + 1}`);
      }
      const values = types.map((t, i) => (t === "string" ? ctx.getString(args[i]) : ctx.getNumber(args[i])));
      let reply;
      try {
        if (pastDeadline()) throw new Deadline();
        reply = await answer(...values);
      } catch (e) {
        reply = JSON.stringify({ error: e instanceof Deadline ? "the run passed its deadline" : hostFailure(e) });
      }
      pastDeadline();
      return ctx.newString(typeof reply === "string" ? reply : JSON.stringify({ error: "the host gave no answer" }));
    }));

    const hostObj = keep(ctx.newObject());
    const str = (v) => keep(ctx.newString(JSON.stringify(v)));
    ctx.setProp(hostObj, "item", str(job.item));
    ctx.setProp(hostObj, "event", str(job.event));
    ctx.setProp(hostObj, "settings", str(job.settings));
    ctx.setProp(hostObj, "connections", keep(ctx.unwrapResult(ctx.evalCode(JSON.stringify(job.connections)))));
    ctx.setProp(hostObj, "kinds", keep(ctx.unwrapResult(ctx.evalCode(JSON.stringify(job.kinds)))));
    ctx.setProp(hostObj, "call", hostFn("call", ["string", "string"], (name, call) => host.call(name, call)));
    ctx.setProp(hostObj, "attach", hostFn("attach", ["string", "string"], (kind, fields) => host.attach(kind, fields)));
    ctx.setProp(hostObj, "sleep", hostFn("sleep", ["number"], (ms) => host.sleep(ms)));
    ctx.setProp(ctx.global, "__host", hostObj);

    const runJob = jobRunner(rt, ctx);
    const evaluate = async (code, filename) => {
      const r = await ctx.evalCodeAsync(code, filename, { type: "global" });
      if (r.error) {
        r.error.dispose();
        throw pastDeadline() ? new Deadline() : new Error(`the plugin sandbox failed in ${filename}`);
      }
      return keep(r.value);
    };

    await evaluate(PRELUDE, "prelude.js");
    const main = await evaluate(START, "start.js");
    for (;;) {
      const state = ctx.getPromiseState(main);
      if (state.type === "fulfilled") {
        keep(state.value);
        if (timedOut) throw new Deadline();
        const t = ctx.typeof(state.value);
        if (t === "string") return { error: ctx.getString(state.value).slice(0, MAX_THROWN) };
        return t === "boolean" ? {} : { error: "the plugin threw something that can't be read" };
      }
      if (state.type === "rejected") {
        state.error.dispose();
        throw pastDeadline() ? new Deadline() : new Error("the plugin sandbox failed");
      }
      if (pastDeadline()) throw new Deadline();
      if (!rt.hasPendingJob()) return { error: "run() is waiting on something that never finishes" };
      if (!(await runJob()) && pastDeadline()) throw new Deadline();
    }
  } catch (e) {
    if (e instanceof Deadline || timedOut) return { error: "the run passed its deadline" };
    return { error: `the plugin sandbox failed: ${hostFailure(e)}` };
  } finally {
    for (const h of handles.reverse()) if (h.alive) h.dispose();
    try {
      ctx?.dispose();
      rt?.dispose();
    } catch {
      // a run cut short can leave the runtime mid-job; its module is dropped either way
    }
  }
}
