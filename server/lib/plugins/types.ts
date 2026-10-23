// The plugin host's vocabulary: what a repo's plugins.yaml declares, what a run
// is given, and what it returns. Shared by the server and the CLI's bundle.

export type Attachment =
  | { kind: "link"; key: string; type: string; url: string; label?: string }
  | { kind: "edge"; key: string; needs: string; in?: string; because: string }
  | { kind: "doc"; key: string; name: string; content?: string; url?: string }
  | { kind: "log"; key: string; text: string }
  | { kind: "request"; key: string; text: string };

export type AttachmentKind = Attachment["kind"];
export const ATTACHMENT_KINDS: AttachmentKind[] = ["link", "edge", "doc", "log", "request"];

/** One call a plugin made, or in dry-run would have made. */
export interface Call {
  connection: string;
  method?: string;
  tool?: string;
  path?: string;
  input?: unknown;
}

export interface RunResult {
  attached: Attachment[];
  wouldSend: Call[];
  log: string[];
  skipped?: string;
  error?: string;
}

export type HttpAuth = "bearer" | "basic" | `header:${string}`;

export type ConnectionDef =
  | { http: { url: string; auth?: HttpAuth } }
  | { mcp: { url: string } | { command: string; args?: string[] } };

/** A connection as a host hands it to a run: its endpoint plus this host's secret for it. */
export type ResolvedConnection =
  | { kind: "http"; url: string; auth?: HttpAuth; secret?: string }
  | { kind: "mcp"; url?: string; command?: string; args?: string[]; secret?: string };

export type Trigger =
  | "push" | "pr" | "deployment" | "manual"
  | { status: { from?: string; to?: string } };

export interface SettingDef {
  label: string;
  type: "text" | "long-text" | "choice" | "toggle" | "number" | "list" | "secret";
  default?: unknown;
  optional?: boolean;
  options?: string[];
  options_from?: { tool: string; input?: unknown };
  scope?: "plugin" | "instance";
}

export interface HttpStep { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

export interface StepDef {
  name?: string;
  when?: string;
  connection?: string;
  tool?: string;
  input?: unknown;
  http?: HttpStep;
  value?: string;
}

export type AttachDef = {
  each?: string;
  when?: string;
  key?: string;
} & { [K in AttachmentKind]?: Record<string, unknown> | string };

export interface PluginDef {
  connections?: string[];
  on?: Trigger[];
  every?: string;
  exclusive?: boolean;
  capabilities?: string[];
  settings?: Record<string, SettingDef>;
  per?: "branch" | "jira";
  when?: string;
  steps?: StepDef[];
  attach?: AttachDef[];
  code?: string;
}

export interface InstanceDef {
  id: string;
  name: string;
  enabled?: boolean;
  on?: Trigger[];
  button?: string;
  dry_run?: boolean;
  settings?: Record<string, unknown>;
}

export interface PluginsFile {
  track?: string[];
  connections?: Record<string, ConnectionDef>;
  plugins?: Record<string, PluginDef>;
  instances?: Record<string, InstanceDef[]>;
}

export interface PluginItem {
  id: string;
  uid: string;
  title: string;
  type?: string | null;
  status: string;
  priority?: string | null;
  repo?: string | null;
  repo_owner?: string | null;
  repo_name?: string | null;
  branches: string[];
  jira?: string[] | string | null;
  app?: string | null;
  section?: string | null;
  developer?: string | null;
  qa_assignee?: string | null;
  dir?: string | null;
  links: { type: string; url: string }[];
}

export type PluginEvent =
  | { type: "status"; from: string; to: string }
  | { type: "push"; branch: string }
  | { type: "pr"; branch: string }
  | { type: "deployment"; branch: string }
  | { type: "manual"; instance: string }
  | { type: "refresh" };

export interface Limits {
  /** Total time a run may take, in ms. */
  deadlineMs?: number;
  /** QuickJS heap for a code plugin, in bytes. */
  memoryBytes?: number;
}

export interface RunInput {
  plugin: PluginDef;
  /** The plugin's name, for messages; optional. */
  name?: string;
  code?: string;
  instance: InstanceDef;
  item: PluginItem;
  event: PluginEvent;
  connections: Record<string, ResolvedConnection>;
  dryRun: boolean;
  limits?: Limits;
}

export const DEFAULT_DEADLINE_MS = 60_000;
export const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
