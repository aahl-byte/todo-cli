"use server";
// The item page's doc writes. The browser sends the bytes straight to the
// upload target (the bucket, or the app's files route), so a doc never passes
// through a server action's body limit; these only mint the target and record
// or delete the doc.
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-helpers";
import { db } from "@/lib/db";
import { DocError, issueUpload, recordDoc, removeDoc } from "@/lib/docs";
import { docType, filesEnabled, uploadTarget } from "@/lib/files";
import { requireUser } from "@/lib/session";

const fail = (message: string): ActionState => ({ ok: false, message, at: Date.now() });

export async function docUploadTarget(a: { project: string; itemUid: string; name: string; size: number }):
    Promise<ActionState & { key?: string; url?: string; fields?: Record<string, string> }> {
  await requireUser();
  if (!filesEnabled()) return fail("Uploads need S3 here.");
  try {
    const key = await issueUpload(await db(), a.project, a.itemUid, a.name, a.size);
    return { ok: true, key, ...(await uploadTarget(key, docType(a.name))) };
  } catch (e) {
    if (e instanceof DocError) return fail(`Not uploaded: ${e.message}.`);
    throw e;
  }
}

const CONFLICT = (name: string) => `Not saved: ${name} changed since this page loaded. Reload to see it.`;

/** Record an upload as the doc `name`, if it is still at `base` (null for a new doc). */
export async function saveDoc(a: { project: string; itemUid: string; name: string; key: string; base: string | null }): Promise<ActionState> {
  const user = await requireUser();
  try {
    const r = await recordDoc(await db(), a.project, user.handle, { item_uid: a.itemUid, name: a.name, file_key: a.key, base: a.base });
    if (r.status === "conflict") return fail(CONFLICT(a.name));
  } catch (e) {
    if (e instanceof DocError) return fail(`Not saved: ${e.message}.`);
    throw e;
  }
  revalidatePath(`/p/${a.project}`, "layout");
  return { ok: true, at: Date.now() };
}

export async function deleteDoc(a: { project: string; uid: string; name: string; base: string }): Promise<ActionState> {
  const user = await requireUser();
  try {
    const r = await removeDoc(await db(), a.project, user.handle, a.uid, a.base);
    if (r.status === "conflict") return fail(CONFLICT(a.name));
  } catch (e) {
    if (e instanceof DocError) return fail(`Not deleted: ${e.message}.`);
    throw e;
  }
  revalidatePath(`/p/${a.project}`, "layout");
  return { ok: true, at: Date.now() };
}
