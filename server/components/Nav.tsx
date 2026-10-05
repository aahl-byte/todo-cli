"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** Filter params the work queues share, so switching page keeps the filter. */
const SHARED = ["f", "view", "tab", "type"];

export function Nav({ projectKey, deployStep }: { projectKey: string; deployStep: boolean }) {
  const path = usePathname();
  const q = useSearchParams();
  const base = `/p/${projectKey}`;
  const kept = new URLSearchParams();
  for (const k of SHARED) { const v = q.get(k); if (v) kept.set(k, v); }
  const suffix = kept.toString() ? `?${kept}` : "";
  const links = [
    { href: base, label: "Board", on: path === base || path.startsWith(`${base}/i/`) },
    { href: `${base}/qa`, label: "QA", on: path === `${base}/qa` },
    ...(deployStep ? [{ href: `${base}/deploy`, label: "Deploy", on: path === `${base}/deploy` }] : []),
    { href: `${base}/settings`, label: "Settings", on: path === `${base}/settings`, wideOnly: true },
  ];
  return (
    <nav>
      {links.map((l) => <Link key={l.href} href={l.wideOnly ? l.href : `${l.href}${suffix}`} className={l.wideOnly ? "wide-nav" : undefined}
                            aria-current={l.on ? "page" : undefined}>{l.label}</Link>)}
    </nav>
  );
}
