// Docs a plugin attaches by url: the host fetches each through one of the
// plugin's http connections, with its credentials, guard and caps, so a doc's
// content arrives with the result and the url can't reach another host.
import { addLog } from "./limits";
import type { Attached } from "./limits";
import { CallError, type Calls } from "./connections";
import { pathLeaves } from "./template";
import { MAX_DOC_CONTENT, type Attachment, type PluginDef, type PluginItem, type ResolvedConnection, type RunResult } from "./types";

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
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes("\0")) return { content: text };
  } catch {
    // not text
  }
  return { content: bytes.toString("base64"), encoding: "base64" };
}

/**
 * Fill in the content of every doc attached by url alone. One the item holds from this instance at the same version isn't
 * fetched, nor is one whose fetch fails while the item holds it: both come back unchanged, for the runner to keep. A doc
 * that can't be fetched safely, or whose fetch fails, is dropped with a log line; the rest of the run stands.
 */
export async function fetchDocs(plugin: PluginDef, instance: string, item: PluginItem, connections: Record<string, ResolvedConnection>,
                                calls: Calls, attached: Attached, result: RunResult): Promise<void> {
  const held = (doc: Doc) => (item.docs ?? []).find((d) => d.plugin === instance && d.name === doc.name);
  for (let i = 0; i < attached.list.length; i++) {
    const doc = attached.list[i];
    if (doc.kind !== "doc" || doc.content !== undefined || !doc.url) continue;
    const { connection: _via, ...rest } = doc;
    const drop = (why: string) => {
      addLog(result, `skipped doc ${doc.name}: ${why}`);
      attached.list.splice(i--, 1);
    };
    const have = held(doc);
    if (have && doc.version !== undefined && have.version === doc.version) {
      attached.list[i] = { ...rest, unchanged: true };
      continue;
    }
    const where = route(doc, plugin, connections);
    if (typeof where === "string") {
      drop(where);
      continue;
    }
    if (pathLeaves(where.path)) {
      drop(`${where.path} would change the path`);
      continue;
    }
    let got;
    try {
      got = await calls.fetchBytes(where.connection, where.path, MAX_DOC_CONTENT);
    } catch (e) {
      if (!(e instanceof CallError)) throw e;
      if (!have) {
        drop(e.message);
        continue;
      }
      addLog(result, `kept doc ${doc.name} as it was: ${e.message}`);
      attached.list[i] = { ...rest, unchanged: true };
      continue;
    }
    if (!got) {
      drop(`it's larger than ${MAX_DOC_CONTENT / 1024 / 1024} MB`);
      continue;
    }
    const encoded = encode(got.bytes);
    if (!attached.grow(Buffer.byteLength(encoded.content, "utf8"))) {
      drop(`the run's attachments would pass their size cap`);
      continue;
    }
    attached.list[i] = { ...rest, ...encoded };
  }
}
