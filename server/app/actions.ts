"use server";
// Form-driven writes: new requests, deploy-all, inbox reads, sign-in. The item
// page's writes live in item-actions.ts.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { applyOps, ProjectNotFound, type Op, type Result } from "@/lib/apply";
import { describe, safeNext, type ActionState } from "@/lib/action-helpers";
import { userForToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { markRead } from "@/lib/inbox";
import * as build from "@/lib/ops-builder";
import { COOKIE, requireUser } from "@/lib/session";
import { later } from "@/lib/http";
import { flushJira } from "@/lib/jira/flush";

export type { ActionState };

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

/** Mark every ready item deployed; items with pending pre-deploy checks or a
 * newer change are held back and named. */
export async function deployAllAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const project = str(fd, "project");
  const items: { uid: string; versions: Record<string, number> }[] = JSON.parse(str(fd, "items") || "[]");
  const user = await requireUser();
  const d = await db();
  const ops: Op[] = [];
  const held: string[] = [];
  for (const it of items) {
    try {
      ops.push(...build.moveOps({ uid: it.uid, item_uid: it.uid, versions: it.versions, status: "ready-to-deploy" },
        "deployed", { me: user.handle }));
    } catch {
      held.push(it.uid);
    }
  }
  let results: Result[];
  try {
    results = await applyOps(d, project, ops, { handle: user.handle });
  } catch (e) {
    if (e instanceof ProjectNotFound) return { ok: false, message: "No such project.", at: Date.now() };
    throw e;
  }
  later(() => flushJira(d));
  revalidatePath(`/p/${project}`, "layout");
  held.push(...ops.filter((_, i) => results[i].rejected?.length || results[i].status === "rejected").map((op) => op.uid));
  if (!held.length) return { ok: true, message: `Deployed ${results.length}.`, at: Date.now() };
  const ids = (await d.query("select id from items where project = $2 and uid = any($1::text[]) order by id", [held, project])).map((r) => r.id);
  return { ok: false, at: Date.now(), message: `Held back ${ids.join(", ")}: pending checks or a newer change.` };
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
  let results: Result[];
  try {
    results = await applyOps(d, project, ops, { handle: user.handle });
  } catch (e) {
    if (e instanceof ProjectNotFound) return { ok: false, message: "No such project." };
    throw e;
  }
  const state = describe(results);
  if (!state.ok) return state;
  const [row] = await d.query("select id from items where uid = $1 and project = $2", [ops[0].uid, project]);
  redirect(`/p/${project}/i/${row.id}`);
}

export async function readAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  await markRead(await db(), user.handle, [Number(fd.get("id"))]);
  redirect(safeNext(String(fd.get("to") || "/inbox")));
}

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const token = str(fd, "token").trim();
  const user = await userForToken(await db(), token);
  if (!user || (str(fd, "handle").trim() && user.handle !== str(fd, "handle").trim())) {
    return { ok: false, message: "That handle and token don't match." };
  }
  // Secure only over HTTPS: a browser drops a Secure cookie sent over plain
  // http (a LAN or Tailscale host), which would make sign-in silently fail.
  const proto = (await headers()).get("x-forwarded-proto") ?? "http";
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: proto.split(",")[0].trim() === "https",
                                         path: "/", maxAge: 60 * 60 * 24 * 90 });
  redirect(safeNext(str(fd, "next")));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(COOKIE);
  redirect("/login");
}
