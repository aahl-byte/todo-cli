// Docs a plugin attaches by url: the host fetches each through one of the
// plugin's http connections, with its credentials, guard and caps, so a doc's
// content arrives with the result and the url can't reach another host.
import { addLog } from "./limits";
import type { Attached } from "./limits";
import type { Calls } from "./connections";
import { pathLeaves } from "./template";
import { MAX_DOC_CONTENT, type Attachment, type PluginDef, type ResolvedConnection, type RunResult } from "./types";

type Doc = Extract<Attachment, { kind: "doc" }>;

const strip = (url: string) => url.replace(/\/+$/, "");

/** The connection and path a doc's url is fetched through, or why it isn't. */
function route(doc: Doc, plugin: PluginDef, connections: Record<string, ResolvedConnection>): { connection: string; path: string } | string {
  const names = (plugin.connections ?? []).filter((n) => connections[n]?.kind === "http");
  const url = doc.url!;
  if (doc.connection !== undefined && !names.includes(doc.connection)) return `${doc.connection} isn't an http connection of the plugin`;
  const candidates = doc.connection !== undefined ? [doc.connection] : names;
  if (url.startsWith("/")) {
    return candidates.length ? { connection: candidates[0], path: url } : "the plugin has no http connection to fetch it through";
  }
  for (const name of candidates) {
    const base = strip((connections[name] as { url: string }).url);
    if (url.startsWith(`${base}/`)) return { connection: name, path: url.slice(base.length) };
  }
  return `${url} isn't under a connection of the plugin`;
}

/** Text when the bytes are UTF-8 without NULs, else base64. */
function encode(bytes: Buffer): { content: string; encoding?: "base64" } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return { content: text };
  } catch {
    // not text
  }
  return { content: bytes.toString("base64"), encoding: "base64" };
}

/** Fill in the content of every doc attached by url alone; one that can't be fetched safely is dropped with a log line. */
export async function fetchDocs(plugin: PluginDef, connections: Record<string, ResolvedConnection>, calls: Calls, attached: Attached,
                                result: RunResult): Promise<void> {
  for (let i = 0; i < attached.list.length; i++) {
    const doc = attached.list[i];
    if (doc.kind !== "doc" || doc.content !== undefined || !doc.url) continue;
    const drop = (why: string) => {
      addLog(result, `skipped doc ${doc.name}: ${why}`);
      attached.list.splice(i--, 1);
    };
    const where = route(doc, plugin, connections);
    if (typeof where === "string") {
      drop(where);
      continue;
    }
    if (pathLeaves(where.path)) {
      drop(`${where.path} would change the path`);
      continue;
    }
    const got = await calls.fetchBytes(where.connection, where.path, MAX_DOC_CONTENT);
    if (!got) {
      drop(`it's larger than ${MAX_DOC_CONTENT / 1024 / 1024} MB`);
      continue;
    }
    if (!attached.grow(got.bytes.length)) {
      drop(`the run's attachments would pass their size cap`);
      continue;
    }
    const { connection: _via, ...rest } = doc;
    attached.list[i] = { ...rest, ...encode(got.bytes) };
  }
}
