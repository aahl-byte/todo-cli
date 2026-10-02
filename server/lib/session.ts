import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { userForToken, type User } from "./auth";

export const COOKIE = "todo_token";

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return userForToken(await db(), token);
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
