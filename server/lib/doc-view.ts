// The pure side of docs, shared by the server and the browser: names, how each
// kind of doc renders, and the paths that show one.

export const MAX_NAME_BYTES = 200;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Why `name` isn't a name a doc can have on every system, or null. Mirrors docs.name_error. */
export function docNameError(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "a doc needs a name";
  if (LONE_SURROGATE.test(name)) return "a doc name must be valid UTF-8";
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return `a doc name is at most ${MAX_NAME_BYTES} bytes`;
  if (BAD_CHARS.test(name)) return "a doc name can't hold control characters or any of <>:\"/\\|?*";
  if (name.startsWith(".")) return "a doc name can't start with \".\"";
  if (/[. ]$/.test(name)) return "a doc name can't end with \".\" or a space";
  if (RESERVED.test(name.split(".")[0])) return "that name is reserved on Windows";
  return null;
}

/** What makes two names one doc: NFC, lowercased. Mirrors docs.name_key. */
export const docNameKey = (name: string) => name.normalize("NFC").toLowerCase();

export type DocKind = "markdown" | "html" | "json" | "code" | "text" | "image" | "pdf" | "audio" | "video" | "download";

/** highlight.js languages by extension. */
export const LANGUAGES: Record<string, string> = {
  yaml: "yaml", yml: "yaml", css: "css", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", py: "python", sql: "sql", sh: "bash", bash: "bash", json: "json", toml: "ini", ini: "ini",
  xml: "xml", go: "go", rs: "rust", rb: "ruby", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php",
  swift: "swift", kt: "kotlin", md: "markdown",
};

const KINDS: [DocKind, string[]][] = [
  ["markdown", ["md", "markdown"]],
  ["html", ["html", "htm"]],
  ["json", ["json"]],
  ["text", ["txt", "log", "csv", "tsv"]],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]],
  ["pdf", ["pdf"]],
  ["audio", ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]],
  ["video", ["mp4", "m4v", "webm", "mov", "ogv"]],
];

export function docExtOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** How the doc page shows a doc, from its name. */
export function docKind(name: string): DocKind {
  const ext = docExtOf(name);
  for (const [kind, exts] of KINDS) if (exts.includes(ext)) return kind;
  return LANGUAGES[ext] ? "code" : "download";
}

/** Text larger than this is offered as a download instead of rendered. */
export const RENDER_MAX_BYTES = 2 * 1024 * 1024;

/** The dashboard page of a doc. */
export const docPath = (project: string, itemId: string, name: string) =>
  `/p/${encodeURIComponent(project)}/i/${encodeURIComponent(itemId)}/docs/${encodeURIComponent(name)}`;

/** The doc's bytes for the browser; `download` asks to save rather than show. */
export const docRawPath = (project: string, uid: string, download = false) =>
  `/api/projects/${encodeURIComponent(project)}/docs/${uid}${download ? "?download=1" : ""}`;

export const humanSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
