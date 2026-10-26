import Link from "next/link";

const TABS = [
  { key: "general", label: "General", path: "" },
  { key: "plugins", label: "Plugins", path: "/plugins" },
] as const;

/** The project settings' pages. */
export function SettingsTabs({ projectKey, current }: { projectKey: string; current: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="settings-tabs" aria-label="settings">
      {TABS.map((t) => (
        <Link key={t.key} href={`/p/${projectKey}/settings${t.path}`} aria-current={t.key === current ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}
