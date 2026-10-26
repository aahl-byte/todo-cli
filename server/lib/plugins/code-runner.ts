// The host side of a code plugin: what its sandbox may call, attach and sleep,
// and where the sandbox runs. In-process hosts run it in a worker thread so a
// crash ends only the worker; the CLI's bundle is its own process and runs it inline.
import { Worker } from "node:worker_threads";
import { AttachError, makeAttachment } from "./attachments";
import { CallError, DeadlineError, withQuery, type Calls } from "./connections";
import { addLog, LimitError, type Attached } from "./limits";
import { hostFailure, runSandbox, type SandboxHost, type SandboxJob } from "./sandbox.mjs";
import { ATTACHMENT_KINDS, DEFAULT_MEMORY_BYTES, type AttachmentKind, type Call, type PluginDef, type PluginEvent, type PluginItem,
  type RunResult } from "./types";

export type Isolation = "worker" | "inline";

export interface CodeRun {
  name: string;
  plugin: PluginDef;
  code: string;
  item: PluginItem;
  event: PluginEvent;
  settings: Record<string, unknown>;
  calls: Calls;
  result: RunResult;
  attached: Attached;
  /** The plugin declares post-request and the host granted it. */
  mayRequest: boolean;
  deadline: number;
  /** Writes are held back, so a plugin can stop where a write's answer would matter. */
  dryRun?: boolean;
  instance?: { id: string; name: string };
  trigger?: string;
  memoryBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  isolation?: Isolation;
  workerUrl?: URL;
  /** The pool of sandboxes this run waits for. */
  slots: CodeSlots;
  /** Which repo the plugin came from, for the pool's per-repo share. */
  repoKey: string;
}

export const DEFAULT_CODE_RUNS = 4;
export const DEFAULT_CODE_RUNS_PER_REPO = 2;
/** A repo's code plugin gets a minute unless its limits say otherwise; shipped ones get the host default. */
export const REPO_CODE_DEADLINE_MS = 60_000;

/** A counting semaphore with a per-repo share, whose waiters give up at their own deadline. */
export class CodeSlots {
  private active = new Map<string, number>();
  private running = 0;
  private waiting: { repo: string; grant: () => void }[] = [];

  constructor(readonly total = DEFAULT_CODE_RUNS, readonly perRepo = DEFAULT_CODE_RUNS_PER_REPO) {}

  private free(repo: string): boolean {
    return this.running < this.total && (this.active.get(repo) ?? 0) < this.perRepo;
  }

  private claim(repo: string): void {
    this.running++;
    this.active.set(repo, (this.active.get(repo) ?? 0) + 1);
  }

  /** Take a slot for a repo, or false once the deadline passes first. */
  take(repo: string, deadline: number): Promise<boolean> {
    if (this.free(repo) && !this.waiting.some((w) => w.repo === repo)) {
      this.claim(repo);
      return Promise.resolve(true);
    }
    return new Promise((done) => {
      const waiter = {
        repo,
        grant: () => {
          clearTimeout(timer);
          this.claim(repo);
          done(true);
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        done(false);
      }, Math.max(0, deadline - Date.now()));
      this.waiting.push(waiter);
    });
  }

  give(repo: string): void {
    this.running--;
    this.active.set(repo, (this.active.get(repo) ?? 1) - 1);
    // The longest-waiting run whose repo has room goes next.
    const next = this.waiting.findIndex((w) => this.free(w.repo));
    if (next >= 0) this.waiting.splice(next, 1)[0].grant();
  }
}

let shared: CodeSlots | undefined;

/** The host-wide pool, sized by the first call that creates it. */
export function hostCodeSlots(total?: number, perRepo?: number): CodeSlots {
  return (shared ??= new CodeSlots(total, perRepo));
}

// One self-contained file, so a bundler that copies it as an asset ships a worker that runs.
const WORKER_URL = new URL("./code-worker.bundle.mjs", import.meta.url);
/** How long past the deadline a worker gets before it's terminated. */
const KILL_GRACE_MS = 5_000;
const WORKER_HEAP_MB = 256;
const OPS = ["call", "attach", "sleep"] as const;

