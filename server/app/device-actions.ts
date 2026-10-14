"use server";
// Approving a CLI login, and revoking the tokens it made.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { approveLogin, denyLogin, revokeApiToken } from "@/lib/devices";
import { requireUser } from "@/lib/session";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function approveLoginAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const ok = await approveLogin(await db(), str(fd, "code"), user.handle);
  redirect(ok ? "/devices?approved=1" : "/devices?expired=1");
}

export async function denyLoginAction(fd: FormData): Promise<void> {
  await requireUser();
  await denyLogin(await db(), str(fd, "code"));
  redirect("/devices");
}

export async function revokeTokenAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  await revokeApiToken(await db(), user.handle, Number(fd.get("id")));
  revalidatePath("/devices");
}
