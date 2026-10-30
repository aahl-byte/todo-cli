// The shared vocabulary: statuses, entities and their synced fields. Mirrors
// todo/status.py and todo/store.py in the CLI.

export const STATUSES = [
  "requested", "todo", "in-triage", "in-progress", "review", "ready-for-qa",
  "in-qa", "qa-approved", "qa-rejected", "ready-to-deploy", "deployed", "blocked", "deferred", "cancelled", "done",
] as const;
export type Status = (typeof STATUSES)[number];

export const COMPLETE = ["done", "deployed"];
export const TERMINAL = [...COMPLETE, "cancelled"];
export const PARKED = ["deferred", "cancelled"];
const CALC_PRECEDENCE = [
  "qa-rejected", "in-progress", "blocked", "in-qa", "ready-for-qa", "review", "qa-approved", "ready-to-deploy",
  "in-triage", "requested", "todo",
];

/** Statuses that mean triage is done: work runs on the request from here on. */
export const PAST_TRIAGE = ["todo", "in-progress", "review", "ready-for-qa", "in-qa", "qa-approved", "qa-rejected", "ready-to-deploy", "deployed", "done"];

/** Deploy environments in lifecycle order, with their one-letter labels. A
 * check is ticked per environment and is done once production is ticked.
 * Mirrors store.ENVIRONMENTS. */
export const ENVIRONMENTS: Record<string, string> = { dev: "D", staging: "S", production: "P" };
export const DONE_ENV = "production";

export function envList(raw: unknown): string[] {
  const names = new Set((typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : []).map((n) => String(n).trim()));
  return Object.keys(ENVIRONMENTS).filter((e) => names.has(e));
}

/** The environments a check is ticked for; a done check with none recorded predates them and counts everywhere. */
export function ticked(check: { envs?: unknown; status?: string }): string[] {
  const envs = envList(check.envs);
  return !envs.length && check.status === "done" ? Object.keys(ENVIRONMENTS) : envs;
}

export const NOTE_KINDS = ["context", "ticket-request", "comment", "qa-rejection", "link", "clarification", "relation", "dependency"];
export const CHECK_KINDS = ["prereq-branch", "db-script", "env-var", "feature-flag", "manual-step", "other"];
export const ITEM_TYPES = ["feature", "bug", "refactor", "question", "debt", "idea", "suggestion", "performance", "decoration", "spin-off"];
export const LINK_TYPES = ["pr", "preview", "qa-handoff", "external-ticket", "bug-ticket", "documentation", "design", "wt-file", "other"];

export type Entity = "item" | "task" | "note" | "log" | "check";
export const ENTITIES: Entity[] = ["item", "task", "note", "log", "check"];

export const TABLE: Record<Entity | "history", string> = {
  item: "items", task: "tasks", note: "notes", log: "logs", check: "checks", history: "status_history",
};

/** Fields a `set` may write. Dotted fields live inside a jsonb column. */
export const SETTABLE: Record<Entity, string[]> = {
  item: ["title", "type", "status", "priority", "super_phase", "creator", "developer", "qa_assignee"],
  task: ["title", "status", "phase", "position"],
  note: ["kind", "text"],
  log: ["text"],
  check: ["kind", "title", "payload", "timing", "status", "envs"],
};
export const JSON_FIELD: Partial<Record<Entity, string>> = { item: "extra", note: "meta", log: "meta" };

/** The meta key listing who has seen a note's or log entry's latest content. */
export const SEEN = "seen_by";

/** Who acknowledges an entry: a person's handle, or `handle/agent` for their agent. */
export function party(handle: string, via: string | null | undefined): string {
  return via === "agent" ? `${handle}/agent` : handle;
}

export const isAgentParty = (p: string) => p.endsWith("/agent");

