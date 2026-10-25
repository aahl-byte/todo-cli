import { db } from "@/lib/db";
import { scheduleRecompute } from "@/lib/gitfacts";
import { json, later } from "@/lib/http";
import { firstDelivery, flushPluginRuns, githubEvent, readCapped, signatureValid } from "@/lib/plugins/server";

/** GitHub's push, pull_request and deployment_status deliveries, signed with GITHUB_WEBHOOK_SECRET. */
export async function POST(req: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: "github webhook not configured" }, 503);
  const body = await readCapped(req);
  if (body === null) return json({ error: "body too large" }, 413);
  if (!signatureValid(body, req.headers.get("x-hub-signature-256"), secret)) return json({ error: "unauthorized" }, 401);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "body isn't JSON" }, 400);
  }
  const d = await db();
  if (!(await firstDelivery(d, req.headers.get("x-github-delivery")))) return json({ repo: null, queued: 0, projects: [], duplicate: true }, 200);
  const outcome = await githubEvent(d, req.headers.get("x-github-event") ?? "", payload);
  later(async () => {
    await flushPluginRuns(d);
    if (outcome.repo) for (const p of outcome.projects) await scheduleRecompute(d, p, fetch, outcome.repo);
  });
  return json(outcome, 202);
}
