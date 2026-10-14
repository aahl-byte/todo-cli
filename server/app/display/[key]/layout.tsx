import type { ReactNode } from "react";
import type { Metadata } from "next";
import { withBase } from "@/lib/base";

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

export default async function DisplayLayout({ children, params }: Params & { children: ReactNode }) {
  const { key } = await params;
  return (
    <>
      <link rel="manifest" href={at(key, "/manifest.webmanifest")} />
      {children}
    </>
  );
}
