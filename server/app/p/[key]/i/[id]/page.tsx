import { notFound } from "next/navigation";
import { ItemView } from "@/components/item/ItemView";
import { db } from "@/lib/db";
import { filesEnabled } from "@/lib/files";
import { requireUser } from "@/lib/session";
import { item as loadItem, project, users } from "@/lib/views";

export default async function ItemPage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  const data = p && (await loadItem(d, key, id));
  if (!p || !data) notFound();
  const ctx = {
    project: key,
    deployStep: p.deploy_step,
    me: user.handle,
    users: (await users(d)).map((u) => u.handle),
    uploads: filesEnabled(),
    jiraBase: process.env.JIRA_BASE_URL?.replace(/\/+$/, "") ?? null,
    itemUid: data.item.uid,
  };
  return <ItemView data={JSON.parse(JSON.stringify(data))} ctx={ctx} />;
}
