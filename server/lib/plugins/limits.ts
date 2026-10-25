// Bounds on what one run hands back, and scrubbing secrets out of it.
import {
  MAX_ATTACHED_BYTES, MAX_ATTACHMENTS, MAX_ERROR, MAX_LOG_LINE, MAX_LOG_LINES, MAX_WOULD_SEND, MAX_WOULD_SEND_BYTES, MAX_WOULD_SEND_INPUT,
  type Attachment, type Call, type RunResult,
} from "./types";

/** Going over a limit on attachments: it fails the run, unlike a malformed attachment. */
export class LimitError extends Error {}

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function addLog(result: RunResult, line: string): void {
  if (result.log.length < MAX_LOG_LINES) result.log.push(clip(line, MAX_LOG_LINE));
}

const recorded = new WeakMap<RunResult, number>();

/** Record a call dry-run held back, its path and input clipped; past the caps only the log says so. */
export function recordWouldSend(result: RunResult, call: Call): void {
  if (result.wouldSend.length >= MAX_WOULD_SEND) return;
  const kept = { ...call };
  if (call.path !== undefined) kept.path = clip(call.path, MAX_WOULD_SEND_INPUT);
  if (call.input !== undefined) {
    const text = JSON.stringify(call.input) ?? "null";
    if (text.length > MAX_WOULD_SEND_INPUT) kept.input = clip(text, MAX_WOULD_SEND_INPUT);
  }
  const size = (recorded.get(result) ?? 2) + JSON.stringify(kept).length + 1;
  if (size > MAX_WOULD_SEND_BYTES) return;
  recorded.set(result, size);
  result.wouldSend.push(kept);
}

/** A run's attachments: the first per key, up to the count and size caps. */
export class Attached {
  readonly list: Attachment[] = [];
  private keys = new Set<string>();
  private size = 0;
  /** Set once a cap is passed, so a plugin that catches the error still fails. */
  failure?: string;

  add(a: Attachment, result: RunResult): void {
    if (this.failure) throw new LimitError(this.failure);
    if (this.keys.has(a.key)) {
      addLog(result, `dropped a second ${a.kind} with key ${a.key}`);
      return;
    }
    const size = Object.values(a).reduce((n: number, v) => n + (typeof v === "string" ? bytes(v) : 0), 0);
    if (this.list.length >= MAX_ATTACHMENTS) this.failure = `the run attached more than ${MAX_ATTACHMENTS} items`;
    else if (this.size + size > MAX_ATTACHED_BYTES) this.failure = `the run's attachments add up to more than ${MAX_ATTACHED_BYTES / 1024 / 1024} MB`;
    if (this.failure) throw new LimitError(this.failure);
    this.keys.add(a.key);
    this.size += size;
    this.list.push(a);
  }
}

const MASK = "***";

/** Every way a secret can show up in text we produced: as is, and URL-encoded. */
function forms(secrets: string[]): string[] {
  const all = secrets.filter((s) => s.length > 0).flatMap((s) => [s, encodeURIComponent(s)]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

function scrub(text: string, masks: string[]): string {
  return masks.reduce((t, m) => t.split(m).join(MASK), text);
}

function scrubDeep(v: unknown, masks: string[]): unknown {
  if (typeof v === "string") return scrub(v, masks);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, masks));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, masks)]));
  return v;
}

/** The result as it leaves the host: secrets masked, the error capped. */
export function finish(result: RunResult, secrets: string[]): RunResult {
  const masks = forms(secrets);
  const out: RunResult = {
    ...result,
    attached: masks.length ? result.attached.map((a) => scrubDeep(a, masks) as Attachment) : result.attached,
    log: result.log.map((l) => scrub(l, masks)),
    wouldSend: result.wouldSend.map((c) => scrubDeep(c, masks) as Call),
  };
  if (result.error !== undefined) out.error = clip(scrub(clip(result.error, 4 * MAX_ERROR), masks), MAX_ERROR);
  if (result.skipped !== undefined) out.skipped = scrub(result.skipped, masks);
  return out;
}
