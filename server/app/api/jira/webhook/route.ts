import crypto from "node:crypto";
import { db } from "@/lib/db";
import { json, later } from "@/lib/http";
import { jiraConfig } from "@/lib/jira/config";
import { flushJira } from "@/lib/jira/flush";
import { handleWebhook } from "@/lib/jira/inbound";

function matches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function POST(req: Request) {
  const cfg = jiraConfig();
  if (!cfg) return json({ error: "jira bridge not configured" }, 503);
  const secret = new URL(req.url).searchParams.get("secret") ?? "";
  if (!cfg.webhookSecret || !matches(secret, cfg.webhookSecret)) return json({ error: "unauthorized" }, 401);
  const payload = await req.json().catch(() => null);
  const d = await db();
  const result = await handleWebhook(d, payload, {
    deliveryId: req.headers.get("x-atlassian-webhook-identifier") ?? undefined,
  });
  later(() => flushJira(d));
  return json(result, result.retry ? 503 : 200);
}
