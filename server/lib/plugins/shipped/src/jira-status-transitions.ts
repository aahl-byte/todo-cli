// The jira-status-transitions plugin's source; scripts/build-plugin-host.mjs
// bundles it into ../jira-status-transitions.js.
type Client = { get(path: string, query?: Record<string, unknown>): Promise<any> };
interface Ctx {
  item: { jira?: string[] | string | null };
  settings: { jira_from: string; jira_to: string; from: string; to: string; note?: string };
  jira: Client;
  attach: { status(fields: Record<string, unknown>): void };
}

const PAGE = 100;

const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Jira's `2026-10-01T10:00:00.000+0000` as ISO time, or undefined. */
function isoTime(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const ms = Date.parse(t.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The issue's newest changelog entries, up to a page of them. */
async function recent(jira: Client, key: string): Promise<any[]> {
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;
  const first = await jira.get(path, { startAt: 0, maxResults: PAGE });
  const total = Number(first?.total ?? 0);
  if (total <= PAGE) return first?.values ?? [];
  return (await jira.get(path, { startAt: total - PAGE, maxResults: PAGE }))?.values ?? [];
}

export async function run({ item, settings, jira, attach }: Ctx) {
  const keys = Array.isArray(item.jira) ? item.jira : item.jira ? [item.jira] : [];
  for (const key of keys) {
    let histories: any[];
    try {
      histories = await recent(jira, key);
    } catch (e) {
      // An issue Jira can't show (deleted, moved, no permission) is left out.
      if ((e as { status?: number }).status === 404) continue;
      throw e;
    }
    const moved = histories
      .filter((h) => (h?.items ?? []).some((i: any) => i?.field === "status" && same(i.fromString, settings.jira_from) && same(i.toString, settings.jira_to)))
      .map((h) => ({ h, at: isoTime(h.created) }))
      .filter((m) => m.at)
      .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
    if (!moved) continue;
    attach.status({
      from: settings.from, to: settings.to, text: settings.note || `Jira moved ${key} from ${settings.jira_from} to ${settings.jira_to}`,
      at: moved.at, author: moved.h.author?.accountId, author_name: moved.h.author?.displayName, key: `jira:${key}:${moved.h.id}`,
    });
  }
}
