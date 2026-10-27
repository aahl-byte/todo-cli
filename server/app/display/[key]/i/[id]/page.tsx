import { notFound } from "next/navigation";
import { ItemView } from "@/components/item/ItemView";
import { db } from "@/lib/db";
import { currentDisplay } from "@/lib/display-session";
import { itemGitFacts } from "@/lib/gitfacts";
import { linkPrStatuses } from "@/lib/github";
import { prToken } from "@/lib/github-token";
import { lastVisit } from "@/lib/inbox";
import { item as loadItem, project } from "@/lib/views";

export const dynamic = "force-dynamic";

/** An item on a wall display: the item page as whoever set the display up sees it, with nothing to change. */
export default async function DisplayItem({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  const display = await currentDisplay(key);
  if (!display) return null;
  const d = await db();
  const p = await project(d, key);
  const data = p && (await loadItem(d, key, id));
  if (!p || !data) notFound();
  const ctx = {
    project: key,
    deployStep: p.deploy_step,
    me: display.handle ?? "",
    users: [],
    uploads: false,
    jiraBase: process.env.JIRA_BASE_URL?.replace(/\/+$/, "") ?? null,
    itemUid: data.item.uid,
    pinned: false,
    actions: [],
    readOnly: { base: `/display/${key}` },
    lastSeen: display.handle && (await lastVisit(d, display.handle, key, data.item.uid)),
  };
  const [prs, git] = await Promise.all([linkPrStatuses(data.links, undefined, await prToken(d, key)), itemGitFacts(d, key, data.item.uid).catch(() => ({}))]);
  return <ItemView data={JSON.parse(JSON.stringify({ ...data, prs, git }))} ctx={ctx} />;
}
