// The plugin host's vocabulary: what a repo's plugins.yaml declares, what a run
// is given, and what it returns. Shared by the server and the CLI's bundle.

export type Attachment =
  | { kind: "link"; key: string; type: string; url: string; label?: string }
  | { kind: "edge"; key: string; needs: string; in?: string; because: string }
  | { kind: "doc"; key: string; name: string; content?: string; url?: string; connection?: string; encoding?: "base64" }
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
  /** Headers an http call adds to the connection's own. */
  headers?: Record<string, string>;
  /** A body sent as text rather than as JSON. */
  text?: string;
}

export interface RunResult {
  attached: Attachment[];
  wouldSend: Call[];
  log: string[];
  skipped?: string;
  error?: string;
  /** The host held back every write, though the run wasn't asked to be a dry run. */
  dryRun?: boolean;
  /** The error was a network failure, a 5xx or a 429, and every call the run made only read, so running it again is safe. */
  transient?: boolean;
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
  /** The value is a template itself: left unfilled until a step field that is exactly {{settings.<key>}} takes it as its own. */
  template?: boolean;
}

export interface HttpStep {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Header name → template, or `Name: value` lines. */
  headers?: Record<string, string> | string;
  /** A body sent as text, in place of a JSON body. */
  text?: string;
}

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
  /** The item's request, every version's text, newest first. */
  requests?: string[];
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
  /** The plugin ships with todo, so it may declare capabilities; otherwise it's checked as a repo plugin. */
  shipped?: boolean;
  /** The repo the plugin came from, e.g. owner/name, for its share of code-run slots. */
  repoKey?: string;
  /** The branches the repo's plugins file tracks, as {{track}}. */
  track?: string[];
  /** The repo's plugins file declares this instance, alone or under a stored override, so it gets none of the host's connections. */
  repoInstance?: boolean;
  /** Host connections this host never writes through: a run that uses one is held back as in dry-run. */
  dryRunConnections?: string[];
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
export const MAX_WOULD_SEND_BYTES = 1024 * KB;
export const MAX_LOG_LINES = 200;
export const MAX_LOG_LINE = KB;
export const MAX_ERROR = 2 * KB;