/** Fields a `create` stores, beyond uid/item_uid. */
export const CREATE_FIELDS: Record<Entity, string[]> = {
  item: ["id", "title", "type", "status", "priority", "super_phase", "creator", "developer", "qa_assignee", "created"],
  task: ["n", "title", "status", "phase", "position"],
  note: ["n", "kind", "ts", "text"],
  log: ["n", "ts", "text"],
  check: ["n", "kind", "title", "payload", "timing", "status", "envs"],
};

export const DEFAULTS: Record<Entity, Record<string, unknown>> = {
  item: { type: "feature", status: "todo", priority: "medium", super_phase: null,
          creator: null, developer: null, qa_assignee: null },
  task: { status: "todo", phase: null, position: 0 },
  note: { kind: "context" },
  log: {},
  check: { kind: "other", payload: null, timing: "pre-deploy", status: "pending", envs: null },
};

export function isSettable(entity: Entity, field: string): boolean {
  const json = JSON_FIELD[entity];
  if (entity === "log") return field === "text" || field === `meta.${SEEN}`;
  if (json && field.startsWith(json + ".") && field.length > json.length + 1) return true;
  return SETTABLE[entity].includes(field);
}

export function deriveCalcStatus(statuses: string[]): string | null {
  if (!statuses.length) return null;
  const live = statuses.filter((s) => !PARKED.includes(s));
  if (!live.length) return statuses.every((s) => s === "cancelled") ? "cancelled" : "deferred";
  if (live.every((s) => s === "deployed")) return "deployed";
  if (live.every((s) => COMPLETE.includes(s))) return "done";
  for (const s of CALC_PRECEDENCE) if (live.includes(s)) return s;
  return "todo";
}

/** An item's branches from its extra; a legacy single `branch` reads as a one-branch list. */
export function itemBranches(extra: Record<string, any> | null | undefined): string[] {
  const raw = extra?.branches ?? extra?.branch;
  const names = (Array.isArray(raw) ? raw : [raw]).filter((b): b is string => typeof b === "string").map((b) => b.trim());
  return [...new Set(names.filter(Boolean))];
}

export const TAG_MAX = 40;

/** Why a tag can't be stored, or null. */
export function tagProblem(tag: string): string | null {
  if (!tag) return "a tag can't be empty";
  if (tag.includes(",")) return `a tag can't hold a comma: ${tag}`;
  if (tag.length > TAG_MAX) return `a tag is at most ${TAG_MAX} characters: ${tag}`;
  return null;
}

