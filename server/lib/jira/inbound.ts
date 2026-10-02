// The Jira → todo half: webhook payloads become ops applied as the mapped Jira
// user, unconditionally, and flagged so they are never echoed back. Op ids and
// uids derive from Jira's own ids, so a retried webhook is a no-op.
import crypto from "node:crypto";
import type { Db } from "../db";
import { applyOps, type Actor, type Op } from "../apply";
import { STATUSES, nowIso } from "../model";
import { adfToText } from "./adf";
import type { Fetch } from "./client";
import { COMMENT_MARK, jiraConfig, ownAccountId } from "./config";
import { enqueue } from "./outbound";

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface InboundResult {
  handled: boolean;
  reason?: string;
  results?: unknown[];
}

/** A stable 26-char uid for a Jira-originated entity. */
function jiraUid(...parts: string[]): string {
  return "J" + crypto.createHash("sha1").update(parts.join("\u001f")).digest("hex").slice(0, 25).toUpperCase();
}

async function handleFor(db: Db, p: Person): Promise<string | null> {
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

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}

export async function handleWebhook(db: Db, payload: any, opts: { deliveryId?: string; fetchImpl?: Fetch } = {}):
    Promise<InboundResult> {
  const event: string = payload?.webhookEvent ?? "";
  const issue = payload?.issue;
  if (!issue?.key) return { handled: false, reason: "no issue" };
  const [link] = await db.query(
    `select l.item_uid, i.status, i.project, p.jira_status_map from jira_links l
       join items i on i.uid = l.item_uid join projects p on p.key = i.project
      where l.jira_key = $1`, [issue.key]);

  if (event === "jira:issue_created") {
    if (link) return { handled: false, reason: "already linked" };
    const jiraProject = issue.fields?.project?.key;
    const [project] = await db.query("select key from projects where jira_project = $1", [jiraProject ?? null]);
    if (!project) return { handled: false, reason: `no project mapped to ${jiraProject}` };
    return created(db, project.key, issue);
  }
  if (!link) return { handled: false, reason: "issue not linked" };
  const cfg = jiraConfig();
  const own = cfg ? await ownAccountId(cfg, opts.fetchImpl) : null;
  if (event === "jira:issue_updated") {
    if (own && payload.user?.accountId === own) return { handled: false, reason: "own change" };
    // Without knowing our own account, a late echo of our transition could roll
    // the item back, so status changes wait until it is known.
    return updated(db, link, issue, payload, opts.deliveryId, own !== null);
  }
  if (event === "comment_created") return commented(db, link, payload.comment, own);
  return { handled: false, reason: `ignored ${event}` };
}

async function created(db: Db, project: string, issue: any): Promise<InboundResult> {
  const f = issue.fields ?? {};
  const uid = jiraUid("item", issue.key);
  const actor = await bridgeActor(db, f.reporter);
  const summary = String(f.summary ?? issue.key);
  const description = adfToText(f.description);
  const isBug = String(f.issuetype?.name ?? "").toLowerCase() === "bug";
  const ops: Op[] = [
    { op_id: `jira:${issue.key}:create`, op: "create", entity: "item", uid, item_uid: uid,
      data: { id: slug(summary), title: summary, type: isBug ? "bug" : "feature", status: "requested",
              creator: actor.handle, developer: await handleFor(db, f.assignee),
              created: f.created ? new Date(f.created).toISOString() : undefined } },
    { op_id: `jira:${issue.key}:request`, op: "create", entity: "note", uid: jiraUid("request", issue.key), item_uid: uid,
      data: { n: 1, kind: "ticket-request", text: description ? `${summary}\n\n${description}` : summary,
              meta: { jira_key: issue.key }, source: "jira" } },
  ];
  const results = await applyOps(db, project, ops, actor);
  if (results[0].status === "applied") {
    await db.query("insert into jira_links (item_uid, jira_key) values ($1, $2) on conflict do nothing", [uid, issue.key]);
  }
  return { handled: true, results };
}

async function updated(db: Db, link: any, issue: any, payload: any, deliveryId: string | undefined,
                       statusSafe: boolean): Promise<InboundResult> {
  const items: any[] = payload.changelog?.items ?? [];
  const data: Record<string, unknown> = {};
  if (items.some((x) => x.field === "assignee")) data.developer = await handleFor(db, issue.fields?.assignee);
  const status = statusSafe ? items.find((x) => x.field === "status") : undefined;
  if (status) {
    const jiraStatus = String((Object.hasOwn(status, "toString") ? status.toString : null) ?? issue.fields?.status?.name ?? "");
    const map: Record<string, string> = link.jira_status_map ?? {};
    const echo = (map[link.status] ?? "").toLowerCase() === jiraStatus.toLowerCase();
    // jsonb keeps no key order, so ties go to the earliest status in the lifecycle.
    const todo = STATUSES.find((k) => (map[k] ?? "").toLowerCase() === jiraStatus.toLowerCase());
    if (todo && !echo) data.status = todo;
  }
  if (!Object.keys(data).length) return { handled: false, reason: "nothing to apply" };
  const id = payload.changelog?.id ?? deliveryId ?? `${issue.key}:${payload.timestamp ?? nowIso()}`;
  const op: Op = { op_id: `jira:update:${id}`, op: "set", entity: "item", uid: link.item_uid, item_uid: link.item_uid, data };
  const actor = await bridgeActor(db, payload.user);
  const results = await applyOps(db, link.project, [op], actor);
  const blocked = results[0].rejected?.find((x) => x.field === "status");
  if (blocked && !results[0].duplicate) await gated(db, link, issue.key, String(data.status), blocked.reason, actor, String(id));
  return { handled: true, results };
}

/** Jira moved the issue somewhere todo refused (the deploy gate): say so on both sides. */
async function gated(db: Db, link: any, key: string, to: string, reason: string, actor: Actor, id: string) {
  const why = reason === "checks-pending" ? "pre-deploy checks are still pending" : reason;
  await applyOps(db, link.project, [{
    op_id: `jira:gated:${id}`, op: "create", entity: "log", uid: jiraUid("gated", id),
    item_uid: link.item_uid,
    data: { text: `Jira moved ${key} to ${to}, but todo kept it at ${link.status}: ${why}.`, ts: nowIso() },
  }], actor);
  await enqueue(db, link.item_uid, "comment",
    { key, author: "todo", label: "comment", text: `Not moved to ${to} in todo: ${why}.` });
}

async function commented(db: Db, link: any, comment: any, own: string | null): Promise<InboundResult> {
  if (!comment?.id) return { handled: false, reason: "no comment" };
  const text = adfToText(comment.body);
  if ((own && comment.author?.accountId === own) || text.includes(COMMENT_MARK)) {
    return { handled: false, reason: "own comment" };
  }
  const ours = await db.query("select 1 from jira_outbox where result->>'comment_id' = $1", [String(comment.id)]);
  if (ours.length) return { handled: false, reason: "own comment" };
  const op: Op = { op_id: `jira:comment:${comment.id}`, op: "create", entity: "note",
                   uid: jiraUid("comment", String(comment.id)), item_uid: link.item_uid,
                   data: { kind: "comment", text, meta: { jira_comment_id: String(comment.id) }, source: "jira" } };
  return { handled: true, results: await applyOps(db, link.project, [op], await bridgeActor(db, comment.author)) };
}
