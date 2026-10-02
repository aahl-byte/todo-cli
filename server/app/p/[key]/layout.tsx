import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { project, projects } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ key: string }> }) {
  const { key } = await params;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  return (
    <>
      <TopBar handle={user.handle} project={p} all={await projects(d)} />
      <main>{children}</main>
    </>
  );
}
