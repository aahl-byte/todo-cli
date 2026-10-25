import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { pluginTick } from "@/lib/plugins/server";

// Polls repos without webhooks, queues due every: floors and delivers plugin runs.
// Cron calls it with `Authorization: Bearer $CRON_SECRET`.
async function tick(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return json(await pluginTick(await db()));
}

export const GET = tick;
export const POST = tick;
