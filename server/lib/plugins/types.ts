// The plugin host's vocabulary: what a repo's plugin config declares, what a run
// is given, and what it returns. Shared by the server and the CLI's bundle.

export type Attachment =
  | { kind: "link"; key: string; type: string; url: string; label?: string }
  | { kind: "edge"; key: string; needs: string; in?: string; because: string }
  | { kind: "doc"; key: string; name: string; content?: string; url?: string; connection?: string; version?: string; encoding?: "base64";
      /** The item holds this doc from the instance already, at this version or because a fetch failed: keep it as it is. */
      unchanged?: boolean }
  | { kind: "log"; key: string; text: string }
  /** A comment from elsewhere, replaced by key so edits follow; author is its Jira account id, author_name its display name. */
  | { kind: "comment"; key: string; text: string; at?: string; author?: string; author_name?: string }
  | { kind: "request"; key: string; text: string };

export type AttachmentKind = Attachment["kind"];
export const ATTACHMENT_KINDS: AttachmentKind[] = ["link", "edge", "doc", "log", "request", "comment"];
/** Kinds only a plugin shipped with todo may attach: a comment speaks as its author. */
export const SHIPPED_KINDS: AttachmentKind[] = ["comment"];

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
  /** Answer {status, body, method, url} rather than the body alone. */
  full?: boolean;
  /** A GET answered with where it redirects, or null, never following it. */
  locate?: boolean;
}

export interface RunResult {
  attached: Attachment[];
  wouldSend: Call[];
  log: string[];
  skipped?: string;
  error?: string;
  /** The host held back every write, though the run wasn't asked to be a dry run. */
  dryRun?: boolean;
  /** For a run that failed in one of its passes: the error without the pass's label, and the pass ({issue} or {branch}). */
  failure?: { message: string; pass: Record<string, string> };
  /** The error was a network failure, a 5xx or a 429, and every call the run made only read, so running it again is safe. */
  transient?: boolean;
}

export type HttpAuth = "bearer" | "basic" | `header:${string}`;

export type ConnectionDef =
  | { http: { url: string; auth?: HttpAuth } }
  | { mcp: { url: string } | { command: string; args?: string[] } };

/** Where a connection was declared: the repo's plugin config, or the host itself. */
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
  /** The step's result is {status, body, method, url}, not the body alone. */
  full?: boolean;
}

export interface StepDef {
  name?: string;
  when?: string;
  connection?: string;
  tool?: string;
  input?: unknown;
  http?: HttpStep;
  value?: string;
  /** Stop the run with this message, which a host may retry like a failed send. */
  fail?: string;
}

export type AttachDef = {
  each?: string;
  when?: string;
  key?: string;
} & { [K in AttachmentKind]?: Record<string, unknown> | string };

export interface PluginDef {
  /** What the plugin does, in one line, for the dashboard. */
  description?: string;
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
  /** The dev-log line a host writes when it stops retrying a run: a template over instance, trigger, attempts, error and the pass. */
  gave_up?: string;
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

/** A repo's plugin config as the host reads it. */
export interface PluginConfig {
  /** The config as one YAML map: track, connections and plugins, each shipped plugin switched on as `{use: shipped}`. */
  text: string;
  /** Each code plugin's module, by plugin name. */
  code?: Record<string, string>;
}

/** A repo's plugin config as one map: its deploy branches, its connections, and its plugins (a shipped one as {use: shipped}). */
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
  /** Docs plugin instances wrote and no one has edited since: name, <plugin>/<instance>, and the version it gave. */
  docs?: { name: string; plugin: string; version?: string | null }[];
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
  /** Let an MCP connection the repo's config declares start a local command. */
  allowRepoCommands?: boolean;
  /** The plugin ships with todo, so it may declare capabilities and use the host's connections; otherwise it's a custom plugin. */
  shipped?: boolean;
  /** The repo the plugin runs for, e.g. owner/name, for its share of code-run slots. */
  repoKey?: string;
  /** The repo's deploy branches, as {{track}}. */
  track?: string[];
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
