import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Pins } from "@/components/Pins";
import { Tooltips } from "@/components/ui";
import { withBase } from "@/lib/base";
import { db } from "@/lib/db";
import { currentDisplay } from "@/lib/display-session";
import { PINS_COOKIE } from "@/lib/filters";
import { pins } from "@/lib/pins";
import { project } from "@/lib/views";

export const dynamic = "force-dynamic";

const REFRESH_MS = 60_000;

type Params = { params: Promise<{ key: string }> };

const at = (key: string, path: string) => withBase(`/display/${encodeURIComponent(key)}${path}`);

// Everything a display links lives under its own path, which needs no sign-in.
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { key } = await params;
  return {
    title: `${key} display`,
    icons: { icon: at(key, "/icons/icon.svg"), apple: at(key, "/icons/apple-touch-icon.png") },
    appleWebApp: { capable: true, title: `${key} display`, statusBarStyle: "black" },
  };
}

/** A wall display: its project's pages, read-only, refreshing every minute. Each page checks the key too. */
export default async function DisplayLayout({ children, params }: Params & { children: ReactNode }) {
  const { key } = await params;
  const display = await currentDisplay(key);
  const manifest = <link rel="manifest" href={at(key, "/manifest.webmanifest")} />;
  if (!display) {
    return <main className="display">{manifest}<p className="updated">This display isn't signed in. Set it up again from <Link href="/displays">displays</Link>.</p></main>;
  }
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const base = `/display/${p.key}`;
  return (
    <>
      {manifest}
      {display.handle && (
        <Pins project={p.key} pins={await pins(d, display.handle, p.key)} thin={(await cookies()).get(PINS_COOKIE)?.value === "thin"}
              base={base} readOnly />
      )}
      <main className="display">
        <div className="display-head">
          <Link href={base} className="brand">{p.name}</Link>
          <span className="tag display-badge">read-only display</span>
          <AutoRefresh everyMs={REFRESH_MS} at={Date.now()} />
        </div>
        <Tooltips />
        {children}
      </main>
    </>
  );
}
