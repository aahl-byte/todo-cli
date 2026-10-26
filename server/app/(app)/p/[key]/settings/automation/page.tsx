import { notFound } from "next/navigation";
import { AutomationSettings } from "@/components/AutomationSettings";
import { SettingsTabs } from "@/components/SettingsTabs";
import { db } from "@/lib/db";
import { STATUSES } from "@/lib/model";
import { automationPage } from "@/lib/plugin-views";
import { secretKey } from "@/lib/plugins/secrets";
import { requireUser } from "@/lib/session";

export default async function AutomationSettingsPage({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const { key } = await params;
  const { repo } = await searchParams;
  await requireUser();
  const d = await db();
  const [p] = await d.query("select 1 from projects where key = $1", [key]);
  if (!p) notFound();
  const page = await automationPage(d, key, typeof repo === "string" ? repo : null);
  return (
    <div className="settings automation-settings">
      <SettingsTabs projectKey={key} current="automation" />
      <AutomationSettings projectKey={key} page={JSON.parse(JSON.stringify(page))} statuses={STATUSES} secretKeySet={!!secretKey()} />
    </div>
  );
}
