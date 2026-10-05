// Jira attachments in our file store. Images are copied, keyed by Jira's media
// id so a note can name the file before the copy lands; other files link back
// to Jira, where the viewer's own session opens them.
import type { Db } from "../db";
import { hasObject, MAX_BYTES, putObject } from "../files";
import type { MediaRef } from "./adf";
import type { JiraClient } from "./client";
import { jiraUid } from "./inbound";

const IMAGE_EXT: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const extOf = (name: unknown) => IMAGE_EXT[String(name ?? "").split(".").pop()!.toLowerCase()];
const clean = (s: string) => s.replace(/[^\w-]/g, "").slice(0, 64) || "x";
const mediaIdIn = (location: string | null) => location?.match(/\/file\/([0-9a-f-]{36})\//i)?.[1] ?? null;

/** Where an image with this media id lives; the extension follows its name. */
export function mediaKey(project: string, itemUid: string, mediaId: string, name: unknown, mime?: string | null): string {
  return `${clean(project)}/${clean(itemUid)}/${jiraUid("media", mediaId)}.${extOf(name) ?? MIME_EXT[mime ?? ""] ?? "png"}`;
}

/** Copy the issue's image attachments we don't have yet, and learn every
 * attachment's media id. A failed copy is retried on the next pass. */
export async function mirrorAttachments(db: Db, jira: JiraClient, project: string, itemUid: string, issue: any): Promise<number> {
  let copied = 0;
  for (const a of issue.fields?.attachment ?? []) {
    const id = String(a.id);
    const [row] = await db.query("select * from jira_files where attachment_id = $1", [id]);
    const image = !!MIME_EXT[a.mimeType] && Number(a.size ?? 0) <= MAX_BYTES;
    if (row && (!image || (row.file_key && await hasObject(row.file_key)))) continue;
    try {
      const path = `/rest/api/3/attachment/content/${encodeURIComponent(id)}`;
      const got = image ? await jira.download(path) : { location: await jira.locate(path), bytes: null };
      const mediaId = mediaIdIn(got.location) ?? row?.media_id ?? null;
      const key = image && mediaId ? mediaKey(project, itemUid, mediaId, a.filename, a.mimeType) : null;
      if (key && got.bytes) {
        await putObject(key, got.bytes, a.mimeType ?? EXT_MIME[key.split(".").pop()!]);
        copied++;
      }
      await db.query(
        `insert into jira_files (project, attachment_id, issue_key, media_id, filename, mime, file_key) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (attachment_id) do update set media_id = excluded.media_id, file_key = excluded.file_key`,
        [project, id, issue.key, mediaId, String(a.filename ?? ""), a.mimeType ?? null, key]);
    } catch (e) {
      console.error(`attachment ${issue.key}/${a.filename}: ${(e as Error).message}`);
    }
  }
  return copied;
}

/** How the issue's media render in a note: by media id, then by file name. */
export async function mediaRef(db: Db, project: string, itemUid: string, issueKey: string, jiraBase?: string): Promise<MediaRef> {
  const rows = await db.query("select * from jira_files where issue_key = $1", [issueKey]);
  return (attrs) => {
    const row = rows.find((r) => attrs.id && r.media_id === attrs.id) ?? rows.find((r) => attrs.alt && r.filename === attrs.alt);
    if (row?.file_key) return { image: `/api/files/${row.file_key}` };
    if (row && jiraBase) return { link: `${jiraBase}/secure/attachment/${row.attachment_id}/${encodeURIComponent(row.filename)}` };
    if (attrs.id && extOf(attrs.alt)) return { image: `/api/files/${mediaKey(project, itemUid, String(attrs.id), attrs.alt)}` };
    return null;
  };
}