/** The item's tags, trimmed, in order, as first typed, without unusable ones or duplicates that differ only in case. */
export function tagList(raw: unknown): string[] {
  const out: string[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const tag = typeof t === "string" ? t.trim() : "";
    if (!tagProblem(tag) && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** Tags as one history value, `a, b`; null for none. */
export const tagText = (raw: unknown): string | null => tagList(raw).join(", ") || null;

export function nowIso(): string {
  return new Date().toISOString();
}

export function mentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w@])@([A-Za-z0-9][\w.\-]*)/g)) {
    const h = m[1].replace(/\.+$/, "");
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** The dashboard's allowed status moves, in menu order. The CLI keeps free
 * transitions: offline sync collapses several moves into one write. */
export const NEXT_STATUSES: Record<string, string[]> = {
  requested: ["in-triage", "deferred", "cancelled"],
  "in-triage": ["todo", "requested", "blocked", "deferred", "cancelled"],
  todo: ["in-progress", "in-triage", "requested", "blocked", "deferred", "cancelled"],
  "in-progress": ["review", "todo", "blocked", "deferred", "cancelled"],
  review: ["ready-for-qa", "done", "in-progress", "qa-rejected", "blocked", "deferred", "cancelled"],
  "ready-for-qa": ["in-qa", "in-progress", "blocked", "cancelled"],
  "in-qa": ["qa-approved", "ready-for-qa", "qa-rejected", "blocked", "cancelled"],
  "qa-approved": ["ready-to-deploy", "in-qa", "qa-rejected", "blocked", "cancelled"],
  "qa-rejected": ["in-progress", "in-triage", "blocked", "cancelled"],
  "ready-to-deploy": ["deployed", "qa-approved", "in-qa", "qa-rejected", "blocked", "cancelled"],
  deployed: ["in-progress"],
  done: ["in-progress", "todo"],
  blocked: ["in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "qa-approved", "qa-rejected", "ready-to-deploy", "deferred", "cancelled"],
  deferred: ["requested", "in-triage", "todo", "cancelled"],
  cancelled: ["requested", "in-triage"],
};

const LIFECYCLE = ["requested", "in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa",
  "qa-approved", "ready-to-deploy", "deployed", "done"];
const PARKING = ["blocked", "deferred", "cancelled"];
/** Between QA approval and a deploy; a project with no deploy step finishes at approval instead. */
const DEPLOY_PREP = ["qa-approved", "ready-to-deploy"];

export interface Move {
  status: string;
  group: "next" | "forward" | "back" | "park";
  /** A comment the move asks for: required, optional, or none. */
  comment: "required" | "optional" | null;
  /** The comment is posted as a qa-rejection note. */
  rejection?: boolean;
}

export interface MoveContext {
  deployStep?: boolean;
  hasQa?: boolean;
  /** For `blocked`: the status it was blocked from. */
  previous?: string | null;
}

function rank(s: string): number {
  // A rejected ticket waits to be worked again: it sits where `todo` does.
  const i = LIFECYCLE.indexOf(s === "qa-rejected" ? "todo" : s);
  return i < 0 ? -1 : s === "done" ? LIFECYCLE.indexOf("deployed") : i;
}

/** The moves the dashboard offers from `from`, ordered: the natural next step,
 * other forward moves, backward moves, then blocked/deferred/cancelled. */
export function moves(from: string, ctx: MoveContext = {}): Move[] {
  const deployStep = ctx.deployStep !== false;
  let next = [...(NEXT_STATUSES[from] ?? STATUSES.filter((s) => s !== from))];
  if (!deployStep) {
    next = next.map((s) => (DEPLOY_PREP.includes(s) ? "done" : s)).filter((s) => s !== "deployed");
    if (from === "in-qa") next = next.filter((s, i) => next.indexOf(s) === i);
  }
  if (from === "review" && ctx.hasQa) next = next.filter((s) => s !== "done");
  if (from === "blocked" && ctx.previous && ctx.previous !== "blocked") {
    const prev = !deployStep && DEPLOY_PREP.includes(ctx.previous) ? "done" : ctx.previous;
    next = [prev, ...next.filter((s) => s !== prev)];
  }
  next = [...new Set(next)];
  const out: Move[] = [];
  next.forEach((status, i) => {
    let group: Move["group"];
    if (PARKING.includes(status)) group = "park";
    else if (from === "blocked") group = i === 0 && ctx.previous ? "next" : "forward";
    else if (rank(status) > rank(from)) group = out.some((m) => m.group === "next") ? "forward" : "next";
    else group = "back";
    out.push({ status, group, ...commentRule(from, status) });
  });
  const order = { next: 0, forward: 1, back: 2, park: 3 };
  return out.sort((a, b) => order[a.group] - order[b.group]);
}

/** Moves that post their required reason as a comment tagged with the status. */
export const REASONED = ["blocked", "cancelled"];

export function commentRule(from: string, to: string): Pick<Move, "comment" | "rejection"> {
  if (to === "qa-rejected") return { comment: "required", rejection: true };
  if (to === "in-progress" && (from === "deployed" || from === "done")) return { comment: "required" };
  if (to === "in-progress" && from === "review") return { comment: "optional" };
  if (to === "blocked" || to === "cancelled") return { comment: "required" };
  return { comment: null };
}

/** Whether the dashboard allows `from` → `to`. */
export function allowedMove(from: string, to: string, ctx: MoveContext = {}): boolean {
  return moves(from, ctx).some((m) => m.status === to);
}
