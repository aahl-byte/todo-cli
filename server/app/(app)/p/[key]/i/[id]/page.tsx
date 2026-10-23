import { notFound } from "next/navigation";
import { ItemView } from "@/components/item/ItemView";
import { projectActions } from "@/lib/actions/runs";
import { db } from "@/lib/db";
import { filesEnabled } from "@/lib/files";
import { itemGitFacts } from "@/lib/gitfacts";
import { linkPrStatuses } from "@/lib/github";
import { isPinned } from "@/lib/pins";
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
    pinned: await isPinned(d, user.handle, key, data.item.uid),
    actions: (await projectActions(d, key)).map(({ id, name, runner }) => ({ id, name, runner })),
  };
  const [prs, git] = await Promise.all([linkPrStatuses(data.links), itemGitFacts(d, key, data.item.uid).catch(() => ({}))]);
  return <ItemView data={JSON.parse(JSON.stringify({ ...data, prs, git }))} ctx={ctx} />;
}
