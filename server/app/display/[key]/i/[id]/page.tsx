import { notFound } from "next/navigation";
import { ItemView } from "@/components/item/ItemView";
import { db } from "@/lib/db";
import { currentDisplay } from "@/lib/display-session";
import { linkPrStatuses } from "@/lib/github";
import { item as loadItem, project } from "@/lib/views";

export const dynamic = "force-dynamic";

/** An item on a wall display: everything the item page shows, with nothing to change. */
export default async function DisplayItem({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  if (!(await currentDisplay(key))) return null;
  const d = await db();
  const p = await project(d, key);
  const data = p && (await loadItem(d, key, id));
  if (!p || !data) notFound();
  const ctx = {
    project: key,
    deployStep: p.deploy_step,
    me: "",
    users: [],
    uploads: false,
    jiraBase: process.env.JIRA_BASE_URL?.replace(/\/+$/, "") ?? null,
    itemUid: data.item.uid,
    pinned: false,
    actions: [],
    readOnly: { base: `/display/${key}` },
  };
  const prs = await linkPrStatuses(data.links);
  return <ItemView data={JSON.parse(JSON.stringify({ ...data, prs }))} ctx={ctx} />;
}
