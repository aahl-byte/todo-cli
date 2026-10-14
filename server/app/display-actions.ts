"use server";
// Setting up wall displays from a signed-in browser.
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { addDisplay, DISPLAY_COOKIE, displayCookie, removeDisplay } from "@/lib/display";
import { COOKIE, requireUser } from "@/lib/session";
import { project } from "@/lib/views";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

/** Make this browser a display of the project, signed out of everything else, then show it. */
export async function startDisplayAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const d = await db();
  const p = await project(d, str(fd, "project"));
  if (!p) redirect("/displays");
  const token = await addDisplay(d, p.key, `${user.handle} ${crypto.randomBytes(2).toString("hex")}`);
  const https = ((await headers()).get("x-forwarded-proto") ?? "http").split(",")[0].trim() === "https";
  const jar = await cookies();
  jar.set(DISPLAY_COOKIE, token, displayCookie(https));
  jar.delete(COOKIE);
  redirect(`/display/${encodeURIComponent(p.key)}?setup=1`);
}

export async function removeDisplayAction(fd: FormData): Promise<void> {
  await requireUser();
  await removeDisplay(await db(), str(fd, "project"), str(fd, "label"));
  revalidatePath("/displays");
}
