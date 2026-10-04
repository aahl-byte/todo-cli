"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav({ projectKey, deployStep }: { projectKey: string; deployStep: boolean }) {
  const path = usePathname();
  const base = `/p/${projectKey}`;
  const links = [
    { href: base, label: "Board", on: path === base || path.startsWith(`${base}/i/`) },
    { href: `${base}/qa`, label: "QA", on: path === `${base}/qa` },
    ...(deployStep ? [{ href: `${base}/deploy`, label: "Deploy", on: path === `${base}/deploy` }] : []),
  ];
  return (
    <nav>
      {links.map((l) => <Link key={l.href} href={l.href} aria-current={l.on ? "page" : undefined}>{l.label}</Link>)}
    </nav>
  );
}
