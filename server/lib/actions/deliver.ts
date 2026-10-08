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

export async function deliver(req: Request, f: Fetch = fetch, sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Outcome> {
  if (req.kind === "rest") {
    const { status, text } = await call(f, req.method, req.url, req.headers, req.body);
    return { summary: `${req.method} ${req.url} → ${status}`, detail: { status, body: text.slice(0, SNIPPET) } };
  }
  const { sessions = [] } = await callJson(f, "GET", `${req.base}/api/roster`);
  const live = sessions.find((s: any) => s?.name === req.name && s?.state === "active" && s?.managed);
  if (live) {
    const sent = await sendMessage(f, req.base, live.id, req.prompt, sleep);
    return { summary: `sent to Watchtower session ${req.name} (${sent.delivered ?? "sent"}): ${live.url}`, detail: { session: live.id, url: live.url } };
  }
  const inline = fitsInitialPrompt(req.prompt);
  const started = await callJson(f, "POST", `${req.base}/api/sessions`, {
    dir: req.dir, name: req.name, ...(req.model ? { model: req.model } : {}), ...(inline ? { initialPrompt: req.prompt } : {}),
  });
  if (!inline) {
    const deadline = Date.now() + IDLE_WAIT_MS;
    for (;;) {
      const s = await callJson(f, "GET", `${req.base}/api/sessions/${started.id}`);
      if (s.status === "idle") break;
      if (s.status === "waiting") throw new DeliveryError(`session ${started.id} is waiting on ${s.waitingFor ?? "a person"}: ${started.url}`);
      if (Date.now() > deadline) throw new DeliveryError(`session ${started.id} never went idle: ${started.url}`);
      await sleep(IDLE_POLL_MS);
    }
    await sendMessage(f, req.base, started.id, req.prompt, sleep);
  }
  return { summary: `started Watchtower session ${req.name} in ${req.dir}: ${started.url}`, detail: { session: started.id, url: started.url } };
}
