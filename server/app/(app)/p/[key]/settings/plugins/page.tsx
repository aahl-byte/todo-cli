import { redirect } from "next/navigation";

/** The page's old address. */
export default async function PluginSettingsPage({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const { key } = await params;
  const { repo } = await searchParams;
  redirect(`/p/${key}/settings/automation${typeof repo === "string" ? `?repo=${encodeURIComponent(repo)}` : ""}`);
}
