import { notFound } from "next/navigation";
import { PluginsSettings } from "@/components/PluginsSettings";
import { SettingsTabs } from "@/components/SettingsTabs";
import { OWNERS_UNSET } from "@/lib/checkouts";
import { db } from "@/lib/db";
import { STATUSES } from "@/lib/model";
import { pluginsPage } from "@/lib/plugin-views";
import { secretKey } from "@/lib/plugins/secrets";
import { requireUser } from "@/lib/session";

export default async function PluginSettingsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const d = await db();
  const [p] = await d.query("select 1 from projects where key = $1", [key]);
  if (!p) notFound();
  const page = await pluginsPage(d, key);
  return (
    <div className="settings plugins-settings">
      <SettingsTabs projectKey={key} current="plugins" />
      <PluginsSettings projectKey={key} page={JSON.parse(JSON.stringify(page))} statuses={STATUSES}
                       ownersUnset={page.ownersSet ? null : OWNERS_UNSET} secretKeySet={!!secretKey()} />
    </div>
  );
}
