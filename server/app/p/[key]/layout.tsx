import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Pins } from "@/components/Pins";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { PINS_COOKIE } from "@/lib/filters";
import { pins } from "@/lib/pins";
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
      <Pins project={p.key} pins={await pins(d, user.handle, p.key)} thin={(await cookies()).get(PINS_COOKIE)?.value === "thin"} />
      <main>{children}</main>
    </>
  );
}
