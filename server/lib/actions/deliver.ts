// Send one rendered Action. Mirrors todo/actions.py in the CLI.
import { INITIAL_PROMPT_MAX, type Request } from "./model";

export type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;
const IDLE_WAIT_MS = 90_000;
const IDLE_POLL_MS = 2_000;
const SNIPPET = 300;
/** Waits between sends while Watchtower can't see the session's input box yet. */
const INPUT_RETRY_MS = [1_000, 2_000, 3_000, 3_000, 3_000, 3_000];

/** What a run reports back: a line for the dev log, and details kept on the row. */
export interface Outcome { summary: string; detail: Record<string, unknown> }

export class DeliveryError extends Error {}

async function call(f: Fetch, method: string, url: string, headers: Record<string, string>, body: string | null) {
  let res: Response;
  try {
    res = await f(url, { method, headers, body: body ?? undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new DeliveryError(`${method} ${url} failed: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new DeliveryError(`${method} ${url} answered ${res.status}${text ? `: ${text.slice(0, SNIPPET)}` : ""}`);
  return { status: res.status, text };
}

async function callJson(f: Fetch, method: string, url: string, body?: unknown) {
  const { text } = await call(f, method, url, body === undefined ? {} : { "content-type": "application/json" },
    body === undefined ? null : JSON.stringify(body));
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DeliveryError(`${method} ${url} didn't answer with JSON`);
  }
}

type Sleep = (ms: number) => Promise<unknown>;

/** Watchtower refuses (and sends nothing) until the input box is on screen. */
async function sendMessage(f: Fetch, base: string, id: string, text: string, sleep: Sleep) {
  for (const wait of [...INPUT_RETRY_MS, null]) {
    try {
      return await callJson(f, "POST", `${base}/api/sessions/${id}/message`, { text, from: "todo" });
    } catch (e) {
      if (wait === null || !(e instanceof DeliveryError) || !e.message.includes("input isn't visible")) throw e;
      await sleep(wait);
    }
  }
}

const fitsInitialPrompt = (p: string) => p.length <= INITIAL_PROMPT_MAX && !/[\u0000-\u001f]/.test(p);

/** Wait until a session that is starting or resuming is live and idle. */
async function waitIdle(f: Fetch, base: string, id: string, url: string, sleep: Sleep) {
  const deadline = Date.now() + IDLE_WAIT_MS;
  for (;;) {
    const s = await callJson(f, "GET", `${base}/api/sessions/${id}`);
    if (s.state !== "stopped" && s.status === "idle") return;
    if (s.status === "waiting") throw new DeliveryError(`session ${id} is waiting on ${s.waitingFor ?? "a person"}: ${url}`);
    if (Date.now() > deadline) throw new DeliveryError(`session ${id} never went idle: ${url}`);
    await sleep(IDLE_POLL_MS);
  }
}

/** Resume the newest stopped session of this name and send it the resume prompt; null when there's none or it won't come back. */
async function resumeStopped(f: Fetch, req: Extract<Request, { kind: "watchtower" }>, sessions: any[], sleep: Sleep): Promise<Outcome | null> {
  const prev = sessions.filter((s) => s?.name === req.name && s?.state === "stopped")
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  if (!prev) return null;
  try {
    await callJson(f, "POST", `${req.base}/api/sessions/${prev.id}/resume`);
    await waitIdle(f, req.base, prev.id, prev.url, sleep);
  } catch (e) {
    if (e instanceof DeliveryError && /waiting on/.test(e.message)) throw e;
    return null;
  }
  const sent = await sendMessage(f, req.base, prev.id, req.resumePrompt!, sleep);
  return { summary: `resumed Watchtower session ${req.name} (${sent.delivered ?? "sent"}): ${prev.url}`, detail: { session: prev.id, url: prev.url } };
}

export async function deliver(req: Request, f: Fetch = fetch, sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Outcome> {
  if (req.kind === "rest") {
    const { status, text } = await call(f, req.method, req.url, req.headers, req.body);
    return { summary: `${req.method} ${req.url} → ${status}`, detail: { status, body: text.slice(0, SNIPPET) } };
  }
  const { sessions = [] } = await callJson(f, "GET", `${req.base}/api/roster`);
  const live = sessions.find((s: any) => s?.name === req.name && s?.state === "active" && s?.managed);
  if (live) {
    const sent = await sendMessage(f, req.base, live.id, req.resumePrompt ?? req.prompt, sleep);
    return { summary: `sent to Watchtower session ${req.name} (${sent.delivered ?? "sent"}): ${live.url}`, detail: { session: live.id, url: live.url } };
  }
  if (req.resumePrompt !== undefined) {
    const resumed = await resumeStopped(f, req, sessions, sleep);
    if (resumed) return resumed;
  }
  const inline = fitsInitialPrompt(req.prompt);
  const started = await callJson(f, "POST", `${req.base}/api/sessions`, {
    dir: req.dir, name: req.name, ...(req.model ? { model: req.model } : {}), ...(inline ? { initialPrompt: req.prompt } : {}),
  });
  if (!inline) {
    await waitIdle(f, req.base, started.id, started.url, sleep);
    await sendMessage(f, req.base, started.id, req.prompt, sleep);
  }
  return { summary: `started Watchtower session ${req.name} in ${req.dir}: ${started.url}`, detail: { session: started.id, url: started.url } };
}
