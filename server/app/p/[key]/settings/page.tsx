import { notFound } from "next/navigation";
import { JiraSettingsForm } from "@/components/JiraSettingsForm";
import { db } from "@/lib/db";
import { dryRuns, loadJiraSettings } from "@/lib/jira/settings";
import { STATUSES } from "@/lib/model";
import { requireUser } from "@/lib/session";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export default async function Settings({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const d = await db();
  const s = await loadJiraSettings(d, key);
  if (!s) notFound();
  if (!s.jiraProject) return <><div className="label section">Jira</div><p className="empty">This project isn't linked to Jira.</p></>;
  const state = s.serverReadOnly ? "Writes off: this server is read-only (JIRA_READ_ONLY)."
    : s.outbound.writes ? "Writes on." : "Writes off for this project.";
  const runs = await dryRuns(d, key);
  return (
    <div className="settings">
      <div className="label section">Jira</div>
      <p className="settings-head">
        {s.jiraUrl ? <a href={s.jiraUrl} target="_blank" rel="noreferrer">{s.jiraProject} ↗</a> : s.jiraProject}
        <span className={s.serverReadOnly || !s.outbound.writes ? "tag" : "tag hot"}>{state}</span>
        {s.savedBy && <span className="hint">saved by {s.savedBy}, {when(s.savedAt!)}</span>}
        {!s.jiraStatuses && <span className="hot">Jira couldn't be reached, so its statuses aren't listed.</span>}
      </p>
      <JiraSettingsForm projectKey={key} inbound={s.inbound} outbound={s.outbound} statuses={STATUSES}
                        jiraStatuses={s.jiraStatuses} serverReadOnly={s.serverReadOnly} />
      <div className="label section">Would send</div>
      {!runs.length ? <p className="empty">Nothing yet. Calls a trigger or comment would make show here while writes are off.</p> : (
        <div className="dry-runs">
          {runs.map((r) => (
            <div className="rrow" key={r.id}>
              <span className="hint">{when(r.at)}</span>
              <span className="tag">{r.action === "transition" ? "move" : r.action}</span>
              <span className="grow">{r.action === "transition" ? `${r.key} to ${r.status}` : `on ${r.key}`}{r.title && <span className="hint"> · {r.title}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
