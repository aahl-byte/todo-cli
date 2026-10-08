import { flushActions } from "@/lib/actions/runs";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

// Vercel cron calls this with `Authorization: Bearer $CRON_SECRET`.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return json(await flushActions(await db()));
}
