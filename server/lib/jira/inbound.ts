// The Jira → todo half: webhook payloads become ops applied as the mapped Jira
// user, unconditionally, and flagged so they are never echoed back.
import type { Db } from "../db";
import { applyOps, type Actor, type Op } from "../apply";
import { STATUSES } from "../model";
import { ulid } from "../ulid";
import { adfToText } from "./adf";
import { jiraConfig } from "./config";

type Person = { accountId?: string; displayName?: string } | null | undefined;

export interface InboundResult {
  handled: boolean;
  reason?: string;
  results?: unknown[];
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

export async function handleWebhook(db: Db, payload: any): Promise<InboundResult> {
  const event: string = payload?.webhookEvent ?? "";
  const issue = payload?.issue;
  const jiraProject = issue?.fields?.project?.key;
  if (!issue?.key || !jiraProject) return { handled: false, reason: "no issue" };
  const [project] = await db.query("select key, jira_status_map from projects where jira_project = $1", [jiraProject]);
  if (!project) return { handled: false, reason: `no project mapped to ${jiraProject}` };
  const [link] = await db.query(
    "select l.item_uid, i.status from jira_links l join items i on i.uid = l.item_uid where l.jira_key = $1",
    [issue.key]);

  if (event === "jira:issue_created") {
    if (link) return { handled: false, reason: "already linked" };
    return created(db, project.key, issue);
  }
  if (!link) return { handled: false, reason: "issue not linked" };
  if (event === "jira:issue_updated") return updated(db, project, link, issue, payload.changelog, payload.user);
  if (event === "comment_created") return commented(db, project.key, link.item_uid, payload.comment);
  return { handled: false, reason: `ignored ${event}` };
}

async function created(db: Db, project: string, issue: any): Promise<InboundResult> {
  const f = issue.fields ?? {};
  const uid = ulid();
  const actor = await bridgeActor(db, f.reporter);
  const summary = String(f.summary ?? issue.key);
  const description = adfToText(f.description);
  const isBug = String(f.issuetype?.name ?? "").toLowerCase() === "bug";
  const ops: Op[] = [
    { op_id: `jira:${issue.key}:create`, op: "create", entity: "item", uid, item_uid: uid,
      data: { id: slug(summary), title: summary, type: isBug ? "bug" : "feature", status: "requested",
              creator: actor.handle, developer: await handleFor(db, f.assignee),
              created: f.created ? new Date(f.created).toISOString() : undefined } },
    { op_id: `jira:${issue.key}:request`, op: "create", entity: "note", uid: ulid(), item_uid: uid,
      data: { n: 1, kind: "ticket-request", text: description ? `${summary}\n\n${description}` : summary,
              meta: { jira_key: issue.key }, source: "jira" } },
  ];
  const results = await applyOps(db, project, ops, actor);
  if (results[0].status === "applied") {
    await db.query("insert into jira_links (item_uid, jira_key) values ($1, $2) on conflict do nothing", [uid, issue.key]);
  }
  return { handled: true, results };
}

async function updated(db: Db, project: any, link: any, issue: any, changelog: any, user: Person): Promise<InboundResult> {
  const items: any[] = changelog?.items ?? [];
  const data: Record<string, unknown> = {};
  const assignee = items.find((x) => x.field === "assignee");
  if (assignee) data.developer = await handleFor(db, issue.fields?.assignee);
  const status = items.find((x) => x.field === "status");
  if (status) {
    const jiraStatus = String(status.toString ?? issue.fields?.status?.name ?? "");
    const map: Record<string, string> = project.jira_status_map ?? {};
    const echo = (map[link.status] ?? "").toLowerCase() === jiraStatus.toLowerCase();
    // jsonb keeps no key order, so ties go to the earliest status in the lifecycle.
    const todo = STATUSES.find((k) => (map[k] ?? "").toLowerCase() === jiraStatus.toLowerCase());
    if (todo && !echo) data.status = todo;
  }
  if (!Object.keys(data).length) return { handled: false, reason: "nothing to apply" };
  const op: Op = { op_id: `jira:${issue.key}:update:${ulid()}`, op: "set", entity: "item",
                   uid: link.item_uid, item_uid: link.item_uid, data };
  return { handled: true, results: await applyOps(db, project.key, [op], await bridgeActor(db, user)) };
}

async function commented(db: Db, project: string, itemUid: string, comment: any): Promise<InboundResult> {
  if (!comment?.id) return { handled: false, reason: "no comment" };
  const cfg = jiraConfig();
  if (cfg?.accountId && comment.author?.accountId === cfg.accountId) return { handled: false, reason: "own comment" };
  const ours = await db.query("select 1 from jira_outbox where result->>'comment_id' = $1", [String(comment.id)]);
  if (ours.length) return { handled: false, reason: "own comment" };
  const op: Op = { op_id: `jira:comment:${comment.id}`, op: "create", entity: "note", uid: ulid(), item_uid: itemUid,
                   data: { kind: "comment", text: adfToText(comment.body), meta: { jira_comment_id: String(comment.id) },
                           source: "jira" } };
  return { handled: true, results: await applyOps(db, project, [op], await bridgeActor(db, comment.author)) };
}
