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

/** Where a connection was declared: the repo's plugins.yaml, or the host itself. */
export type ConnectionOrigin = "repo" | "host";

/** A connection as a host hands it to a run: its endpoint plus this host's secret for it. Without an origin it counts as the repo's. */
export type ResolvedConnection =
  | { kind: "http"; url: string; auth?: HttpAuth; secret?: string; origin?: ConnectionOrigin }
  | { kind: "mcp"; url?: string; command?: string; args?: string[]; secret?: string; origin?: ConnectionOrigin };

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
  /** Where to get the plugin instead of a body here, e.g. shipped; resolved before a run. */
  use?: string;
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
  /** Capabilities a person granted this plugin, e.g. post-request. */
  grants?: string[];
  /** Let a repo-declared MCP connection start a local command. */
  allowRepoCommands?: boolean;
}

export const POST_REQUEST = "post-request";
export const DEFAULT_DEADLINE_MS = 5 * 60_000;
export const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;

const KB = 1024;
export const MAX_ATTACHMENTS = 200;
export const MAX_FIELD = 8 * KB;
export const MAX_DOC_CONTENT = 1024 * KB;
export const MAX_ATTACHED_BYTES = 4 * 1024 * KB;
export const MAX_WOULD_SEND = 100;
export const MAX_WOULD_SEND_INPUT = 2 * KB;
export const MAX_LOG_LINES = 200;
export const MAX_LOG_LINE = KB;
export const MAX_ERROR = 2 * KB;
