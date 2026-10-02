"use server";
// Dashboard writes: each action builds ops (lib/ops-builder.ts) and sends them
// through the same apply path the CLI's sync uses.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { applyOps, type Op, type Result } from "@/lib/apply";
import { userForToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { markRead } from "@/lib/inbox";
import * as build from "@/lib/ops-builder";
import { COOKIE, requireUser } from "@/lib/session";
import { later } from "@/lib/http";
import { flushJira } from "@/lib/jira/flush";

export interface ActionState {
  ok: boolean;
  message?: string;
  at?: number;
}

const REASONS: Record<string, string> = {
  "checks-pending": "pre-deploy checks are still pending",
  "agent-handoff": "an agent can't hand work to QA",
  "group-rolled-back": "nothing was applied",
  removed: "it was removed",
};

export async function describe(results: Result[]): Promise<ActionState> {
  for (const r of results) {
    for (const x of r.rejected ?? []) {
      if (x.reason === "stale") {
        const at = x.at ? ` at ${x.at.slice(11, 16)}` : "";
        return { ok: false, message: `${x.by ?? "Someone"} set ${x.field} to ${JSON.stringify(x.server_value)}${at} — reload and try again.`, at: Date.now() };
      }
      return { ok: false, message: `Not applied: ${REASONS[x.reason] ?? x.reason}.`, at: Date.now() };
    }
    if (r.status === "rejected" && r.reason !== "group-rolled-back") {
      return { ok: false, message: `Not applied: ${REASONS[r.reason ?? ""] ?? r.reason}.`, at: Date.now() };
    }
  }
  return { ok: true, at: Date.now() };
}

async function run(project: string, ops: Op[] | (() => Op[])): Promise<ActionState> {
  const user = await requireUser();
  let built: Op[];
  try {
    built = typeof ops === "function" ? ops() : ops;
  } catch (e) {
    return { ok: false, message: (e as Error).message, at: Date.now() };
  }
  const d = await db();
  const results = await applyOps(d, project, built, { handle: user.handle });
  later(() => flushJira(d));
  revalidatePath(`/p/${project}`, "layout");
  return describe(results);
}

function refOf(fd: FormData, prefix = ""): build.Ref {
  return {
    uid: String(fd.get(prefix + "uid")),
    item_uid: String(fd.get("item_uid") ?? fd.get(prefix + "uid")),
    versions: JSON.parse(String(fd.get(prefix + "versions") ?? "{}")),
  };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function itemAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const kind = str(fd, "action");
  const item = { ...refOf(fd), qa_assignee: str(fd, "qa_assignee") || null };
  const user = await requireUser();
  switch (kind) {
    case "status":
      return run(project, build.statusOps(item, str(fd, "to"), { force: fd.get("force") === "1" }));
    case "reject":
      return run(project, () => build.rejectOps(item, str(fd, "text")));
    case "back":
      return run(project, () => build.backToWorkOps(item, str(fd, "text")));
    case "pickup":
      return run(project, build.pickUpOps(item, user.handle));
    case "approve":
      return run(project, build.approveOps(item, fd.get("deploy_step") !== "0"));
    case "people":
      return run(project, [build.setOp("item", item, { developer: str(fd, "developer") || null, qa_assignee: str(fd, "qa") || null })]);
    case "edit": {
      const data: Record<string, unknown> = {};
      for (const f of ["title", "type", "priority"]) if (fd.has(f)) data[f] = str(fd, f).trim();
      return run(project, [build.setOp("item", item, data)]);
    }
    default:
      return { ok: false, message: `unknown action ${kind}` };
  }
}

export async function noteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const itemUid = str(fd, "item_uid");
  const user = await requireUser();
  switch (str(fd, "action")) {
    case "add":
      return run(project, () => build.noteOps(itemUid, str(fd, "kind") || "context", str(fd, "text")));
    case "link":
      return run(project, () => build.linkOps(itemUid, str(fd, "url"), str(fd, "label"), str(fd, "type")));
    case "answer":
      return run(project, () => build.answerOps(refOf(fd), str(fd, "text"), user.handle));
    case "remove":
      return run(project, [build.removeOp("note", refOf(fd))]);
    default:
      return { ok: false, message: "unknown note action" };
  }
}

export async function taskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const itemUid = str(fd, "item_uid");
  switch (str(fd, "action")) {
    case "add": {
      const phase = str(fd, "phase");
      return run(project, () => build.taskOps(itemUid, str(fd, "title"), phase === "" ? null : Number(phase)));
    }
    case "status":
      return run(project, [build.setOp("task", refOf(fd), { status: str(fd, "status") })]);
    case "phase": {
      const phase = str(fd, "phase");
      return run(project, [build.setOp("task", refOf(fd), { phase: phase === "" ? null : Number(phase), position: 1e6 })]);
    }
    case "remove":
      return run(project, [build.removeOp("task", refOf(fd))]);
    default:
      return { ok: false, message: "unknown task action" };
  }
}

export async function checkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const itemUid = str(fd, "item_uid");
  switch (str(fd, "action")) {
    case "add":
      return run(project, () => build.checkOps(itemUid, str(fd, "kind"), str(fd, "title"), str(fd, "payload"), str(fd, "timing")));
    case "toggle":
      return run(project, [build.setOp("check", refOf(fd), { status: str(fd, "status") })]);
    case "remove":
      return run(project, [build.removeOp("check", refOf(fd))]);
    default:
      return { ok: false, message: "unknown check action" };
  }
}

/** Mark every ready item deployed; items with pending pre-deploy checks are held back. */
export async function deployAllAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const items: build.Ref[] = JSON.parse(str(fd, "items") || "[]");
  const user = await requireUser();
  const d = await db();
  const results = await applyOps(d, project, items.flatMap((it) => build.statusOps(it, "deployed")), { handle: user.handle });
  later(() => flushJira(d));
  revalidatePath(`/p/${project}`, "layout");
  const held = results.filter((r) => r.rejected?.length || r.status === "rejected").length;
  return held
    ? { ok: false, message: `Deployed ${results.length - held}; held back ${held} with pending checks or newer changes.`, at: Date.now() }
    : { ok: true, message: `Deployed ${results.length}.`, at: Date.now() };
}

export async function requestAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const user = await requireUser();
  let ops: Op[];
  try {
    ops = build.requestOps({ title: str(fd, "title"), type: str(fd, "type"), priority: str(fd, "priority"),
      description: str(fd, "description"), developer: str(fd, "developer"), qa_assignee: str(fd, "qa") }, user.handle);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const d = await db();
  const results = await applyOps(d, project, ops, { handle: user.handle });
  const state = await describe(results);
  if (!state.ok) return state;
  const [row] = await d.query("select id from items where uid = $1", [ops[0].uid]);
  redirect(`/p/${project}/i/${row.id}`);
}

export async function readAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  await markRead(await db(), user.handle, [Number(fd.get("id"))]);
  redirect(String(fd.get("to") || "/inbox"));
}

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const token = str(fd, "token").trim();
  const user = await userForToken(await db(), token);
  if (!user || (str(fd, "handle").trim() && user.handle !== str(fd, "handle").trim())) {
    return { ok: false, message: "That handle and token don't match." };
  }
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
                                         path: "/", maxAge: 60 * 60 * 24 * 90 });
  redirect(str(fd, "next") || "/");
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(COOKIE);
  redirect("/login");
}
