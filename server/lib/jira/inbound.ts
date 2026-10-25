// Jira comments as todo notes, applied as the mapped Jira user, unconditionally,
// and flagged so they are never echoed back. Uids and op ids derive from Jira's
// own ids, so a repeated pass is a no-op.
import crypto from "node:crypto";
import type { Db } from "../db";
import { applyOps, type Actor, type Op } from "../apply";
import { adfToMarkdown, adfToText } from "./adf";
import { mediaRef } from "./media";
import { COMMENT_MARK, jiraConfig } from "./config";

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface InboundResult {
  handled: boolean;
  reason?: string;
  results?: unknown[];
}

/** A stable 26-char uid for a Jira-originated entity. */
export function jiraUid(...parts: string[]): string {
  return "J" + crypto.createHash("sha1").update(parts.join("\u001f")).digest("hex").slice(0, 25).toUpperCase();
}

export async function handleFor(db: Db, p: Person): Promise<string | null> {
  if (!p) return null;
  if (p.accountId) {
    const [u] = await db.query("select handle from users where jira_account_id = $1", [p.accountId]);
    if (u) return u.handle;
  }
  return p.displayName ? `jira:${p.displayName}` : null;
}

async function bridgeActor(db: Db, p: Person): Promise<Actor> {
  return { handle: (await handleFor(db, p)) ?? "jira-bridge", unconditional: true, bridge: true };
}

/** Mirror a Jira comment as a comment note on `link`'s item. `scope` goes into
 * the note's uid and op ids, so one issue can feed several items. */
export async function commented(db: Db, link: { project: string; item_uid: string }, comment: any,
                                issueKey: string, scope: string): Promise<InboundResult> {
  if (!comment?.id) return { handled: false, reason: "no comment" };
  if (adfToText(comment.body).includes(COMMENT_MARK)) return { handled: false, reason: "own comment" };
  const ours = await db.query("select 1 from jira_outbox where result->>'comment_id' = $1", [String(comment.id)]);
  if (ours.length) return { handled: false, reason: "own comment" };
  // Linked issues keep their files per issue, not per item.
  const text = adfToMarkdown(comment.body, await mediaRef(db, link.project, jiraUid("item", issueKey), issueKey, jiraConfig()?.baseUrl));
  const uid = jiraUid("comment", scope, String(comment.id));
  const opId = `jira:comment:${scope}:${comment.id}`;
  const updated = comment.updated ? new Date(comment.updated).toISOString() : null;
  const [note] = await db.query("select meta, text from notes where project = $1 and uid = $2", [link.project, uid]);
  const actor = await bridgeActor(db, comment.updateAuthor ?? comment.author);
  if (note) {
    // An edit in Jira: newer than the copy we hold, and actually different.
    const held = note.meta?.jira_updated ?? null;
    if (!updated || (held && Date.parse(held) >= Date.parse(updated))) return { handled: false, reason: "comment unchanged" };
    const op: Op = { op_id: `${opId}:${updated}`, op: "set", entity: "note", uid, item_uid: link.item_uid,
                     data: { ...(note.text !== text ? { text, "meta.edited_at": updated } : {}), "meta.jira_updated": updated } };
    return { handled: true, results: await applyOps(db, link.project, [op], actor) };
  }
  const op: Op = { op_id: opId, op: "create", entity: "note", uid, item_uid: link.item_uid,
                   data: { kind: "comment", text, source: "jira",
                           meta: { jira_comment_id: String(comment.id), ...(updated ? { jira_updated: updated } : {}),
                                   ...(updated && comment.created && Date.parse(updated) - Date.parse(comment.created) > 60_000 ? { edited_at: updated } : {}) },
                           ...(comment.created ? { ts: new Date(comment.created).toISOString() } : {}) } };
  return { handled: true, results: await applyOps(db, link.project, [op], await bridgeActor(db, comment.author)) };
}
