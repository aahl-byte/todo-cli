import { db } from "@/lib/db";
import { recomputeAll } from "@/lib/gitfacts";
import { json } from "@/lib/http";

// A cron tick recomputes git facts; Vercel cron calls it with `Authorization: Bearer $CRON_SECRET`.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return json({ projects: await recomputeAll(await db()) });
}
