// The jira-issue plugin's source; scripts/build-plugin-host.mjs bundles it,
// with the server's ADF converter, into ../jira-issue.js.
import { adfToMarkdown, adfToText, type MediaRef } from "../../../jira/adf";
import { appendTicketBlock, hasTicketBlock, ticketBlock } from "../../../jira/ticket-block";

type Client = { get(path: string, query?: Record<string, unknown>): Promise<any>; locate(path: string): Promise<string | null> };
interface Ctx {
  item: { jira?: string[] | string | null; requests?: string[] };
  jira: Client;
  attach: Record<"link" | "comment" | "doc" | "request", (fields: Record<string, unknown>) => void>;
}

const FIELDS = "summary,description,status,updated,comment,attachment";
const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** The host's cap on one doc. */
const MAX_IMAGE = 1024 * 1024;
/** The host's cap on a comment's text, in UTF-8 bytes. */
const MAX_TEXT = 8 * 1024;
const PAGE = 100;
/** The media id in the media-service URL an attachment's content redirects to. */
const MEDIA_ID = /\/file\/([0-9a-f-]{36})\//i;
/** A comment todo itself posted, never mirrored back. */
const COMMENT_MARK = "(via todo)";

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

function clip(s: string, max: number): string {
  if (utf8Length(s) <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const size = utf8Length(ch);
    if (n + size > max - 3) break;
    out += ch;
    n += size;
  }
  return `${out}…`;
}

/** Jira's `2026-10-01T10:00:00.000+0000` as ISO time, or undefined. */
function isoTime(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const ms = Date.parse(t.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A doc name every system accepts, unique per attachment. */
const docName = (key: string, a: any) =>
  `${key}-${a.id}-${String(a.filename ?? "image")}`.replace(/[<>:"/\\|?*\s\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").slice(0, 180);

async function allComments(jira: Client, key: string, embedded: any): Promise<any[]> {
  if (embedded && (embedded.comments?.length ?? 0) >= (embedded.total ?? 0)) return embedded.comments ?? [];
  const out: any[] = [];
  for (let at = 0; ; at += PAGE) {
    const page = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { startAt: at, maxResults: PAGE, orderBy: "created" });
    out.push(...(page?.comments ?? []));
    if (out.length >= (page?.total ?? 0) || !page?.comments?.length) return out;
  }
}

export async function run({ item, jira, attach }: Ctx) {
  const keys = Array.isArray(item.jira) ? item.jira : item.jira ? [item.jira] : [];
  const requests = item.requests ?? [];
  let request = requests[0] ?? "";
  let blocks = 0;
  for (const key of keys) {
    let issue: any;
    try {
      issue = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: FIELDS });
    } catch (e) {
      // An issue Jira can't show (deleted, moved, no permission) is left out.
      if ((e as { status?: number }).status === 404) continue;
      throw e;
    }
    const f = issue?.fields ?? {};
    const site = String(issue?.self ?? "").split("/rest/")[0];
    const status = f.status?.name ? String(f.status.name) : null;
    if (site) attach.link({ type: "external-ticket", url: `${site}/browse/${key}`, label: status ? `${key} · ${status}` : key, key: `status:${key}` });

    const files: any[] = f.attachment ?? [];
    const images = files.filter((a) => IMAGES.includes(a?.mimeType) && Number(a.size ?? 0) <= MAX_IMAGE);
    for (const a of images) {
      attach.doc({ name: docName(key, a), url: `/rest/api/3/attachment/content/${encodeURIComponent(String(a.id))}?redirect=false`,
                   key: `attachment:${key}:${a.id}`, version: String(a.id) });
    }
    const comments = await allComments(jira, key, f.comment);
    // As links mode: each attachment's media id, from where its content redirects, when anything shows media.
    const mediaIds = new Map<any, string>();
    if (JSON.stringify([f.description, comments.map((c) => c?.body)]).includes('"type":"media')) {
      for (const a of files) {
        try {
          const at = await jira.locate(`/rest/api/3/attachment/content/${encodeURIComponent(String(a.id))}`);
          const id = at?.match(MEDIA_ID)?.[1];
          if (id) mediaIds.set(a, id);
        } catch {
          // matched by its file name instead, as links mode does when Jira won't say
        }
      }
    }
    const media: MediaRef = (attrs) => {
      const a = files.find((x) => attrs.id && mediaIds.get(x) === attrs.id) ?? files.find((x) => attrs.alt && x.filename === attrs.alt);
      if (!a) return null;
      if (images.includes(a)) return { doc: docName(key, a) };
      return site ? { link: `${site}/secure/attachment/${a.id}/${encodeURIComponent(a.filename)}` } : null;
    };

    for (const c of comments) {
      if (!c?.id || adfToText(c.body).includes(COMMENT_MARK)) continue;
      attach.comment({ text: clip(adfToMarkdown(c.body, media), MAX_TEXT), key: `comment:${key}:${c.id}`, at: isoTime(c.created),
                       author: c.author?.accountId, author_name: c.author?.displayName });
    }

    if (!requests.some((t) => hasTicketBlock(t, key)) && !hasTicketBlock(request, key)) {
      request = appendTicketBlock(request, ticketBlock(key, String(f.summary ?? key), adfToMarkdown(f.description, media), site || undefined));
      blocks++;
    }
  }
  if (blocks) attach.request({ text: request, key: "request:jira" });
}
