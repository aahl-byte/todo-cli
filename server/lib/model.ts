// The shared vocabulary: statuses, entities and their synced fields. Mirrors
// todo/status.py and todo/store.py in the CLI.

export const STATUSES = [
  "requested", "todo", "in-triage", "in-progress", "review", "ready-for-qa",
  "in-qa", "ready-to-deploy", "deployed", "blocked", "deferred", "cancelled", "done",
] as const;
export type Status = (typeof STATUSES)[number];

export const COMPLETE = ["done", "deployed"];
export const TERMINAL = [...COMPLETE, "cancelled"];
export const PARKED = ["deferred", "cancelled"];
const CALC_PRECEDENCE = [
  "in-progress", "blocked", "in-qa", "ready-for-qa", "review", "ready-to-deploy",
  "in-triage", "requested", "todo",
];

export const NOTE_KINDS = ["context", "ticket-request", "comment", "qa-rejection", "link", "clarification"];
export const CHECK_KINDS = ["prereq-branch", "db-script", "env-var", "feature-flag", "manual-step", "other"];
export const LINK_TYPES = ["pr", "preview", "qa-handoff", "other"];

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
  check: ["kind", "title", "payload", "timing", "status"],
};
export const JSON_FIELD: Partial<Record<Entity, string>> = { item: "extra", note: "meta" };

/** Fields a `create` stores, beyond uid/item_uid. */
export const CREATE_FIELDS: Record<Entity, string[]> = {
  item: ["id", "title", "type", "status", "priority", "super_phase", "creator", "developer", "qa_assignee", "created"],
  task: ["n", "title", "status", "phase", "position"],
  note: ["n", "kind", "ts", "text"],
  log: ["n", "ts", "text"],
  check: ["n", "kind", "title", "payload", "timing", "status"],
};

export const DEFAULTS: Record<Entity, Record<string, unknown>> = {
  item: { type: "feature", status: "todo", priority: "medium", super_phase: null,
          creator: null, developer: null, qa_assignee: null },
  task: { status: "todo", phase: null, position: 0 },
  note: { kind: "context" },
  log: {},
  check: { kind: "other", payload: null, timing: "pre-deploy", status: "pending" },
};

export function isSettable(entity: Entity, field: string): boolean {
  const json = JSON_FIELD[entity];
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