const envelope = (r: { value: unknown } | { error: string; status?: number }) => JSON.stringify(r);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function callOf(connection: string, raw: Record<string, unknown>): Call {
  if (typeof raw.tool === "string") return { connection, tool: raw.tool, input: raw.input ?? {} };
  const path = typeof raw.path === "string" ? raw.path : "/";
  const call: Call = { connection, method: String(raw.method), path: withQuery(path, isMap(raw.query) ? raw.query : undefined) };
  if (raw.locate === true) call.locate = true;
  if (raw.body !== undefined && raw.body !== null) call.input = raw.body;
  return call;
}

function hostFor(run: CodeRun): SandboxHost {
  const connections = run.plugin.connections ?? [];
  const sleep = run.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return {
    async call(name, raw) {
      try {
        if (!connections.includes(name)) throw new CallError(`${name} isn't one of the plugin's connections`);
        const parsed = JSON.parse(raw);
        if (!isMap(parsed)) throw new CallError("a call must be an object");
        return envelope({ value: (await run.calls.send(callOf(name, parsed))) ?? null });
      } catch (e) {
        if (e instanceof CallError) return envelope({ error: e.message, status: e.status });
        if (e instanceof DeadlineError) return envelope({ error: e.message });
        return envelope({ error: hostFailure(e) });
      }
    },
    async attach(kind, raw) {
      try {
        if (!ATTACHMENT_KINDS.includes(kind as AttachmentKind)) throw new AttachError(`there's no attach.${kind}`);
        if (kind === "request" && !run.mayRequest) {
          addLog(run.result, `dropped a request: ${run.name} hasn't been granted post-request`);
          return envelope({ value: null });
        }
        const fields = JSON.parse(raw);
        run.attached.add(makeAttachment(kind as AttachmentKind, fields, isMap(fields) ? fields.key : undefined), run.result);
        return envelope({ value: null });
      } catch (e) {
        if (e instanceof LimitError) run.attached.failure ??= e.message;
        return envelope({ error: e instanceof AttachError || e instanceof LimitError ? e.message : hostFailure(e) });
      }
    },
    async sleep(ms) {
      const left = run.deadline - Date.now();
      await sleep(Math.max(0, Math.min(ms, left)));
      return ms >= left ? envelope({ error: "the run passed its deadline" }) : envelope({ value: null });
    },
  };
}

/** The sandbox in its own thread; whatever happens to the thread comes back as an error. */
function inWorker(job: SandboxJob, host: SandboxHost, url: URL): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(url, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    let settled = false;
    const finish = (out: { error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      void worker.terminate();
      resolve(out);
    };
    const kill = setTimeout(() => finish({ error: "the run passed its deadline" }), Math.max(0, job.deadline - Date.now()) + KILL_GRACE_MS);
    worker.on("message", async (m: { op: string; id: number; args: unknown[]; error?: string }) => {
      if (m.op === "done") return finish(m.error === undefined ? {} : { error: m.error });
      if (!OPS.includes(m.op as (typeof OPS)[number])) return finish({ error: "the plugin sandbox sent something it shouldn't" });
      const op = host[m.op as (typeof OPS)[number]] as (...a: unknown[]) => Promise<string>;
      const value = await op(...m.args).catch((e) => envelope({ error: hostFailure(e) }));
      if (!settled) worker.postMessage({ id: m.id, value });
    });
    worker.on("error", (e) => finish({ error: `the plugin sandbox stopped: ${hostFailure(e)}` }));
    worker.on("exit", (code) => finish({ error: `the plugin sandbox stopped (exit ${code})` }));
  });
}

/** Run the plugin; its attachments land in run.attached, and any failure throws. */
export async function runCode(run: CodeRun): Promise<void> {
  const job: SandboxJob = {
    code: run.code, item: run.item, event: run.event, settings: run.settings, connections: run.plugin.connections ?? [],
    kinds: ATTACHMENT_KINDS, deadline: run.deadline, memoryBytes: run.memoryBytes ?? DEFAULT_MEMORY_BYTES, dryRun: !!run.dryRun,
    instance: run.instance, trigger: run.trigger,
  };
  const host = hostFor(run);
  if (!(await run.slots.take(run.repoKey, run.deadline))) throw new DeadlineError("the run passed its deadline waiting for a free sandbox");
  let out: { error?: string };
  try {
    out = run.isolation === "inline" ? await runSandbox(job, host) : await inWorker(job, host, run.workerUrl ?? WORKER_URL);
  } finally {
    run.slots.give(run.repoKey);
  }
  if (run.attached.failure) throw new LimitError(run.attached.failure);
  if (out.error !== undefined) throw new Error(out.error);
}
