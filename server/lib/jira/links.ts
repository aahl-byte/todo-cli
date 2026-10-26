// The poller's pass over issues that items link through their `jira` field.
// A newly linked issue is appended once to its item's request, as a block of
// its own; every linked issue's comments mirror onto each item linking it. The
// item's status never follows Jira here.
import type { Db } from "../db";
import { applyOps, type Actor, type Op } from "../apply";
import { ulid } from "../ulid";
import { adfToMarkdown } from "./adf";
import type { JiraClient } from "./client";
import { jiraConfig } from "./config";
import { commented, jiraUid } from "./inbound";
import { mediaRef, mirrorAttachments } from "./media";
import { appendTicketBlock, hasTicketBlock, ticketBlock } from "./ticket-block";

export { appendTicketBlock, hasTicketBlock, ticketBlock };

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface LinkedResult { backfilled: number; comments: number; files: number }

const BRIDGE: Actor = { handle: "jira-bridge", unconditional: true, bridge: true };
const CHUNK = 50;

/** The issues for `keys`, fetched by `key in (…)`. Keys Jira can't show (deleted,
 * moved, no permission) are skipped. */
export async function linkedIssues(jira: JiraClient, keys: string[], fields: string[],
                                   search: (jql: string) => Promise<any[]>): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      out.push(...await search(`key in (${chunk.join(",")})`));
    } catch {
      // One unknown key fails the whole search; fetch the chunk one by one.
      for (const key of chunk) {
        try {
          out.push(await jira.call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`));
        } catch (e) {
          console.error(`jira ${key}: ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

export async function syncLinked(db: Db, jira: JiraClient, project: string, opts: {
  since: Date | null;
  fields: string[];
  search: (jql: string) => Promise<any[]>;
  comments: (issue: any) => Promise<any[]>;
  meet: (p: Person) => Promise<void>;
}): Promise<LinkedResult> {
  const out: LinkedResult = { backfilled: 0, comments: 0, files: 0 };
  const links = await db.query(
    "select * from jira_links where project = $1 and source = 'field' order by linked_at, jira_key", [project]);
  if (!links.length) return out;
  const issues = await linkedIssues(jira, [...new Set(links.map((l) => String(l.jira_key)))], opts.fields, opts.search);
  for (const issue of issues) {
    const f = issue.fields ?? {};
    const mine = links.filter((l) => l.jira_key === issue.key);
    const status = f.status?.name ? String(f.status.name) : null;
    for (const l of mine) {
      if (l.jira_status !== status) {
        await db.query("update jira_links set jira_status = $4 where project = $1 and item_uid = $2 and jira_key = $3",
          [project, l.item_uid, l.jira_key, status]);
        l.jira_status = status;
      }
    }
    const fresh = mine.filter((l) => !l.backfilled_at);
    // Jira bumps `updated` on every edit and comment, so an issue untouched
    // since the last pass has nothing new for links already backfilled.
    const unchanged = opts.since && f.updated && Date.parse(f.updated) < opts.since.getTime();
    if (unchanged && !fresh.length) continue;
    for (const who of [f.reporter, f.assignee]) await opts.meet(who);
    out.files += await mirrorAttachments(db, jira, project, jiraUid("item", issue.key), issue);
    for (const l of fresh) if (await backfill(db, project, l, issue)) out.backfilled++;
    const comments = await opts.comments(issue);
    for (const l of unchanged ? fresh : mine) {
      for (const c of comments) {
        await opts.meet(c.author);
        const r = await commented(db, { project, item_uid: l.item_uid }, c, issue.key, `${project}:${l.item_uid}`);
        if (r.handled && (r.results as any[])?.some((x) => x.status === "applied" && !x.duplicate)) out.comments++;
      }
    }
  }
  await recordStatuses(db, project, links);
  return out;
}

/** Append the issue's block to the item's request, unless a version already
 * holds it. The request-version rules apply as to any other edit. */
async function backfill(db: Db, project: string, link: any, issue: any): Promise<boolean> {
  const key = String(issue.key);
  const requests = await db.query(
    `select uid, text, meta from notes where project = $1 and item_uid = $2 and kind = 'ticket-request'
      order by coalesce((meta->>'version')::int, 1) desc, n desc`, [project, link.item_uid]);
  let added = false;
  if (!requests.some((r) => hasTicketBlock(String(r.text ?? ""), key))) {
    const f = issue.fields ?? {};
    const base = jiraConfig()?.baseUrl;
    const description = adfToMarkdown(f.description, await mediaRef(db, project, jiraUid("item", key), key, base));
    const block = ticketBlock(key, String(f.summary ?? key), description, base);
    const cur = requests[0];
    const opId = `jira:backfill:${project}:${link.item_uid}:${key}:${ulid()}`;
    const op: Op = !cur
      ? { op_id: opId, op: "create", entity: "note", uid: ulid(), item_uid: link.item_uid,
          data: { kind: "ticket-request", text: appendTicketBlock("", block), meta: {}, source: "jira" } }
      : cur.meta?.frozen
        ? { op_id: opId, op: "create", entity: "note", uid: ulid(), item_uid: link.item_uid,
            data: { kind: "ticket-request", text: appendTicketBlock(String(cur.text ?? ""), block),
                    meta: cur.meta?.url ? { url: cur.meta.url } : {}, source: "jira" } }
        : { op_id: opId, op: "set", entity: "note", uid: cur.uid, item_uid: link.item_uid,
            data: { text: appendTicketBlock(String(cur.text ?? ""), block) } };
    const [r] = await applyOps(db, project, [op], BRIDGE);
    if (r.status !== "applied" || r.rejected?.length) {
      console.error(`jira ${key}: request for ${link.item_uid} not updated: ${r.reason ?? r.rejected?.[0]?.reason}`);
      return false;
    }
    added = true;
  }
  await db.query("update jira_links set backfilled_at = now() where project = $1 and item_uid = $2 and jira_key = $3",
    [project, link.item_uid, key]);
  return added;
}

/** Each item's `extra.jira_status`: its linked issues' Jira statuses, so the CLI can show them. */
async function recordStatuses(db: Db, project: string, links: any[]): Promise<void> {
  const byItem = new Map<string, Record<string, string>>();
  for (const l of links) {
    const m = byItem.get(l.item_uid) ?? {};
    if (l.jira_status) m[l.jira_key] = l.jira_status;
    byItem.set(l.item_uid, m);
  }
  for (const [itemUid, statuses] of byItem) {
    const [it] = await db.query("select extra->'jira_status' as s from items where project = $1 and uid = $2", [project, itemUid]);
    if (!it || JSON.stringify(sorted(it.s ?? {})) === JSON.stringify(sorted(statuses))) continue;
    await applyOps(db, project, [{ op_id: `jira:status:${project}:${itemUid}:${ulid()}`, op: "set", entity: "item",
      uid: itemUid, item_uid: itemUid, data: { "extra.jira_status": Object.keys(statuses).length ? statuses : null } }], BRIDGE);
  }
}

const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
